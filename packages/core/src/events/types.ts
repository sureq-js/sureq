import type { SureQError } from '../errors/base.js';
import type { StoreFormatError } from '../errors/catalog.js';
import type { SerializedError } from '../serialize/error.js';
import type { CleanableState, DeadLetterReason, JobState } from '../store/contract.js';
import type { PauseEvent } from '../queue/pause.js';
import type { JobProgress } from '../worker/progress.js';
import type { AlertEvent } from '../metrics/alerts.js';
import type { FilterContext } from '../queue/filter.js';

/** Call to remove the listener it was returned for. */
export type Unsubscribe = () => void;

/** Where a reported error came from. */
export type ErrorSource = 'store' | 'listener' | 'internal' | 'strategy';

/** Why a job ended in `failed`. */
export type FailureReason = 'attempts-exhausted' | 'unrecoverable' | 'not-retryable';

/** The pod (and worker) an event came from. Filled by cluster-wide events; absent for local events. */
export interface EventOrigin {
  /** The pod the event came from. */
  podId: string;
  /** The worker it came from, when a worker emitted it. */
  workerId?: string;
}

/** Payload of the `error` event. */
export interface ErrorEvent {
  /** The error; its `code` names it. */
  error: SureQError;
  /** Where it came from: the store, a listener, SureQ itself, or a backoff strategy. */
  source: ErrorSource;
  /** Where it happened. `event` is set for a failing listener. */
  context: { operation?: string; jobId?: string; workerId?: string; queue: string; event?: string };
  /** The pod and worker it came from; unset for this pod's own events. */
  origin?: EventOrigin;
}

/**
 * The queue events. `J` is the job snapshot type (instantiated as `Job<D, R>` by the queue),
 * `R` the result type.
 */
export interface QueueEvents<J = unknown, R = unknown> {
  /** A new job was stored. */
  added: { job: J; origin?: EventOrigin };
  /** A handler started on the job; in a batch, once per job. */
  active: { job: J; workerId: string; origin?: EventOrigin };
  /** The job completed. `removed` is true when retention deleted it at once. */
  completed: { job: J; result: R; durationMs: number; removed?: boolean; origin?: EventOrigin };
  /** The attempt failed and the job runs again at `runAt` (store time). */
  retrying: { job: J; error: SerializedError; delayMs: number; runAt: number; origin?: EventOrigin };
  /** The job failed for good; `reason` says why. */
  failed: { job: J; error: SerializedError; reason: FailureReason; removed?: boolean; origin?: EventOrigin };
  /** A job that failed for good was kept as a dead letter; once per job, right after its `failed` event. */
  deadLettered: { job: J; reason: DeadLetterReason; origin?: EventOrigin };
  /** This queue object moved a failed job back to waiting or delayed; `viaDeadLetter` is false for a plain failed job. */
  redriven: { id: string; state: 'waiting' | 'delayed'; viaDeadLetter: boolean; origin?: EventOrigin };
  /** This queue object's `clean` removed jobs of one state; once per call. */
  cleaned: { state: CleanableState; removed: number; origin?: EventOrigin };
  /** This queue object's `obliterate` finished deleting the queue. */
  obliterated: { removed: number; origin?: EventOrigin };
  /** No job is left waiting, delayed or running. */
  drained: { queue: string; origin?: EventOrigin };
  /** The worker lost a job's lease (a rejected renew or finalising write, or the local deadline passed); its outcome is discarded. */
  leaseLost: { job: J; token: number; reason: 'expired' | 'superseded' | 'not-active'; origin?: EventOrigin };
  /** A job was cancelled by this queue's `cancel`, once the store confirmed; not emitted when it had already ended. */
  cancelled: { job: J; previousState: 'waiting' | 'delayed' | 'active'; origin?: EventOrigin };
  /** A job's lease expired and the sweeper requeued it, or failed it when no attempts or crashes were left. */
  stalled: { job: J; previousWorkerId: string; crashCount: number; action: 'requeued' | 'failed'; origin?: EventOrigin };
  /** The store became unreachable; emitted once per outage on every queue sharing the store object. */
  storeDisconnected: { error: Error };
  /** A probe reached the store again after `attempts` probes and `downForMs` of outage. */
  storeReconnected: { downForMs: number; attempts: number };
  /** A problem that is not a job failure, such as a store error or a failing listener. */
  error: ErrorEvent;
  /** An add met a job already holding its id or singleton key; `id` is that job's id. */
  duplicate: { id: string; action: 'ignored' | 'replaced' | 'merged' | 'rejected'; existingState: JobState; by: 'id' | 'singletonKey'; origin?: EventOrigin };
  /** The queue's `filter` rejected an add; `id` is the caller's id, `null` when core would have generated it. Nothing was stored. */
  rejected: { id: string | null; reason: string; reasonCode?: string; operation: FilterContext['operation']; origin?: EventOrigin };
  /** `close()` began: no new work is taken. A worker's payload has its `workerId`; not relayed to the queue. */
  closing: { queue: string; workerId?: string };
  /** `close()` finished: every lease is released or given up, the timers are stopped. */
  closed: { queue: string; workerId?: string };
  /** Paused: `local` on the worker only; `global` on the queue and each of its workers in this pod. Emitted once per change; `isPaused()` already shows it. */
  paused: PauseEvent;
  /** Resumed; the same rules as `paused`. */
  resumed: PauseEvent;
  /** A `ctx.progress` value was stored (at most once per `progressInterval` per job); `progress` is what `getJob` now shows. */
  progress: { job: J; progress: JobProgress; origin?: EventOrigin };
  /** The store namespace moved to a format this pod cannot read: it stops claiming and sweeping and lets active jobs finish. */
  degraded: { error: StoreFormatError };
  /** Live workers run a release that is not adjacent to this pod's; a warning only, nothing is blocked. */
  versionSkew: { workers: { workerId: string; sureqVersion: string }[] };
  /** This queue object paused a schedule, once the store confirmed; not emitted when it was already paused. */
  schedulePaused: { key: string };
  /** This queue object resumed a schedule; not emitted when it was not paused. */
  scheduleResumed: { key: string };
  /** This queue object deleted a schedule; not emitted when there was none. */
  scheduleDeleted: { key: string };
  /** This pod's scheduler fired a tick: the store inserted (or already held) job `jobId`. */
  scheduleFired: { key: string; scheduledFor: number; jobId: string };
  /** This pod's scheduler dropped a tick: the previous run was unfinished (`'overlap'`) or the backlog was full. */
  scheduleSkipped: { key: string; scheduledFor: number; reason: 'overlap' | 'backlog-full' };
  /** This pod's scheduler put a tick in the backlog under overlap `'queue'`. */
  scheduleQueued: { key: string; scheduledFor: number };
  /** One of this pod's alert rules started firing or resolved; edge-triggered, once per change. */
  alert: AlertEvent;
}

/** Workers emit every queue event except `added`, `duplicate`, `rejected`, `cancelled`, `stalled`, `redriven`, `cleaned`, `obliterated`, the store connection events, `degraded`, `versionSkew`, the schedule events and `alert`. */
export type WorkerEvents<J = unknown, R = unknown> = Omit<
  QueueEvents<J, R>,
  'added' | 'duplicate' | 'rejected' | 'cancelled' | 'stalled' | 'redriven' | 'cleaned' | 'obliterated' | 'storeDisconnected' | 'storeReconnected' | 'degraded' | 'versionSkew' | 'schedulePaused' | 'scheduleResumed' | 'scheduleDeleted'
  | 'scheduleFired' | 'scheduleSkipped' | 'scheduleQueued' | 'alert'
>;

export const QUEUE_EVENT_NAMES = [
  'added', 'active', 'completed', 'retrying', 'failed', 'drained', 'leaseLost', 'stalled', 'storeDisconnected', 'storeReconnected', 'error',
  'duplicate', 'closing', 'closed', 'paused', 'resumed', 'cancelled', 'rejected', 'progress', 'degraded', 'versionSkew', 'schedulePaused',
  'scheduleResumed', 'scheduleDeleted', 'scheduleFired', 'scheduleSkipped', 'scheduleQueued', 'deadLettered', 'redriven', 'alert', 'cleaned',
  'obliterated',
] as const;
export const WORKER_EVENT_NAMES = ['active', 'completed', 'retrying', 'failed', 'deadLettered', 'drained', 'leaseLost', 'error', 'closing', 'closed', 'paused', 'resumed', 'progress'] as const;
