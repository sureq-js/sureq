// Every runtime name exported from '@sureq/core'. Each task that exports a name appends it here;
// the release gate asserts the list is complete.
export const PUBLIC_NAMES: string[] = [
  // errors
  'SureQError', 'isSureQError', 'errorCatalogue', 'InvalidOptionError', 'SerializationError', 'DeserializationError',
  'PayloadTooLargeError', 'ResultTooLargeError', 'InvalidJobStateError', 'QueueClosedError', 'WorkerClosedError',
  'UnrecoverableError', 'BackoffStrategyError', 'RetryIfError', 'StoreError', 'StoreUnavailableError', 'isStoreError',
  'ListenerError', 'StoreFormatError', 'DuplicateHandlerError', 'BulkAddError', 'InternalError',
  // errors (store contract and worker safety)
  'StoreRequestError', 'StoreContractVersionError', 'StoreNotReadyError', 'CapabilityError', 'LeaseLostError', 'JobTimeoutError', 'JobCancelledError', 'ShutdownError', 'StalledJobError', 'PoisonPillError', 'DuplicateJobError', 'MergeConflictError', 'InvalidMergeResultError', 'JobNotFoundError',
  // errors (filter, batch, schedule and admin)
  'JobRejectedError', 'FilterError', 'AlreadySettledError', 'BatchResultMismatchError', 'ScheduleNotFoundError',
  'ScheduleConflictError', 'QueueObliteratingError', 'QueueNotIdleError',
  // errors (runtime)
  'UnsupportedRuntimeError',
  // error serialization
  'serializeError', 'deserializeError',
  // logger
  'consoleLogger', 'pinoLogger',
  // queue
  'Queue', 'Producer',
  // store contract
  'STORE_CONTRACT_VERSION', 'SUPPORTED_CONTRACT_VERSIONS', 'defineCapabilities',
  // memory store, unrecoverable brand check
  'MemoryStore', 'isUnrecoverable',
  // batches
  'TaskFailure',
  // metrics
  'describeMetrics',
];

/** Every runtime name exported from '@sureq/core/producer'. */
export const PRODUCER_NAMES: string[] = [
  'Producer',
  ...PUBLIC_NAMES.slice(PUBLIC_NAMES.indexOf('SureQError'), PUBLIC_NAMES.indexOf('deserializeError') + 1),
  'describeMetrics',
];

/** Every public member of a Producer, getters included. */
export const PRODUCER_MEMBERS: string[] = [
  'add', 'addBulk', 'getJob', 'getJobs', 'getCounts', 'getAttempts', 'getDeadLetters', 'countDeadLetters', 'getWorkers', 'metrics',
  'getOldestWaitingAge', 'cancel', 'remove', 'redrive', 'redriveAll', 'pause', 'resume', 'isPaused', 'pauseState', 'upsertSchedule',
  'getSchedule', 'listSchedules', 'pauseSchedule', 'resumeSchedule', 'deleteSchedule', 'nextRuns', 'clean', 'drain', 'obliterate',
  'previewSchedule', 'ready', 'close', 'health', 'getStoreTime', 'on', 'once', 'off', 'name', 'namespace', 'closed', 'connectionState',
  'formatVersion',
];
