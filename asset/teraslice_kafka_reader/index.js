'use strict';

const Promise = require('bluebird');
const _ = require('lodash');

const KAFKA_NO_OFFSET_STORED = -168;

function newReader(context, opConfig) {
    const events = context.foundation.getEventEmitter();
    const jobLogger = context.logger;

    // We keep track of consecutive 0 record slices in order to defend against
    // the consumer failing to read data.
    let watchdogCount = 0;

    function createConsumer() {
        return context.foundation.getConnection({
            type: 'kafka',
            endpoint: opConfig.connection,
            options: {
                type: 'consumer',
                group: opConfig.group
            },
            topic_options: {
                'auto.offset.reset': opConfig.offset_reset
            },
            rdkafka_options: {
                // We want to explicitly manage offset commits.
                'enable.auto.commit': false,
                'enable.auto.offset.store': false,
                'queued.min.messages': 2 * opConfig.size
            }
        }).client;
    }

    let consumer = createConsumer();

    return new Promise(((resolve) => {
        let shuttingdown = false;
        let readyToProcess = false;

        let rollbackOffsets = {};

        function initializeConsumer() {
            consumer.on('ready', () => {
                jobLogger.info('Consumer ready');
                consumer.subscribe([opConfig.topic]);

                // for debug logs.
                consumer.on('event.log', (event) => {
                    jobLogger.info(event);
                });

                readyToProcess = true;

                resolve(processSlice);
            });
        }

        function watchdog(logger) {
            // watchdog function to reinitialize the consumer if it appears to
            // be stuck. This is an attempt to defend against an issue in librdkafka
            // where random consumers simply stop reading data.
            if (opConfig.watchdog_count > 0 && watchdogCount > opConfig.watchdog_count) {
                readyToProcess = false;
                logger.error('Watchdog triggered. Worker has stopped receiving data. Reinitializing the consumer.');
                consumer.disconnect();
                consumer = createConsumer();
                initializeConsumer();
                watchdogCount = 0;
            }
        }

        initializeConsumer();

        function processSlice(data, logger) {
            watchdog(logger);

            return new Promise(((resolveSlice, reject) => {
                const slice = [];
                const iterationStart = Date.now();
                const consuming = setInterval(consume, opConfig.interval);

                const startingOffsets = {};
                const endingOffsets = {};

                // Listeners are registered on each slice and cleared at the end.
                function clearPrimaryListeners() {
                    clearInterval(consuming);
                    // consumer.removeListener('data', receiveData);
                    consumer.removeListener('error', error);
                    events.removeListener('worker:shutdown', shutdown);
                }

                function clearSliceListeners() {
                    // These can't be called in clearPrimaryListners as they
                    // must exist after processing of the slice is complete.
                    events.removeListener('slice:success', commit);
                    events.removeListener('slice:finalize', finalize);

                    // This can be registared to different functions depending
                    // on configuration.
                    events.removeListener('slice:retry', rollback);
                    events.removeListener('slice:retry', commit);
                }

                // Called when the job is shutting down but this occurs before
                // slice:success is called so we need to tell the handler we're
                // shuttingdown.
                function shutdown() {
                    completeSlice();
                    shuttingdown = true;
                }

                // Called when slice processing is completed.
                function completeSlice() {
                    clearPrimaryListeners();
                    logger.info(`Resolving with ${slice.length} results`);

                    // Keep track of consecutive 0 record slices.
                    if (slice.length === 0) {
                        watchdogCount += 1;
                    } else {
                        watchdogCount = 0;
                    }

                    // We keep track of where we start reading for each slice.
                    // If there is an error we'll rewind the consumer and read
                    // the slice again.
                    rollbackOffsets = startingOffsets;

                    resolveSlice(slice);
                }

                function error(err) {
                    logger.error(err);
                    clearPrimaryListeners();
                    reject(err);
                }

                function consume() {
                    // If we're blocking we don't want to complete or read
                    // data until unblocked.
                    if (!readyToProcess) return;

                    if (((Date.now() - iterationStart) > opConfig.wait) ||
                        (slice.length >= opConfig.size)) {
                        completeSlice();
                    } else {
                        // We only want one consume call active at any given time
                        readyToProcess = false;

                        // Our goal is to get up to opConfig.size messages but
                        // we may get less on each call.
                        consumer.consume(opConfig.size - slice.length, (err, messages) => {
                            if (err) {
                                // logger.error(err);
                                reject(err);
                                return;
                            }

                            messages.forEach((message) => {
                                // We want to track the first offset we receive so
                                // we can rewind if there is an error.
                                if (!startingOffsets[message.partition]) {
                                    startingOffsets[message.partition] = message.offset;
                                }

                                // We record the last offset we see for each
                                // partition so that if the slice is successfull
                                // they can be committed.
                                endingOffsets[message.partition] = message.offset + 1;

                                slice.push(message.value);
                            });

                            if (slice.length >= opConfig.size) {
                                completeSlice();
                            } else {
                                readyToProcess = true;
                            }
                        });
                    }
                }

                // We only want to move offsets if the slice is successful.
                function commit() {
                    readyToProcess = false;
                    clearSliceListeners();

                    try {
                        // Ideally we'd use commitSync here but it seems to throw
                        // an exception everytime it's called.
                        _.forOwn(endingOffsets, (offset, partition) => {
                            consumer.commitSync({
                                partition: parseInt(partition, 10),
                                offset,
                                topic: opConfig.topic
                            });
                        });
                    } catch (err) {
                        // If this is the first slice and the slice is Empty
                        // there may be no offsets stored which is not really
                        // an error.
                        if (err.code !== KAFKA_NO_OFFSET_STORED) {
                            logger.error(`Kafka reader error after slice resolution ${err}`);
                        }
                    }

                    if (shuttingdown) {
                        consumer.disconnect();
                    } else {
                        readyToProcess = true;
                    }
                }

                // If processing the slice fails we need to roll back to the
                // previous state.
                function rollback() {
                    readyToProcess = false;
                    clearSliceListeners();

                    let count = _.keys(rollbackOffsets).length;
                    if (count === 0) {
                        readyToProcess = true;
                    }

                    _.forOwn(rollbackOffsets, (offset, partition) => {
                        consumer.seek({
                            partition: parseInt(partition, 10),
                            offset,
                            topic: opConfig.topic
                        }, 1000, (err) => {
                            if (err) {
                                logger.error(err);
                            }

                            count -= 1;
                            if (count === 0) {
                                readyToProcess = true;
                            }
                        });
                    });
                }

                function finalize() {
                    clearSliceListeners();
                    readyToProcess = true;
                }

                consumer.on('error', error);

                events.on('worker:shutdown', shutdown);
                events.on('slice:success', commit);
                events.on('slice:finalize', finalize);

                if (opConfig.rollback_on_failure) {
                    events.on('slice:retry', rollback);
                } else {
                    // If we're not rolling back on failure we'll just commit
                    // as if nothing happened however this can lead to data
                    // loss. The problem comes if the failure is caused by a
                    // minor issue where every read of the data fails and this
                    // will prevent the job from moving forward. As error
                    // handling in teraslice becomes more granular this will
                    // be revisited. Turning this off is necessary in some
                    // cases but in general is a bad idea.
                    events.on('slice:retry', commit);
                }


                // Kick off initial processing.
                consume();
            }));
        }
    }));
}

function slicerQueueLength() {
    // Queue is not really needed so we just want the smallest queue size available.
    return 'QUEUE_MINIMUM_SIZE';
}

function newSlicer() {
    // The slicer actually has no work to do here.
    return Promise.resolve([() => new Promise((resolve) => {
        resolve(1);
    })]);
}

function schema() {
    return {
        topic: {
            doc: 'Name of the Kafka topic to process',
            default: '',
            format: 'required_String'
        },
        group: {
            doc: 'Name of the Kafka consumer group',
            default: '',
            format: 'required_String'
        },
        offset_reset: {
            doc: 'How offset resets should be handled when there are no valid offsets for the consumer group.',
            default: 'smallest',
            format: ['smallest', 'earliest', 'beginning', 'largest', 'latest', 'error']
        },
        size: {
            doc: 'How many records to read before a slice is considered complete.',
            default: 10000,
            format: Number
        },
        wait: {
            doc: 'How long to wait for a full chunk of data to be available. Specified in milliseconds.',
            default: 30000,
            format: Number
        },
        interval: {
            doc: 'How often to attempt to consume `size` number of records. This only comes into play if the initial consume could not get a full slice.',
            default: 50,
            format: Number
        },
        connection: {
            doc: 'The Kafka consumer connection to use.',
            default: '',
            format: 'required_String'
        },
        rollback_on_failure: {
            doc: 'Controls whether the consumer state is rolled back on failure. This will protect against data loss, however this can have an unintended side effect of blocking the job from moving if failures are minor and persistent. NOTE: This currently defaults to `false` due to the side effects of the behavior, at some point in the future it is expected this will default to `true`.',
            default: false,
            format: Boolean
        },
        watchdog_count: {
            doc: 'Number of consecutive zero record slices allowed before the consumer will automatically re-initialize. This is to guard against bugs in librdkafka.',
            default: -1,
            format: Number
        }
    };
}

module.exports = {
    newReader,
    newSlicer,
    schema,
    slicerQueueLength
};