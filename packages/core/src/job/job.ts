import { DeserializationError } from '../errors/catalog.js';
import type { Jsonify } from '../serialize/jsonify.js';
import type { SerializedError } from '../serialize/error.js';
import type { DeadLetterInfo, JobRecord, Payload, RedriveOutcome } from '../store/contract.js';
import type { RedriveOptions } from '../admin/redrive.js';
import type { JobCancelResult } from '../queue/base.js';
import type { AttemptRecord } from '../history/attempts.js';
import { checkReadable, type FormatSupport } from '../format/support.js';
import { deriveProgress, type JobProgress } from './progress.js';
import { effectiveState, type JobState } from './states.js';

/** What a Job snapshot needs from its Queue. */
export interface JobBinding {
  remove(id: string): Promise<boolean>;
  cancel(id: string): Promise<JobCancelResult>;
  /** Every attempt record of a job, oldest first. */
  getAttempts(id: string): Promise<AttemptRecord[]>;
  /** Redrive a failed job; other states throw InvalidJobStateError, an unknown id JobNotFoundError. */
  retry(id: string, seq: number, opts?: RedriveOptions): Promise<RedriveOutcome>;
  /** Inverse of the queue's serializer. */
  deserialize(serialized: string): unknown;
  /** The formats this pod reads; a record outside them is refused. */
  readonly format: FormatSupport;
}

/** Who holds an active job and until when (store time). */
export interface JobLease {
  /** The worker that holds the lease. */
  readonly owner: string;
  /** The lease's fencing token. */
  readonly token: number;
  /** When the lease runs out, in store time. */
  readonly expiresAt: number;
}

/** A read-only snapshot of a job at the time it was read. Use `queue.getJob(id)` for fresh state. */
export interface Job<D = unknown, R = unknown> {
  /** The job id. */
  readonly id: string;
  /** The job name; null for an unnamed job. */
  readonly name: string | null;
  /** The queue name. */
  readonly queue: string;
  /** The namespace. */
  readonly namespace: string;
  /** The job's state when it was read. */
  readonly state: JobState;
  /** Higher runs first. */
  readonly priority: number;
  /** Insertion order from the store; negative for `first: true` under fifo. */
  readonly seq: number;
  /** Attempts started; 0 before the first claim. */
  readonly attempt: number;
  /** Attempts allowed in total. */
  readonly maxAttempts: number;
  /** Attempts ended by lease expiry (the worker crashed or stalled). */
  readonly crashCount: number;
  /** When the job was added, in store time. */
  readonly createdAt: number;
  /** When the job may run, in store time. */
  readonly runAt: number;
  /** Store time of the latest claim. */
  readonly startedAt: number | null;
  /** When the job finished, or null. */
  readonly finishedAt: number | null;
  /** When this finished job may be deleted by retention (store time); null when no age applies. */
  readonly retainUntil: number | null;
  /** Worker that claimed the latest attempt; kept after it finishes. */
  readonly workerId: string | null;
  /** The current lease while active (in a handler, as of the last renewal); null otherwise. */
  readonly lease: JobLease | null;
  /** Fencing token of the latest claim; 0 before the first. */
  readonly token: number;
  /** The job data, as read back from JSON (see {@link Jsonify}). */
  readonly data: Jsonify<D>;
  /** The result as read back from JSON; `undefined` when no result was stored, distinct from a stored `null`. */
  readonly result: Jsonify<R> | null | undefined;
  /** The last failure, or null. */
  readonly error: SerializedError | null;
  /** The last failure: the same value as `error`, kept after a later success. */
  readonly failedReason: SerializedError | null;
  /** Set when the job failed for good and is kept as a dead letter: when (store time) and why. */
  readonly deadLetter: DeadLetterInfo | null;
  /** How many times the job was redriven. */
  readonly redriveCount: number;
  /** The error of the last failed attempt before the latest redrive. */
  readonly lastError: SerializedError | null;
  /** The handler's latest reported progress in the current attempt, with its ETA; null until the first report. */
  readonly progress: JobProgress | null;
  /** The latest progress of the batch this attempt runs in; null outside a batch. */
  readonly batchProgress: JobProgress | null;
  /**
   * Pass to external APIs to make a side effect happen once per job: the add's `idempotencyKey`, else
   * `namespace:queue:id:seq`, the same on every attempt and different for a later job reusing the id.
   */
  readonly idempotencyKey: string;
  /** The schedule tick that made this job; null for a job added any other way. */
  readonly schedule: { readonly key: string; readonly scheduledFor: number } | null;
  /** `queue.remove(this.id)`: delete the job unless it is active. Resolves to whether it was deleted. */
  remove(): Promise<boolean>;
  /** `queue.cancel(this.id)`; this snapshot is not changed. */
  cancel(): Promise<JobCancelResult<Job<D, R>>>;
  /** This job's attempt records, oldest first, read fresh from the store (every page). */
  getAttempts(): Promise<AttemptRecord[]>;
  /** Move this failed job (dead letter or not) back to waiting; `queue.redrive(this.id)` with the errors of a single job. */
  retry(opts?: RedriveOptions): Promise<RedriveOutcome>;
}

const utf8 = new TextDecoder();
/** A stored payload as text: core writes strings; a store may hand back bytes. */
export const payloadText = (p: Payload): string => (typeof p === 'string' ? p : utf8.decode(p));
/** A JSON payload core wrote (`error`, `backoff`), decoded; `null` stays `null`. */
export const parsePayload = (p: Payload | null): unknown => (p === null ? null : JSON.parse(payloadText(p)));

/** A stored error of a record, decoded; unreadable JSON throws `DeserializationError` without quoting it. */
function parseStoredError(rec: JobRecord, field: 'error' | 'lastError'): SerializedError | null {
  try {
    return parsePayload(rec[field]) as SerializedError | null;
  } catch {
    throw new DeserializationError(`the stored ${field} of job "${rec.id}" cannot be deserialized`, { details: { jobId: rec.id, field } });
  }
}

/**
 * A record's stored error. The sweeper stores one poison error for every job it fails, so a
 * `POISON_PILL` error gets its `jobId` and `crashCount` from the record.
 */
export function storedError(rec: JobRecord): SerializedError | null {
  const error = parseStoredError(rec, 'error');
  if (error?.code !== 'POISON_PILL') return error;
  return { ...error, props: { ...error.props, jobId: rec.id, crashCount: rec.crashCount } };
}

/**
 * Project a stored record to the public Job. Fields are listed one by one so internal fields
 * (rev, formatVersion, backoff, lastFinal, claimId) can never leak. `liveLease`, when given, makes
 * `lease` a getter (the running handler's view, updated by each renewal).
 */
export function toJob<D = unknown, R = unknown>(rec: JobRecord, now: number, bound: JobBinding, liveLease?: () => JobLease | null): Job<D, R> {
  checkReadable(rec, bound.format);
  // The native parse error can quote the stored text, so it is not kept as the cause.
  const read = (field: string) => (text: string): unknown => {
    try {
      return bound.deserialize(text);
    } catch {
      throw new DeserializationError(`the stored ${field} of job "${rec.id}" cannot be deserialized`, { details: { jobId: rec.id, field } });
    }
  };
  const error = storedError(rec);
  const lease = rec.lease && Object.freeze({ owner: rec.lease.owner, token: rec.lease.token, expiresAt: rec.lease.expiresAt });
  const job: Job<D, R> = {
    id: rec.id,
    name: rec.name,
    queue: rec.queue,
    namespace: rec.namespace,
    state: effectiveState(rec, now),
    priority: rec.priority,
    seq: rec.seq,
    attempt: rec.attempt,
    maxAttempts: rec.maxAttempts,
    crashCount: rec.crashCount,
    createdAt: rec.createdAt,
    runAt: rec.runAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    retainUntil: rec.retainUntil,
    workerId: rec.workerId,
    lease,
    token: rec.token,
    data: read('data')(payloadText(rec.data)) as Jsonify<D>,
    result: rec.result === null ? undefined : (read('result')(payloadText(rec.result)) as Jsonify<R> | null),
    error,
    failedReason: error,
    deadLetter: rec.deadLetter && Object.freeze({ at: rec.deadLetter.at, reason: rec.deadLetter.reason }),
    redriveCount: rec.redriveCount,
    lastError: parseStoredError(rec, 'lastError'),
    progress: deriveProgress(rec.progress, rec.startedAt, bound.deserialize),
    batchProgress: deriveProgress(rec.batchProgress, rec.startedAt, bound.deserialize),
    idempotencyKey: rec.idempotencyKey ?? `${rec.namespace}:${rec.queue}:${rec.id}:${rec.seq}`,
    schedule: rec.scheduleKey === null ? null : Object.freeze({ key: rec.scheduleKey, scheduledFor: rec.scheduledFor! }),
    remove: () => bound.remove(rec.id),
    cancel: () => bound.cancel(rec.id) as Promise<JobCancelResult<Job<D, R>>>,
    getAttempts: () => bound.getAttempts(rec.id),
    retry: (opts) => bound.retry(rec.id, rec.seq, opts),
  };
  if (liveLease) Object.defineProperty(job, 'lease', { get: liveLease, enumerable: true });
  return Object.freeze(job);
}

/**
 * A claimed job for a worker. A record whose stored data, result or error cannot be deserialized
 * gives `poison` and a job with `data: null`, no result and no errors, so its attempt can be failed
 * for good without running the handler. Never throws `DeserializationError`, so it is also the safe
 * way to build an event's job from a stored record.
 */
export function toClaimedJob<D = unknown, R = unknown>(
  rec: JobRecord, now: number, bound: JobBinding, liveLease?: () => JobLease | null,
): { job: Job<D, R>; poison?: DeserializationError } {
  try {
    return { job: toJob<D, R>(rec, now, bound, liveLease) };
  } catch (e) {
    if (!(e instanceof DeserializationError)) throw e;
    const blank: JobRecord = { ...rec, data: 'null', result: null, error: null, lastError: null };
    return { job: toJob<D, R>(blank, now, bound, liveLease), poison: e };
  }
}
