import { QueueBase } from './queue/base.js';
import { resolveProducerOptions, type ProducerOptions } from './queue/options.js';

/**
 * The events a producer emits: its adds and filter rejections, its admin calls, its schedule management and the store
 * connection. Worker, sweeper, scheduler and pause events belong to a queue that runs jobs, as does `cancelled`.
 */
export type ProducerEvent =
  | 'added' | 'duplicate' | 'rejected' | 'error' | 'redriven' | 'cleaned' | 'obliterated' | 'storeDisconnected' | 'storeReconnected'
  | 'schedulePaused' | 'scheduleResumed' | 'scheduleDeleted';

/**
 * The add side of a queue for processes that never run jobs (an API server, a Lambda): add, read, control, schedule
 * management and admin calls on a shared store, with no worker, sweeper, scheduler, registry heartbeat, alerts or timer.
 * `close()` only marks it closed; the store it was given stays open.
 */
export class Producer<D = unknown, R = unknown> extends QueueBase<D, R, ProducerEvent> {
  constructor(name: string, opts: ProducerOptions<D>) {
    const resolved = resolveProducerOptions(name, opts);
    super(name, resolved, opts.store, false, 'producer');
    Object.freeze(this.hooks);
    if (opts.namespace === undefined) {
      this.shared.logger.info(`producer "${name}" uses the default namespace "default"`, { queue: name, namespace: 'default' });
    }
  }
}

export type {
  ProducerOptions, QueueOptions, TimeoutOptions, JobDefaults, MetricsOptions, ProcessSignal, ReconnectOptions, SchedulerOptions, ShutdownOptions,
} from './queue/options.js';
export type { QueueBase } from './queue/base.js';
export type { AddResult, BulkOutcome, DuplicateInfo, JobCancelResult, QueueClient } from './queue/base.js';
export { SureQError, isSureQError, errorCatalogue } from './errors/base.js';
export type { SureQErrorJSON, SureQErrorClass } from './errors/base.js';
export {
  InvalidOptionError, SerializationError, DeserializationError, PayloadTooLargeError, ResultTooLargeError, InvalidJobStateError, QueueClosedError,
  WorkerClosedError, UnrecoverableError, BackoffStrategyError, RetryIfError, StoreError, StoreUnavailableError, isStoreError, ListenerError,
  StoreFormatError, DuplicateHandlerError, BulkAddError, InternalError, StoreRequestError, StoreContractVersionError, StoreNotReadyError,
  CapabilityError, LeaseLostError, JobTimeoutError, JobCancelledError, ShutdownError, StalledJobError, PoisonPillError, DuplicateJobError,
  MergeConflictError, InvalidMergeResultError, JobNotFoundError, JobRejectedError, FilterError, AlreadySettledError, BatchResultMismatchError,
  ScheduleNotFoundError, ScheduleConflictError, QueueObliteratingError, QueueNotIdleError,
  UnsupportedRuntimeError,
} from './errors/catalog.js';
export type { ConfigIssue, ConfigIssueCode, Issue, StoreErrorOptions, FormatReason, RecordKind } from './errors/catalog.js';
export { serializeError, deserializeError } from './serialize/error.js';
export type { SerializedError, JsonValue, SerializeOptions } from './serialize/error.js';
export type { Jsonify } from './serialize/jsonify.js';
export { describeMetrics } from './metrics/catalogue.js';
export type { MetricDescriptor, MetricSample, MetricType, MetricUnit, MetricsSnapshot } from './metrics/catalogue.js';
export type { Duration } from './util/duration.js';
export type { Job, JobLease } from './job/job.js';
export type { JobState } from './job/states.js';
export type { JobProgress, ProgressObject } from './job/progress.js';
export type { AttemptPage, AttemptRecord } from './history/attempts.js';
export type { RedriveOptions, RedriveSummary } from './admin/redrive.js';
export type { AddOptions, BulkOptions, DuplicateRule } from './queue/options.js';
export type { Keep, JobKeep, RetentionOptions, RetentionPolicies } from './retention/policy.js';
export type { FilterContext, FilterFn, FilterVerdict } from './queue/filter.js';
export type { BackoffFn, BackoffSpec, StoredBackoff, Jitter } from './retry/backoff.js';
export type { QueueEvents, ErrorEvent, ErrorSource, FailureReason, Unsubscribe, EventOrigin } from './events/types.js';
export type { AlertEvent, AlertRules, AlertType } from './metrics/alerts.js';
export type { PauseEvent, PauseScope } from './queue/pause.js';
export type { WorkerState } from './worker/lifecycle.js';
export type { HealthReport, HealthWarning } from './health/health.js';
export type { WorkerInfo } from './registry/info.js';
export type { ConnectionState } from './store/client.js';
export type { Logger, LogLevel, LogFields } from './logger/logger.js';
export type { ScheduleTiming } from './scheduler/timing.js';
export type { Schedule, ScheduleDefinition, ScheduleTemplate, UpsertResult } from './scheduler/schedules.js';
export type { FormatSupport } from './format/support.js';
export type { StoreCapabilities } from './store/capabilities.js';
export type {
  Store, Scope, StoreTime, Payload, JobRecord, NewJob, AddOutcome, JobCounts, DeadLetterReason, DeadLetterInfo, CleanableState,
  RedriveOutcome, StatsResult, ScheduleRecord, OverlapPolicy, WorkerStatus, NamespaceScope, StoreMeta, StoredProgress, AttemptOutcome,
  ClaimRequest, ClaimResult, RenewRequest, RenewResult, CompleteRequest, CompleteResult, FailRequest, FailResult, ReleaseRequest,
  ReleaseResult, SweepRequest, SweepResult, CancelRequest, CancelResult, RemoveResult, UpdateRequest, UpdateResult, ListRequest,
  GetAttemptsRequest, GetAttemptsResult, CleanRequest, CleanResult, ObliterateRequest, ObliterateResult, RedriveRequest,
  SetProgressRequest, SetProgressResult, RegisterWorkerRequest, RegisterWorkerResult, HeartbeatWorkerRequest, ListWorkersResult,
  EnsureNamespaceMetaRequest, EnsureNamespaceMetaResult, PutScheduleRequest, PutScheduleResult, ListSchedulesRequest,
  ListSchedulesResult, DeleteScheduleRequest, DeleteScheduleResult, ListDueSchedulesResult, FireScheduleRequest, FireScheduleResult,
  ClaimBlocked, ClaimHistoryOption, FencedRejection, HistoryOption, NewSchedule, RetentionDirective, StoredAttempt, SweptJob, WorkerRecord,
} from './store/contract.js';
