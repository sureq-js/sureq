import { SureQError, isSureQError, registerError, type SureQErrorClass } from './base.js';
import { formatIssues } from './format-issues.js';
import type { JobState } from '../job/states.js';

/** What kind of problem a `ConfigIssue` reports. */
export type ConfigIssueCode =
  | 'invalid_type'
  | 'out_of_range'
  | 'invalid_value'
  | 'unknown_option'
  | 'missing_option'
  | 'conflict'
  | 'unsupported';

/** One problem with a user-supplied option. */
export interface ConfigIssue {
  /** The option the problem is in, such as `'retention.completed.count'` or `'groups[0]'`. */
  path: string;
  /** The kind of problem. */
  code: ConfigIssueCode;
  /** What is wrong, in words. */
  message: string;
  /** What the option accepts, when that helps. */
  expected?: string;
  /** What was passed, when that helps. */
  received?: string;
  /** The closest valid name, for a misspelt option. */
  suggestion?: string;
  /** Why a schedule timing or definition is invalid. */
  reason?: 'bad-cron' | 'bad-timezone' | 'no-occurrence' | 'bad-interval' | 'bad-overlap';
}
/** Another name for `ConfigIssue`. */
export type Issue = ConfigIssue;

/** Bad options or configuration anywhere (one error with every issue, sorted by path). */
export class InvalidOptionError extends SureQError {
  /** Always `'INVALID_OPTION'`. */
  override readonly code = 'INVALID_OPTION';
  /** Where the options were given, such as `'Queue "emails"'` or `'runStoreConformance'`. */
  readonly scope: string;
  /** Every problem found, sorted by `path`. */
  readonly issues: readonly ConfigIssue[];
  constructor(scope: string, issues: ConfigIssue[], opts: { cause?: unknown } = {}) {
    const sorted = [...issues].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    super(formatIssues(scope, sorted), { ...opts, details: { scope, issues: sorted } });
    this.scope = scope;
    this.issues = sorted;
  }
}

/** Job data, a result, progress or a schedule template has no JSON form, such as a circular reference or a `bigint`. */
export class SerializationError extends SureQError {
  /** Always `'SERIALIZATION_FAILED'`. */
  override readonly code = 'SERIALIZATION_FAILED';
}
/** A job's stored data or result is not valid JSON. Reading the job throws it; a worker fails such a job for good. */
export class DeserializationError extends SureQError {
  /** Always `'DESERIALIZATION_FAILED'`. */
  override readonly code = 'DESERIALIZATION_FAILED';
}
/** A call on a queue or producer that is closing or closed. */
export class QueueClosedError extends SureQError {
  /** Always `'QUEUE_CLOSED'`. */
  override readonly code = 'QUEUE_CLOSED';
}
/** `run`, `pause` or `resume` on a worker that is closing or closed. */
export class WorkerClosedError extends SureQError {
  /** Always `'WORKER_CLOSED'`. */
  override readonly code = 'WORKER_CLOSED';
}
/** Something SureQ did not expect happened. Report it as a bug. */
export class InternalError extends SureQError {
  /** Always `'INTERNAL_ERROR'`. */
  override readonly code = 'INTERNAL_ERROR';
}
/** `retryIf` threw or did not return a boolean. Reported through the `error` event; the job is retried. */
export class RetryIfError extends SureQError {
  /** Always `'RETRY_IF_ERROR'`. */
  override readonly code = 'RETRY_IF_ERROR';
}

/** Job data or a progress value is over the queue's size limit. */
export class PayloadTooLargeError extends SureQError {
  /** Always `'PAYLOAD_TOO_LARGE'`. */
  override readonly code = 'PAYLOAD_TOO_LARGE';
  /** The value's size, in bytes. */
  readonly size: number;
  /** The limit it went over, in bytes. */
  readonly limit: number;
  /** The queue the limit belongs to. */
  readonly queue: string;
  /** What was too large: the job's data or a progress value. */
  readonly field: 'data' | 'progress';
  constructor(opts: { size: number; limit: number; queue: string; field?: 'data' | 'progress' }) {
    const field = opts.field ?? 'data';
    const what = field === 'data' ? 'Job data' : 'Progress';
    super(`${what} is ${opts.size} bytes, over the ${opts.limit}-byte limit of queue "${opts.queue}"`, { details: { ...opts, field } });
    ({ size: this.size, limit: this.limit, queue: this.queue } = opts);
    this.field = field;
  }
}

/** A handler returned a result over `maxResultBytes`; the attempt fails with it. */
export class ResultTooLargeError extends SureQError {
  /** Always `'RESULT_TOO_LARGE'`. */
  override readonly code = 'RESULT_TOO_LARGE';
  /** The result's size, in bytes. */
  readonly size: number;
  /** The limit, `maxResultBytes`, in bytes. */
  readonly limit: number;
  /** The job whose handler returned it. */
  readonly jobId: string;
  constructor(opts: { size: number; limit: number; jobId: string }) {
    super(`Job result is ${opts.size} bytes, over the ${opts.limit}-byte limit`, { details: { ...opts } });
    ({ size: this.size, limit: this.limit, jobId: this.jobId } = opts);
  }
}

/** A call that the job's current state does not allow, such as removing an active job. */
export class InvalidJobStateError extends SureQError {
  /** Always `'INVALID_JOB_STATE'`. */
  override readonly code = 'INVALID_JOB_STATE';
  /** The job the call was about. */
  readonly jobId: string;
  /** The job's state, which does not allow the call. */
  readonly state: string;
  constructor(opts: { jobId: string; state: string }) {
    super(`Operation not allowed for a job in state "${opts.state}"`, { details: { ...opts } });
    ({ jobId: this.jobId, state: this.state } = opts);
  }
}

const UNRECOVERABLE = Symbol.for('sureq.unrecoverable');
/** Thrown by a handler to fail its job without retrying. */
export class UnrecoverableError extends SureQError {
  /** `'UNRECOVERABLE'` on this class; a subclass sets its own code. */
  override readonly code: string = 'UNRECOVERABLE';
  constructor(message = 'Unrecoverable error', options: { cause?: unknown; details?: Record<string, unknown> } = {}) {
    super(message, options);
  }
}
Object.defineProperty(UnrecoverableError.prototype, UNRECOVERABLE, { value: true });

/** A backoff strategy is unknown, threw, or returned a bad value. Reported through the `error` event; the default backoff is used. */
export class BackoffStrategyError extends SureQError {
  /** Always `'BACKOFF_STRATEGY_ERROR'`. */
  override readonly code = 'BACKOFF_STRATEGY_ERROR';
  /** `'unknown'` strategy name, the strategy `'threw'`, or it returned an `'invalid-result'`. */
  readonly reason: 'unknown' | 'threw' | 'invalid-result';
  constructor(opts: { reason: 'unknown' | 'threw' | 'invalid-result'; cause?: unknown }) {
    super(`Backoff strategy failed (${opts.reason})`, { cause: opts.cause, details: { reason: opts.reason } });
    this.reason = opts.reason;
  }
}

/** What a store adapter passes to the `StoreError` constructor. */
export interface StoreErrorOptions {
  /** The store method that failed, such as `'claim'`. */
  operation: string;
  /** Whether the same call may succeed if tried again. */
  retryable: boolean;
  /** Whether a write may have happened even though the call failed. */
  outcomeUnknown: boolean;
  /** The job the call was about, if one. */
  jobId?: string;
  /** The jobs the call was about, if several. */
  jobIds?: string[];
  /** The underlying error. */
  cause?: unknown;
  /** More facts to merge into the error's `details`. */
  details?: Record<string, unknown>;
}
/** Any failure of the store. */
export class StoreError extends SureQError {
  /** `'STORE_ERROR'` on this class; a subclass sets its own code. */
  override readonly code: string = 'STORE_ERROR';
  /** The store method that failed, such as `'claim'`. */
  readonly operation: string;
  /** Whether the same call may succeed if tried again. */
  readonly retryable: boolean;
  /** Whether a write may have happened even though the call failed. Read the job back before retrying. */
  readonly outcomeUnknown: boolean;
  /** The job the call was about, if one. */
  readonly jobId?: string;
  /** The jobs the call was about, if several. */
  readonly jobIds?: string[];
  constructor(message: string, opts: StoreErrorOptions) {
    const { cause, details, ...fields } = opts;
    super(message, { cause, details: { ...fields, ...details } });
    this.operation = opts.operation;
    this.retryable = opts.retryable;
    this.outcomeUnknown = opts.outcomeUnknown;
    if (opts.jobId !== undefined) this.jobId = opts.jobId;
    if (opts.jobIds !== undefined) this.jobIds = opts.jobIds;
  }
}
/** The store could not be reached; always retryable. */
export class StoreUnavailableError extends StoreError {
  /** Always `'STORE_UNAVAILABLE'`. */
  override readonly code = 'STORE_UNAVAILABLE';
  constructor(message: string, opts: StoreErrorOptions) {
    super(message, { ...opts, retryable: true });
  }
}

/** The store rejected a malformed request; retrying the same request cannot help. */
export class StoreRequestError extends StoreError {
  /** Always `'STORE_BAD_REQUEST'`. */
  override readonly code = 'STORE_BAD_REQUEST';
  constructor(message: string, opts: { operation: string; jobId?: string; cause?: unknown }) {
    super(message, { ...opts, retryable: false, outcomeUnknown: false });
  }
}
/** The store speaks a contract version this core does not support. */
export class StoreContractVersionError extends StoreError {
  /** Always `'STORE_CONTRACT_VERSION'`. */
  override readonly code = 'STORE_CONTRACT_VERSION';
  /** The contract versions this core accepts, lowest to highest. */
  readonly core: number[];
  /** The contract version the store declares. */
  readonly store: number;
  constructor(opts: { core: readonly number[]; store: number }) {
    const core = [...opts.core];
    super(`Store contract version ${opts.store} is not supported; this core supports ${core.join(' to ')}`, {
      operation: 'open',
      retryable: false,
      outcomeUnknown: false,
      details: { core, store: opts.store },
    });
    this.core = core;
    this.store = opts.store;
  }
}
/** The store did not become ready in time; trying again later can succeed. */
export class StoreNotReadyError extends StoreError {
  /** Always `'STORE_NOT_READY'`. */
  override readonly code = 'STORE_NOT_READY';
  constructor(message: string, opts: { timeoutMs?: number; cause?: unknown } = {}) {
    super(message, {
      operation: 'ready',
      retryable: true,
      outcomeUnknown: false,
      cause: opts.cause,
      ...(opts.timeoutMs !== undefined && { details: { timeoutMs: opts.timeoutMs } }),
    });
  }
}
const STORE_CODES = new Set(['STORE_ERROR', 'STORE_UNAVAILABLE', 'STORE_BAD_REQUEST', 'STORE_CONTRACT_VERSION', 'STORE_NOT_READY']);
/** A store failure by brand and code, so it also recognises errors from another copy of the package. */
export function isStoreError(e: unknown): e is StoreError {
  return isSureQError(e) && STORE_CODES.has((e as { code?: unknown }).code as string);
}

/** A user event listener threw; reported through the `error` event, never propagated. */
export class ListenerError extends SureQError {
  /** Always `'LISTENER_ERROR'`. */
  override readonly code = 'LISTENER_ERROR';
  /** The event whose listener threw. */
  readonly event: string;
  constructor(opts: { event: string; cause: unknown }) {
    super(`A listener for "${opts.event}" threw`, { cause: opts.cause, details: { event: opts.event } });
    this.event = opts.event;
  }
}

/** The kind of stored record a StoreFormatError is about. */
export type RecordKind = 'job' | 'attempt' | 'schedule' | 'settings' | 'meta';
/** Why a StoreFormatError was raised: the record's format is newer, older or missing. */
export type FormatReason = 'too-new' | 'too-old' | 'missing';
/** A stored record's formatVersion is newer, older or missing; for the namespace record, the store's format and this release's range. */
export class StoreFormatError extends SureQError {
  /** Always `'STORE_FORMAT_UNSUPPORTED'`. */
  override readonly code = 'STORE_FORMAT_UNSUPPORTED';
  /** Whether the format is too new, too old, or missing. */
  readonly reason: FormatReason;
  /** The format version found on the record, or `null` when it has none. */
  readonly found: number | null;
  /** The format version this release writes. */
  readonly supported: number;
  /** The kind of record. */
  readonly recordKind: RecordKind;
  /** The record's id, when it has one. */
  readonly recordId?: string;
  /** For the namespace record: the format the store is at. */
  readonly storeFormat?: number;
  /** For the namespace record: the oldest format this release reads. */
  readonly minReadable?: number;
  /** For the namespace record: the newest format this release reads. */
  readonly maxReadable?: number;
  /** For the namespace record: this release's version. */
  readonly sureqVersion?: string;
  constructor(opts: {
    reason: FormatReason; found: number | null; supported: number; recordKind: RecordKind; recordId?: string;
    storeFormat?: number; minReadable?: number; maxReadable?: number; sureqVersion?: string;
  }) {
    super(formatMessage(opts), { details: { ...opts } });
    ({ reason: this.reason, found: this.found, supported: this.supported, recordKind: this.recordKind } = opts);
    if (opts.recordId !== undefined) this.recordId = opts.recordId;
    if (opts.storeFormat !== undefined) this.storeFormat = opts.storeFormat;
    if (opts.minReadable !== undefined) this.minReadable = opts.minReadable;
    if (opts.maxReadable !== undefined) this.maxReadable = opts.maxReadable;
    if (opts.sureqVersion !== undefined) this.sureqVersion = opts.sureqVersion;
  }
}

function formatMessage(o: ConstructorParameters<typeof StoreFormatError>[0]): string {
  if (o.storeFormat !== undefined && o.reason !== 'missing') {
    const range = `SureQ ${o.sureqVersion ?? '?'} reads formats ${o.minReadable ?? '?'} to ${o.maxReadable ?? o.supported}`;
    return o.reason === 'too-new'
      ? `The store namespace is at format ${o.storeFormat}, newer than this ${range}. Deploy a newer SureQ, or run the upgrade steps.`
      : `The store namespace is at format ${o.storeFormat}, older than this ${range}. Run the upgrade steps first.`;
  }
  return o.reason === 'too-new'
    ? `Record was written by a newer SureQ (format ${String(o.found)}); this version reads up to ${o.supported}. Upgrade sureq.`
    : o.reason === 'too-old'
      ? `Record format ${String(o.found)} is too old for this SureQ (no reader for it; current format ${o.supported}).`
      : `Stored ${o.recordKind} record has no valid formatVersion.`;
}

/** `process` with a handler for a job name that another running worker of this queue already handles. */
export class DuplicateHandlerError extends SureQError {
  /** Always `'DUPLICATE_HANDLER'`. */
  override readonly code = 'DUPLICATE_HANDLER';
  /** The job name that already has a handler. */
  readonly jobName: string;
  constructor(opts: { jobName: string }) {
    super(`A handler for job name "${opts.jobName}" is already registered on this queue`, { details: { ...opts } });
    this.jobName = opts.jobName;
  }
}

/** addBulk failed as a whole; `jobIds` lets the caller check what was written. */
export class BulkAddError extends SureQError {
  /** Always `'BULK_ADD_FAILED'`. */
  override readonly code = 'BULK_ADD_FAILED';
  /** The ids of every job the call sent; read them back to see which were written. */
  readonly jobIds: string[];
  /** With `atomic: true`, the position of the input that was refused. */
  readonly index?: number;
  constructor(message: string, opts: { jobIds: string[]; index?: number; cause: unknown }) {
    super(message, { cause: opts.cause, details: { jobIds: opts.jobIds, ...(opts.index !== undefined && { index: opts.index }) } });
    this.jobIds = opts.jobIds;
    if (opts.index !== undefined) this.index = opts.index;
  }
}

/** The store does not declare a capability the operation needs. */
export class CapabilityError extends SureQError {
  /** Always `'UNSUPPORTED_CAPABILITY'`. */
  override readonly code = 'UNSUPPORTED_CAPABILITY';
  /** The capability the store does not declare, such as `'transactions'`. */
  readonly capability: string;
  constructor(capability: string, message = `Store does not support "${capability}"`) {
    super(message, { details: { capability } });
    this.capability = capability;
  }
}

/** The job's lease is gone, so this worker may no longer write to it. */
export class LeaseLostError extends SureQError {
  /** Always `'LEASE_LOST'`. */
  override readonly code = 'LEASE_LOST';
  /** The job whose lease was lost. */
  readonly jobId: string;
  /** The fencing token this worker held. */
  readonly token: number;
  /** `'expired'`, `'superseded'` by a newer claim, or the job is `'not-active'`. */
  readonly reason: 'expired' | 'superseded' | 'not-active';
  constructor(opts: { jobId: string; token: number; reason: 'expired' | 'superseded' | 'not-active' }) {
    super(`Lease for job "${opts.jobId}" was lost (${opts.reason})`, { details: { ...opts } });
    ({ jobId: this.jobId, token: this.token, reason: this.reason } = opts);
  }
}

/** A handler ran past its timeout. */
export class JobTimeoutError extends SureQError {
  /** Always `'JOB_TIMEOUT'`. */
  override readonly code = 'JOB_TIMEOUT';
  /** The job that timed out. */
  readonly jobId: string;
  /** The attempt that timed out, from 1. */
  readonly attempt: number;
  /** The job's timeout, in ms. */
  readonly timeoutMs: number;
  /** How long the handler had after the abort before the attempt was failed, in ms. */
  readonly graceMs: number;
  /** True when the handler did not stop within the grace period and the attempt was failed without it. */
  readonly abandoned: boolean;
  constructor(opts: { jobId: string; attempt: number; timeoutMs: number; graceMs: number; abandoned: boolean }, extra: { cause?: unknown } = {}) {
    super(`Job "${opts.jobId}" timed out after ${opts.timeoutMs} ms`, { details: { ...opts }, ...('cause' in extra && { cause: extra.cause }) });
    ({ jobId: this.jobId, attempt: this.attempt, timeoutMs: this.timeoutMs, graceMs: this.graceMs, abandoned: this.abandoned } = opts);
  }
}

/** A running job was cancelled. */
export class JobCancelledError extends SureQError {
  /** Always `'JOB_CANCELLED'`. */
  override readonly code = 'JOB_CANCELLED';
  /** The job that was cancelled. */
  readonly jobId: string;
  constructor(opts: { jobId: string }) {
    super(`Job "${opts.jobId}" was cancelled`, { details: { ...opts } });
    this.jobId = opts.jobId;
  }
}

/** The worker is shutting down. */
export class ShutdownError extends SureQError {
  /** Always `'SHUTDOWN'`. */
  override readonly code = 'SHUTDOWN';
  constructor(message = 'Worker is shutting down') {
    super(message);
  }
}

/** A job's lease expired and it has no attempts left. */
export class StalledJobError extends SureQError {
  /** Always `'JOB_STALLED'`. */
  override readonly code = 'JOB_STALLED';
  constructor(message = 'Job stalled: its lease expired and no attempts are left') {
    super(message);
  }
}

/** A job kept crashing its worker and is failed without further retries. */
export class PoisonPillError extends UnrecoverableError {
  /** Always `'POISON_PILL'`. */
  override readonly code = 'POISON_PILL';
  /** The job that kept crashing its worker. */
  readonly jobId: string;
  /** How many times its lease expired while running. */
  readonly crashCount: number;
  /** The limit it reached. */
  readonly maxCrashes: number;
  constructor(opts: { jobId: string; crashCount: number; maxCrashes: number }) {
    super(`Job "${opts.jobId}" crashed its worker ${opts.crashCount} times (limit ${opts.maxCrashes})`, { details: { ...opts } });
    ({ jobId: this.jobId, crashCount: this.crashCount, maxCrashes: this.maxCrashes } = opts);
  }
}

/** An add collided with an existing job. */
export class DuplicateJobError extends SureQError {
  /** Always `'DUPLICATE_JOB'`. */
  override readonly code = 'DUPLICATE_JOB';
  /** The id of the job that already exists. */
  readonly jobId: string;
  /** The state of the existing job. */
  readonly existingState: JobState;
  /** What matched: the job `'id'` or its `'singletonKey'`. */
  readonly by: 'id' | 'singletonKey';
  /** `superseded`: a redrive named a dead letter whose id another job took since. */
  readonly reason?: 'superseded';
  constructor(opts: { jobId: string; existingState: JobState; by: 'id' | 'singletonKey'; reason?: 'superseded' }) {
    super(`A job matching "${opts.jobId}" already exists (${opts.existingState}, by ${opts.by})`, { details: { ...opts } });
    ({ jobId: this.jobId, existingState: this.existingState, by: this.by } = opts);
    if (opts.reason !== undefined) this.reason = opts.reason;
  }
}

/** Concurrent writers kept conflicting on one job. */
export class MergeConflictError extends SureQError {
  /** Always `'MERGE_CONFLICT'`. */
  override readonly code = 'MERGE_CONFLICT';
  /** The job that kept changing. */
  readonly jobId: string;
  constructor(opts: { jobId: string }) {
    super(`Job "${opts.jobId}" kept changing while it was being merged`, { details: { ...opts } });
    this.jobId = opts.jobId;
  }
}

/** A merge function returned something that cannot be stored; with `cause`, it threw (in an `addBulk` slot). */
export class InvalidMergeResultError extends SureQError {
  /** Always `'INVALID_MERGE_RESULT'`. */
  override readonly code = 'INVALID_MERGE_RESULT';
  /** The job being merged. */
  readonly jobId: string;
  constructor(opts: { jobId: string; cause?: unknown }) {
    const { jobId } = opts;
    const message = 'cause' in opts ? `The merge function for job "${jobId}" threw` : `The merge result for job "${jobId}" is not valid`;
    super(message, { ...('cause' in opts && { cause: opts.cause }), details: { jobId } });
    this.jobId = opts.jobId;
  }
}

/** No job has this id. */
export class JobNotFoundError extends SureQError {
  /** Always `'JOB_NOT_FOUND'`. */
  override readonly code = 'JOB_NOT_FOUND';
  /** The id that was not found. */
  readonly jobId: string;
  constructor(opts: { jobId: string }) {
    super(`Job "${opts.jobId}" was not found`, { details: { ...opts } });
    this.jobId = opts.jobId;
  }
}

/** The queue's `filter` rejected an add; the filter's own details sit under `details.details`. */
export class JobRejectedError extends SureQError {
  /** Always `'JOB_REJECTED'`. */
  override readonly code = 'JOB_REJECTED';
  /** Why the filter rejected the job, from its verdict. */
  readonly reason: string;
  /** A short code from the filter's verdict, if it gave one. */
  readonly reasonCode?: string;
  /** What was rejected: an `'add'`, a `'replace'`, a `'merge'`, or a `'schedule'` firing. */
  readonly operation: 'add' | 'replace' | 'merge' | 'schedule';
  /** The job's id, or `null` when it had none yet. */
  readonly jobId: string | null;
  constructor(opts: {
    reason: string;
    reasonCode?: string;
    /** The filter's own details, kept whole under `details.details`. */
    details?: unknown;
    operation: 'add' | 'replace' | 'merge' | 'schedule';
    jobId: string | null;
  }) {
    const subject = opts.jobId === null ? 'A job' : `Job "${opts.jobId}"`;
    super(`${subject} was rejected by the queue filter (${opts.operation})`, { details: { ...opts } });
    ({ reason: this.reason, operation: this.operation, jobId: this.jobId } = opts);
    if (opts.reasonCode !== undefined) this.reasonCode = opts.reasonCode;
  }
}

/** The queue's `filter` itself threw or timed out. */
export class FilterError extends SureQError {
  /** Always `'FILTER_ERROR'`. */
  override readonly code = 'FILTER_ERROR';
  /** True when the filter ran past `filterTimeoutMs`; false when it threw or returned something that is not a verdict. */
  readonly timedOut: boolean;
  constructor(opts: { timedOut: boolean; cause?: unknown }) {
    super(opts.timedOut ? 'The queue filter timed out' : 'The queue filter threw', {
      ...('cause' in opts && { cause: opts.cause }),
      details: { timedOut: opts.timedOut },
    });
    this.timedOut = opts.timedOut;
  }
}

/** A batch job was completed or failed a second time; the first outcome stands. */
export class AlreadySettledError extends SureQError {
  /** Always `'ALREADY_SETTLED'`. */
  override readonly code = 'ALREADY_SETTLED';
  /** The batch job that was already settled. */
  readonly jobId: string;
  constructor(opts: { jobId: string }) {
    super(`Job "${opts.jobId}" was already settled`, { details: { ...opts } });
    this.jobId = opts.jobId;
  }
}

/** A batch handler returned an array whose length does not match the batch. */
export class BatchResultMismatchError extends SureQError {
  /** Always `'BATCH_RESULT_MISMATCH'`. */
  override readonly code = 'BATCH_RESULT_MISMATCH';
  /** The number of jobs in the batch. */
  readonly expected: number;
  /** The number of results the handler returned. */
  readonly got: number;
  constructor(opts: { expected: number; got: number }) {
    super(`The batch handler returned ${opts.got} result(s) for ${opts.expected} job(s)`, { details: { ...opts } });
    ({ expected: this.expected, got: this.got } = opts);
  }
}

/** No schedule has this key. */
export class ScheduleNotFoundError extends SureQError {
  /** Always `'SCHEDULE_NOT_FOUND'`. */
  override readonly code = 'SCHEDULE_NOT_FOUND';
  /** The schedule key that was not found. */
  readonly key: string;
  constructor(opts: { key: string }) {
    super(`Schedule "${opts.key}" was not found`, { details: { ...opts } });
    this.key = opts.key;
  }
}

/** A schedule kept changing while it was being written. */
export class ScheduleConflictError extends SureQError {
  /** Always `'SCHEDULE_CONFLICT'`. */
  override readonly code = 'SCHEDULE_CONFLICT';
  /** The schedule that kept changing. */
  readonly key: string;
  constructor(opts: { key: string }) {
    super(`Schedule "${opts.key}" was changed by another writer`, { details: { ...opts } });
    this.key = opts.key;
  }
}

/** The queue is being obliterated; writes are refused. */
export class QueueObliteratingError extends SureQError {
  /** Always `'QUEUE_OBLITERATING'`. */
  override readonly code = 'QUEUE_OBLITERATING';
  /** The queue being obliterated. */
  readonly queue: string;
  constructor(opts: { queue: string }) {
    super(`Queue "${opts.queue}" is being obliterated`, { details: { ...opts } });
    this.queue = opts.queue;
  }
}

/** An admin operation needs an idle queue, and this one has active jobs. */
export class QueueNotIdleError extends SureQError {
  /** Always `'QUEUE_NOT_IDLE'`. */
  override readonly code = 'QUEUE_NOT_IDLE';
  /** The queue that has active jobs. */
  readonly queue: string;
  /** How many jobs are running. */
  readonly active: number;
  constructor(opts: { queue: string; active: number }) {
    super(`Queue "${opts.queue}" has ${opts.active} active job(s); stop the workers or pass force`, { details: { ...opts } });
    ({ queue: this.queue, active: this.active } = opts);
  }
}

/** SureQ cannot run on this JavaScript runtime. */
export class UnsupportedRuntimeError extends SureQError {
  /** Always `'UNSUPPORTED_RUNTIME'`. */
  override readonly code = 'UNSUPPORTED_RUNTIME';
  constructor(message = 'SureQ requires Node.js; this runtime is not supported') {
    super(message);
  }
}

const CATALOGUE: Array<[SureQErrorClass, string]> = [
  [SureQError, 'SUREQ_ERROR'],
  [InvalidOptionError, 'INVALID_OPTION'],
  [SerializationError, 'SERIALIZATION_FAILED'],
  [DeserializationError, 'DESERIALIZATION_FAILED'],
  [PayloadTooLargeError, 'PAYLOAD_TOO_LARGE'],
  [ResultTooLargeError, 'RESULT_TOO_LARGE'],
  [InvalidJobStateError, 'INVALID_JOB_STATE'],
  [QueueClosedError, 'QUEUE_CLOSED'],
  [WorkerClosedError, 'WORKER_CLOSED'],
  [UnrecoverableError, 'UNRECOVERABLE'],
  [BackoffStrategyError, 'BACKOFF_STRATEGY_ERROR'],
  [RetryIfError, 'RETRY_IF_ERROR'],
  [StoreError, 'STORE_ERROR'],
  [StoreUnavailableError, 'STORE_UNAVAILABLE'],
  [ListenerError, 'LISTENER_ERROR'],
  [StoreFormatError, 'STORE_FORMAT_UNSUPPORTED'],
  [DuplicateHandlerError, 'DUPLICATE_HANDLER'],
  [BulkAddError, 'BULK_ADD_FAILED'],
  [InternalError, 'INTERNAL_ERROR'],
  [StoreRequestError, 'STORE_BAD_REQUEST'],
  [StoreContractVersionError, 'STORE_CONTRACT_VERSION'],
  [StoreNotReadyError, 'STORE_NOT_READY'],
  [CapabilityError, 'UNSUPPORTED_CAPABILITY'],
  [LeaseLostError, 'LEASE_LOST'],
  [JobTimeoutError, 'JOB_TIMEOUT'],
  [JobCancelledError, 'JOB_CANCELLED'],
  [ShutdownError, 'SHUTDOWN'],
  [StalledJobError, 'JOB_STALLED'],
  [PoisonPillError, 'POISON_PILL'],
  [DuplicateJobError, 'DUPLICATE_JOB'],
  [MergeConflictError, 'MERGE_CONFLICT'],
  [InvalidMergeResultError, 'INVALID_MERGE_RESULT'],
  [JobNotFoundError, 'JOB_NOT_FOUND'],
  [JobRejectedError, 'JOB_REJECTED'],
  [FilterError, 'FILTER_ERROR'],
  [AlreadySettledError, 'ALREADY_SETTLED'],
  [BatchResultMismatchError, 'BATCH_RESULT_MISMATCH'],
  [ScheduleNotFoundError, 'SCHEDULE_NOT_FOUND'],
  [ScheduleConflictError, 'SCHEDULE_CONFLICT'],
  [QueueObliteratingError, 'QUEUE_OBLITERATING'],
  [QueueNotIdleError, 'QUEUE_NOT_IDLE'],
  [UnsupportedRuntimeError, 'UNSUPPORTED_RUNTIME'],
];
for (const [cls, code] of CATALOGUE) registerError(cls, code);
