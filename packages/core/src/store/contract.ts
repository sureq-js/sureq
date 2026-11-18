// store contract
import type { StoreCapabilities } from './capabilities.js';

/**
 * The contract version this core speaks. Typed `number` so a later version is not a type change.
 * @beta
 */
export const STORE_CONTRACT_VERSION: number = 1;
/**
 * The inclusive range `[lowest, highest]` of store contract versions this core accepts.
 * @beta
 */
export const SUPPORTED_CONTRACT_VERSIONS: readonly [number, number] = Object.freeze([1, 1] as const);

/**
 * The six job states.
 * @public
 */
export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'cancelled';
/**
 * An instant as integer epoch milliseconds, read from the store's clock.
 * @beta
 */
export type StoreTime = number;
/**
 * Opaque job data, result or error bytes.
 * @beta
 */
export type Payload = string | Uint8Array;
/**
 * Where a job lives: one namespace and one queue.
 * @beta
 */
export interface Scope {
  /**
  * Isolates apps or environments sharing one backend; set by the queue's `namespace` option.
  * @beta
  */
  namespace: string;
  /**
  * The queue name.
  * @beta
  */
  queue: string;
}
/**
 * A namespace without a queue, for namespace-wide records.
 * @beta
 */
export type NamespaceScope = Pick<Scope, 'namespace'>;

/**
 * The operations core needs from a store.
 *
 * Superseded records: when an add reuses the id of a finished job that no longer holds it, the finished record moves
 * to the history key `id#seq`, and reads (`get`, `list`, `counts`, `claim`) no longer see it; only `getAttempts` reads
 * it by that key. A new job's id never ends in `#` and digits. The one exception is a superseded dead letter (a failed
 * record with a `deadLetter` marker): it is a dead letter still. `stats.deadLetters` counts it and `list` with the
 * `deadLetter` filter returns it under its history key; `redrive` by that key answers `duplicate-id` and never moves
 * it over the live job, and the filter form of `redrive` passes it by. Deleting the live job, `keepLast` and `retainExpired`
 * never delete it: only `obliterate`, `remove` by its history key or an age-mode `clean` of `failed` does.
  * @beta
 */
export interface Store {
  /**
  * The contract version this store implements; set it to `STORE_CONTRACT_VERSION`.
  * @beta
  */
  readonly contractVersion: number;
  /**
  * What the store can do, built with `defineCapabilities` and deeply frozen.
  * @beta
  */
  readonly capabilities: StoreCapabilities;
  /**
  * Connect and check the schema. Calls before `open` throw `StoreRequestError`.
  * @beta
  */
  open(): Promise<void>;
  /**
  * Stop serving calls. Calls after `close` throw `StoreRequestError`; closing twice is harmless.
  * @beta
  */
  close(): Promise<void>;
  /**
  * The store's current time.
  * @beta
  */
  now(): Promise<StoreTime>;
  /**
  * Insert jobs in input order under the duplicate rules. With `atomic: true`, one refused input writes nothing (needs `transactions`).
  * @beta
  */
  add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]>;
  /**
  * Atomically lease up to `limit` due jobs to one worker, best first.
  * @beta
  */
  claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult>;
  /**
  * Extend a lease if the caller's token still holds it.
  * @beta
  */
  renew(scope: Scope, req: RenewRequest): Promise<RenewResult>;
  /**
  * Finish an active job with its result, fenced by its token.
  * @beta
  */
  complete(scope: Scope, req: CompleteRequest): Promise<CompleteResult>;
  /**
  * Record a failed attempt: retry later or fail for good, fenced by its token.
  * @beta
  */
  fail(scope: Scope, req: FailRequest): Promise<FailResult>;
  /**
  * Give a claimed job back without finishing it, fenced by its token.
  * @beta
  */
  release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult>;
  /**
  * Find expired leases, count a crash, and requeue or fail each job.
  * @beta
  */
  sweep(scope: Scope, req: SweepRequest): Promise<SweepResult>;
  /**
  * Cancel a job that has not finished.
  * @beta
  */
  cancel(scope: Scope, req: CancelRequest): Promise<CancelResult>;
  /**
  * Delete a job that is not active.
  * @beta
  */
  remove(scope: Scope, req: { id: string }): Promise<RemoveResult>;
  /**
  * Edit a waiting or delayed job, guarded by its revision.
  * @beta
  */
  update(scope: Scope, req: UpdateRequest): Promise<UpdateResult>;
  /**
  * One job by id, or null.
  * @beta
  */
  get(scope: Scope, id: string): Promise<JobRecord | null>;
  /**
  * One page of jobs in one state.
  * @beta
  */
  list(scope: Scope, req: ListRequest): Promise<JobRecord[]>;
  /**
  * Jobs per state, plus `blocked`.
  * @beta
  */
  counts(scope: Scope): Promise<JobCounts>;
  /**
  * Set or clear the queue's pause flag; `changed` is false when it already had that value.
  * @beta
  */
  setPaused(scope: Scope, paused: boolean): Promise<{ changed: boolean }>;
  /**
  * Read the pause flag. `claim` must honour the same flag.
  * @beta
  */
  isPaused(scope: Scope): Promise<boolean>;
  /**
  * Job counts, the oldest waiting job's due time and the dead-letter count in one read; the request is `{}`.
  * @beta
  */
  stats(scope: Scope, req: Record<string, never>): Promise<StatsResult>;
  /**
  * One page of a job's attempt records, oldest first.
  * @beta
  */
  getAttempts(scope: Scope, req: GetAttemptsRequest): Promise<GetAttemptsResult>;
  /**
   * Delete up to `limit` jobs in one state that match the request, each with its attempt records. A deleted job also takes
   * the superseded records of its id (`id#seq`, left by id reuse) that are not dead letters. `retainExpired` also matches
   * those superseded records by their own `retainUntil` (or, with `olderThanMs`, `finishedAt`), as it does live ones, and
   * counts them in `removed`; the age mode of `failed` matches superseded dead letters the same way.
   * @beta
   */
  clean(scope: Scope, req: CleanRequest): Promise<CleanResult>;
  /**
  * Delete a queue's jobs, schedules and pause flag in batches of `limit`.
  * @beta
  */
  obliterate(scope: Scope, req: ObliterateRequest): Promise<ObliterateResult>;
  /**
  * Move failed jobs back to waiting or delayed.
  * @beta
  */
  redrive(scope: Scope, req: RedriveRequest): Promise<RedriveOutcome[]>;
  /**
  * Write an active job's progress, fenced by its token.
  * @beta
  */
  setProgress(scope: Scope, req: SetProgressRequest): Promise<SetProgressResult>;
  /**
  * Create or replace a worker's registry record.
  * @beta
  */
  registerWorker(ns: NamespaceScope, req: RegisterWorkerRequest): Promise<RegisterWorkerResult>;
  /**
  * Refresh a worker's registry record; `ok: false` when it is gone.
  * @beta
  */
  heartbeatWorker(ns: NamespaceScope, req: HeartbeatWorkerRequest): Promise<{ ok: boolean }>;
  /**
  * Delete a worker's registry record.
  * @beta
  */
  unregisterWorker(ns: NamespaceScope, req: { workerId: string }): Promise<void>;
  /**
  * Worker registry records, optionally only those serving one queue.
  * @beta
  */
  listWorkers(ns: NamespaceScope, req: { queue?: string }): Promise<ListWorkersResult>;
  /**
   * Delete up to `limit` worker records not heard from for `staleIntervals` of their own heartbeat interval: each record
   * by its own `heartbeatIntervalMs`, so a worker that beats slowly is never purged by the pace of a faster one.
   * @beta
   */
  purgeWorkers(ns: NamespaceScope, req: { staleIntervals: number; limit: number }): Promise<{ removed: number }>;
  /**
  * Create the namespace's format record or raise its version, refusing a version this pod cannot read.
  * @beta
  */
  ensureNamespaceMeta(ns: NamespaceScope, req: EnsureNamespaceMetaRequest): Promise<EnsureNamespaceMetaResult>;
  /**
  * The namespace's format record, or null when none exists.
  * @beta
  */
  getNamespaceMeta(ns: NamespaceScope): Promise<StoreMeta | null>;
  /**
  * Create or replace a schedule, guarded by its revision.
  * @beta
  */
  putSchedule(scope: Scope, req: PutScheduleRequest): Promise<PutScheduleResult>;
  /**
  * One schedule by key, or null.
  * @beta
  */
  getSchedule(scope: Scope, req: { key: string }): Promise<ScheduleRecord | null>;
  /**
  * One page of a queue's schedules in key order.
  * @beta
  */
  listSchedules(scope: Scope, req: ListSchedulesRequest): Promise<ListSchedulesResult>;
  /**
  * Delete a schedule, optionally guarded by its revision.
  * @beta
  */
  deleteSchedule(scope: Scope, req: DeleteScheduleRequest): Promise<DeleteScheduleResult>;
  /**
  * Unpaused schedules due at the store's time, earliest first.
  * @beta
  */
  listDueSchedules(scope: Scope, req: { limit: number }): Promise<ListDueSchedulesResult>;
  /**
  * Insert a schedule's job for its due tick and advance the schedule in one atomic step.
  * @beta
  */
  fireSchedule(scope: Scope, req: FireScheduleRequest): Promise<FireScheduleResult>;
  /**
  * Optional wake-up channel; resolves to an unsubscribe function.
  * @beta
  */
  subscribe?(scope: Scope, onWake: () => void): Promise<() => Promise<void>>;
}

/**
 * A stored job as the store returns it.
 * @beta
 */
export interface JobRecord {
  /**
  * The record format it was written in.
  * @beta
  */
  formatVersion: number;
  /**
  * The namespace it lives in.
  * @beta
  */
  namespace: string;
  /**
  * The queue it lives in.
  * @beta
  */
  queue: string;
  /**
  * The job id, unique in its scope.
  * @beta
  */
  id: string;
  /**
  * The job name, or null for an unnamed job.
  * @beta
  */
  name: string | null;
  /**
  * The serialized job data; opaque to the store.
  * @beta
  */
  data: Payload;
  /**
  * The data schema version given at add, or null.
  * @beta
  */
  dataVersion: number | null;
  /**
  * The job's current state.
  * @beta
  */
  state: JobState;
  /**
  * Higher runs first.
  * @beta
  */
  priority: number;
  /**
  * Insertion order in the scope: unique, never reused, and negative for a job added with `first: true`.
  * @beta
  */
  seq: number;
  /**
  * When the job is due, in store time.
  * @beta
  */
  runAt: StoreTime;
  /**
  * Attempts started so far; 0 before the first claim.
  * @beta
  */
  attempt: number;
  /**
  * Attempts allowed in total, at least 1.
  * @beta
  */
  maxAttempts: number;
  /**
  * How many times its lease expired while running.
  * @beta
  */
  crashCount: number;
  /**
  * `held` marks a lease taken for a batch that has not started its handler.
  * @beta
  */
  lease: { owner: string; token: number; expiresAt: StoreTime; claimId: string; held?: boolean } | null;
  /**
  * The last fencing token issued to this job; 0 if never claimed. Taken from a counter per scope.
  * @beta
  */
  token: number;
  /**
  * The last finishing write (token, kind, resulting state), so a repeat of it answers the same; cleared by the next claim.
  * @beta
  */
  lastFinal: { token: number; kind: 'complete' | 'fail' | 'release'; state: JobState; runAt?: StoreTime } | null;
  /**
  * The serialized handler result of a completed job, or null.
  * @beta
  */
  result: Payload | null;
  /**
  * The serialized error of the latest failed attempt, or null.
  * @beta
  */
  error: Payload | null;
  /**
  * The serialized backoff spec given at add, opaque to the store; null for the queue default.
  * @beta
  */
  backoff: Payload | null;
  /**
  * Per-job timeout override given at add, opaque to the store like `backoff`; null when none.
  * @beta
  */
  timeout: Payload | null;
  /**
  * The key to pass to outside APIs, stable across attempts.
  * @beta
  */
  idempotencyKey: string | null;
  /**
  * The worker of the latest claim, kept after the lease ends.
  * @beta
  */
  workerId: string | null;
  /**
  * How long the id stays taken: while `pending` (not finished), or while the record is `retained`.
  * @beta
  */
  uniqueWhile: 'pending' | 'retained';
  /**
  * The singleton key given at add, or null.
  * @beta
  */
  singletonKey: string | null;
  /**
  * True while this job holds its singleton key (only while waiting or delayed); at most one holder per key.
  * @beta
  */
  singletonHeld: boolean;
  /**
  * Revision for optimistic concurrency: starts at 1 and grows by 1 on every change.
  * @beta
  */
  rev: number;
  /**
  * When the job was added, in store time.
  * @beta
  */
  createdAt: StoreTime;
  /**
  * When it was last claimed, or null.
  * @beta
  */
  startedAt: StoreTime | null;
  /**
  * When it completed, failed for good or was cancelled, or null.
  * @beta
  */
  finishedAt: StoreTime | null;
  /**
  * Set when the job failed for good and was kept as a dead letter.
  * @beta
  */
  deadLetter: DeadLetterInfo | null;
  /**
  * When a finished job may be deleted; null when retention does not apply.
  * @beta
  */
  retainUntil: StoreTime | null;
  /**
  * Opaque per-job retention override given at add.
  * @beta
  */
  keep: Payload | null;
  /**
  * The job's latest progress, or null.
  * @beta
  */
  progress: StoredProgress | null;
  /**
  * Progress of the batch this job ran in.
  * @beta
  */
  batchProgress: StoredProgress | null;
  /**
  * How many times the job was redriven.
  * @beta
  */
  redriveCount: number;
  /**
  * The error of the last failed attempt, kept across a redrive.
  * @beta
  */
  lastError: Payload | null;
  /**
  * How many attempt records were dropped by the per-job cap.
  * @beta
  */
  attemptsTruncated: number;
  /**
  * The schedule that inserted this job; null for a plain add.
  * @beta
  */
  scheduleKey: string | null;
  /**
  * The schedule tick this job was inserted for.
  * @beta
  */
  scheduledFor: StoreTime | null;
  /**
  * Who cancelled the job; null when it was not cancelled.
  * @beta
  */
  cancelReason: 'user' | null;
}

/**
 * A job to add.
 * @beta
 */
export interface NewJob {
  /**
  * The job id; core always sets one (a UUIDv7 when the user gave none).
  * @beta
  */
  id: string;
  /**
  * The job name; absent or null for an unnamed job.
  * @beta
  */
  name?: string | null;
  /**
  * The serialized job data.
  * @beta
  */
  data: Payload;
  /**
  * The data schema version, if the caller set one.
  * @beta
  */
  dataVersion?: number | null;
  /**
  * The record format to write the job in.
  * @beta
  */
  formatVersion: number;
  /**
  * Higher runs first; default 0.
  * @beta
  */
  priority?: number;
  /**
  * Put the job ahead of every other job of the same priority.
  * @beta
  */
  first?: boolean;
  /**
  * Delay from store time, in ms; never together with `runAt`.
  * @beta
  */
  delayMs?: number;
  /**
  * An absolute due time, in store time; never together with `delayMs`.
  * @beta
  */
  runAt?: StoreTime;
  /**
  * Attempts allowed in total, at least 1.
  * @beta
  */
  maxAttempts: number;
  /**
  * The serialized backoff spec, opaque to the store.
  * @beta
  */
  backoff?: Payload | null;
  /**
  * The serialized per-job timeout, opaque to the store.
  * @beta
  */
  timeout?: Payload | null;
  /**
  * The key to pass to outside APIs; the store keeps it as given.
  * @beta
  */
  idempotencyKey?: string | null;
  /**
  * How long the id stays taken; default `'pending'`.
  * @beta
  */
  uniqueWhile?: 'pending' | 'retained';
  /**
  * What to do when the id or singleton key is taken; default `'ignore'`.
  * @beta
  */
  onDuplicate?: 'ignore' | 'replace' | 'reject';
  /**
  * At most one waiting or delayed job per key in the scope.
  * @beta
  */
  singletonKey?: string | null;
  /**
  * Fields whose value core took from queue defaults or library fallbacks; `replace` leaves them alone.
  * @beta
  */
  defaulted?: ReadonlyArray<'priority' | 'maxAttempts' | 'backoff'>;
  /**
  * Opaque per-job retention override.
  * @beta
  */
  keep?: Payload | null;
}

/**
 * What happened to one job of an add call.
 * @beta
 */
export type AddOutcome =
  | { status: 'added'; job: JobRecord }
  | { status: 'duplicate'; action: 'ignored' | 'replaced' | 'rejected'; by: 'id' | 'singletonKey'; existingState: JobState; job: JobRecord }
  | { status: 'not-applied' };

/**
 * Ask the store for jobs to run.
 * @beta
 */
export interface ClaimRequest {
  /**
  * The claiming worker; becomes the lease owner.
  * @beta
  */
  workerId: string;
  /**
  * The most jobs to claim, from 1 to `capabilities.limits.maxClaimLimit`.
  * @beta
  */
  limit: number;
  /**
  * Lease length, in ms.
  * @beta
  */
  leaseMs: number;
  /**
  * Lease length per job name, overriding `leaseMs`.
  * @beta
  */
  leaseMsByName?: Record<string, number>;
  /**
  * Only jobs of these names; null matches unnamed jobs. Absent means any.
  * @beta
  */
  names?: (string | null)[];
  /**
  * Within one priority, oldest first (`'fifo'`, the default) or newest first.
  * @beta
  */
  order?: 'fifo' | 'lifo';
  /**
  * Unique per logical claim. A retry after an unknown outcome reuses it, and the store returns that claim's live jobs.
  * @beta
  */
  claimId: string;
  /**
  * Take the leases as held: the handler has not started yet.
  * @beta
  */
  hold?: boolean;
  /**
  * The attempt record to open for each claimed job; false writes none.
  * @beta
  */
  history?: ClaimHistoryOption;
  /**
  * Skip jobs written in a format newer than this.
  * @beta
  */
  maxFormat?: number;
}
/**
 * Jobs claimed, plus the store's time and the next due instant.
 * @beta
 */
export interface ClaimResult {
  /**
  * The claimed jobs, in claim order; may be fewer than `limit`.
  * @beta
  */
  jobs: JobRecord[];
  /**
  * The store's time.
  * @beta
  */
  now: StoreTime;
  /**
  * The earliest due time among delayed jobs, so an idle worker knows how long to sleep; null when none.
  * @beta
  */
  nextRunAt: StoreTime | null;
  /**
  * True when the queue is paused; same as `blocked?.reason === 'paused'`.
  * @beta
  */
  paused: boolean;
  /**
  * Present only when nothing was claimed although due jobs exist.
  * @beta
  */
  blocked?: ClaimBlocked;
  /**
  * The jobs are an earlier claim with the same `claimId`; nothing new was claimed.
  * @beta
  */
  recovered?: true;
}
/**
 * Why a claim returned nothing.
 * @beta
 */
export interface ClaimBlocked {
  /**
  * What blocks the claim.
  * @beta
  */
  reason: 'paused';
}

/**
 * A write refused because the caller no longer holds the lease.
 * @beta
 */
export type FencedRejection = { ok: false; reason: 'superseded' | 'expired' | 'not-active' };

/**
 * Extend a lease.
 * @beta
 */
export interface RenewRequest {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
  * The caller's fencing token.
  * @beta
  */
  token: number;
  /**
  * New lease length from store time, in ms.
  * @beta
  */
  leaseMs: number;
  /**
  * The handler of a held lease has started.
  * @beta
  */
  started?: boolean;
  /**
  * The batch the job runs in; only together with `started: true`.
  * @beta
  */
  batchId?: string;
}
/**
 * A renewed lease with its new expiry, or a fenced rejection.
 * @beta
 */
export type RenewResult = { ok: true; expiresAt: StoreTime; now: StoreTime } | FencedRejection;

/**
 * Finish an active job with its result.
 * @beta
 */
export interface CompleteRequest {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
  * The caller's fencing token.
  * @beta
  */
  token: number;
  /**
  * The serialized result, or null.
  * @beta
  */
  result: Payload | null;
  /**
  * How to close the attempt record; false writes none.
  * @beta
  */
  history?: HistoryOption;
  /**
  * Delete the job or set how long it is kept.
  * @beta
  */
  retention?: RetentionDirective;
}
/**
 * `ok` with store time (`repeated` for a repeat of the same write), or a fenced rejection.
 * @beta
 */
export type CompleteResult = { ok: true; now: StoreTime; repeated?: true } | FencedRejection;

/**
 * Record a failed attempt.
 * @beta
 */
export interface FailRequest {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
  * The caller's fencing token.
  * @beta
  */
  token: number;
  /**
  * The serialized error of this attempt.
  * @beta
  */
  error: Payload;
  /**
  * Retry after this delay; absent fails the job for good.
  * @beta
  */
  retryInMs?: number;
  /**
  * How to close the attempt record; false writes none.
  * @beta
  */
  history?: HistoryOption;
  /**
  * For a final failure: delete the job or set how long it is kept.
  * @beta
  */
  retention?: RetentionDirective;
  /**
  * Keep a final failure as a dead letter; an absent `reason` means `exhausted`.
  * @beta
  */
  deadLetter?: false | { reason?: Exclude<DeadLetterReason, 'crashLimit' | 'legacy'>; keepMs?: number };
}
/**
 * The state the job moved to (`delayed` for a retry, `failed` for good), or a fenced rejection.
 * @beta
 */
export type FailResult =
  | { ok: true; state: 'delayed' | 'failed'; runAt?: StoreTime; now: StoreTime; repeated?: true }
  | FencedRejection;

/**
 * Give a claimed job back without finishing it.
 * @beta
 */
export interface ReleaseRequest {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
  * The caller's fencing token.
  * @beta
  */
  token: number;
  /**
  * Absent or 0: back to `waiting` now. Above 0: `delayed` for that long.
  * @beta
  */
  delayMs?: number;
  /**
  * True when the attempt should not count, so `attempt` goes back by one.
  * @beta
  */
  refundAttempt: boolean;
  /**
  * Whether this attempt's handler started.
  * @beta
  */
  handlerStarted: boolean;
  /**
  * Why the job was given back, for the attempt record.
  * @beta
  */
  reason?: 'shutdown' | 'pause';
  /**
  * How to close the attempt record; false writes none.
  * @beta
  */
  history?: HistoryOption;
}
/**
 * The state the job moved to and when it is due, or a fenced rejection.
 * @beta
 */
export type ReleaseResult =
  | { ok: true; state: 'waiting' | 'delayed'; runAt: StoreTime; now: StoreTime; repeated?: true }
  | FencedRejection;

/**
 * Recover jobs whose lease expired.
 * @beta
 */
export interface SweepRequest {
  /**
  * The most jobs to act on, from 1 to `capabilities.limits.maxClaimLimit`.
  * @beta
  */
  limit: number;
  /**
  * Fail a job for good once its lease has expired this many times.
  * @beta
  */
  maxCrashes: number;
  /**
  * The serialized `StalledJobError` to store when a job is failed because its attempts are used up.
  * @beta
  */
  failError: Payload;
  /**
  * The serialized `PoisonPillError` to store when a job reaches `maxCrashes`; wins when both limits are hit.
  * @beta
  */
  poisonError: Payload;
  /**
  * How to close the attempt records; false writes none.
  * @beta
  */
  history?: HistoryOption;
  /**
  * For jobs the sweep fails: delete them or set how long they are kept.
  * @beta
  */
  retention?: RetentionDirective;
  /**
  * Keep jobs failed by the sweep as dead letters; the store picks the reason.
  * @beta
  */
  deadLetter?: false | { keepMs?: number };
  /**
  * Skip jobs written in a format newer than this.
  * @beta
  */
  maxFormat?: number;
}
/**
 * One job a sweep acted on.
 * @beta
 */
export interface SweptJob {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
  * The token of the expired lease.
  * @beta
  */
  token: number;
  /**
  * The worker that held the expired lease.
  * @beta
  */
  previousOwner: string;
  /**
  * Whether the job was requeued or failed for good.
  * @beta
  */
  action: 'requeued' | 'failed';
  /**
  * The job's attempt count after the sweep.
  * @beta
  */
  attempt: number;
  /**
  * The job's crash count after the sweep.
  * @beta
  */
  crashCount: number;
}
/**
 * What a sweep did.
 * @beta
 */
export interface SweepResult {
  /**
  * Every job the sweep acted on.
  * @beta
  */
  swept: SweptJob[];
  /**
  * The store's time.
  * @beta
  */
  now: StoreTime;
}

/**
 * Cancel a job that has not finished.
 * @beta
 */
export interface CancelRequest {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
   * The attempt record of an active job, as on the other writes. Absent (a caller that keeps no history settings, such
   * as a producer): close the job's open attempt record if one exists, apply no cap and insert no record.
   * @beta
   */
  history?: HistoryOption;
  /**
  * Delete the job or set how long it is kept.
  * @beta
  */
  retention?: RetentionDirective;
}
/**
 * The state the job was cancelled from, or why it could not be.
 * @beta
 */
export type CancelResult =
  | { ok: true; previousState: 'waiting' | 'delayed' | 'active' }
  | { ok: false; reason: 'not-found' | 'already-terminal'; state?: JobState };
/**
 * The state the job was removed from, or why it was not.
 * @beta
 */
export type RemoveResult =
  | { removed: true; previousState: JobState }
  | { removed: false; reason: 'not-found' | 'active' };

/**
 * Edit a waiting or delayed job, guarded by its revision.
 * @beta
 */
export interface UpdateRequest {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
  * The revision the caller read; a different one is a `conflict`.
  * @beta
  */
  expectedRev: number;
  /**
  * The fields to change.
  * @beta
  */
  patch: { data?: Payload; priority?: number; delayMs?: number; runAt?: StoreTime };
}
/**
 * The updated job, or why it was not changed.
 * @beta
 */
export type UpdateResult = { ok: true; job: JobRecord } | { ok: false; reason: 'conflict' | 'not-found' | 'not-editable' };

/**
 * Page through jobs in one state.
 * @beta
 */
export interface ListRequest {
  /**
  * The state to list.
  * @beta
  */
  state: JobState;
  /**
  * Jobs to skip.
  * @beta
  */
  offset: number;
  /**
  * The most jobs to return.
  * @beta
  */
  limit: number;
  /**
  * `deadLetterAt` requires the `deadLetter` filter; `seq` breaks ties.
  * @beta
  */
  orderBy?: 'seq' | 'runAt' | 'startedAt' | 'finishedAt' | 'deadLetterAt';
  /**
  * Sort direction; ties are broken by `seq` in the same direction, so pages are stable.
  * @beta
  */
  order: 'asc' | 'desc';
  /**
  * Only dead letters, optionally of one reason and older than `olderThanMs`.
  * @beta
  */
  deadLetter?: { reason?: DeadLetterReason; olderThanMs?: number };
  /**
  * Only jobs of this name; null means unnamed.
  * @beta
  */
  name?: string | null;
}
/**
 * Jobs per state, plus those blocked.
 * @public
 */
export type JobCounts = Record<JobState, number> & { blocked: number };

/**
 * Attempt history on a write: false writes no record; `max` caps records per job.
 * @beta
 */
export type HistoryOption = false | { max?: number };
/**
 * Attempt history on claim, which also names the host of the record it opens.
 * @beta
 */
export type ClaimHistoryOption = false | { max?: number; host?: string | null };
/**
 * At finish, delete the job or set `retainUntil` to now plus `retainMs`.
 * @beta
 */
export interface RetentionDirective {
  /**
  * Delete the job as it finishes.
  * @beta
  */
  discard?: boolean;
  /**
  * Keep the job this long after it finishes, by setting `retainUntil`.
  * @beta
  */
  retainMs?: number;
}
/**
 * Why a job became a dead letter.
 * @public
 */
export type DeadLetterReason = 'exhausted' | 'unrecoverable' | 'retryRejected' | 'crashLimit' | 'legacy';
/**
 * When and why a job became a dead letter.
 * @public
 */
export interface DeadLetterInfo {
  /**
  * When it became a dead letter, in store time.
  * @beta
  */
  at: StoreTime;
  /**
  * Why it became a dead letter.
  * @beta
  */
  reason: DeadLetterReason;
}
/**
 * States `clean` can delete from.
 * @public
 */
export type CleanableState = 'completed' | 'failed' | 'cancelled' | 'waiting' | 'delayed';
/**
 * A worker's run state in the registry.
 * @public
 */
export type WorkerStatus = 'running' | 'paused' | 'draining';
/**
 * What a schedule does when its previous job has not finished.
 * @public
 */
export type OverlapPolicy = 'skip' | 'queue' | 'allow';
/**
 * Opaque progress and when it was written.
 * @beta
 */
export interface StoredProgress {
  /**
  * The serialized progress.
  * @beta
  */
  value: Payload;
  /**
  * When it was written, in store time.
  * @beta
  */
  updatedAt: StoreTime;
}

/**
 * Counts, the oldest waiting job's due time and the dead-letter count.
 * @beta
 */
export interface StatsResult {
  /**
  * Jobs per state, plus `blocked`.
  * @beta
  */
  counts: JobCounts;
  /**
  * The due time of the oldest waiting job, or null when none waits.
  * @beta
  */
  oldestWaitingRunAt: StoreTime | null;
  /**
  * How many dead letters the queue holds.
  * @beta
  */
  deadLetters: number;
  /**
  * The store's time.
  * @beta
  */
  now: StoreTime;
}

/**
 * How an attempt ended; `running` while it is open.
 * @public
 */
export type AttemptOutcome = 'running' | 'completed' | 'failed' | 'crashed' | 'cancelled' | 'released';
/**
 * One attempt record as the store keeps it.
 * @beta
 */
export interface StoredAttempt {
  /**
  * The record format it was written in.
  * @beta
  */
  formatVersion: number;
  /**
  * The job it belongs to.
  * @beta
  */
  jobId: string;
  /**
  * The attempt number, from 1.
  * @beta
  */
  attempt: number;
  /**
  * How many times the job had been redriven when this attempt ran.
  * @beta
  */
  cycle: number;
  /**
  * The fencing token of this attempt's lease.
  * @beta
  */
  token: number;
  /**
  * The worker that ran it.
  * @beta
  */
  workerId: string;
  /**
  * The host the worker ran on, or null.
  * @beta
  */
  host: string | null;
  /**
  * When it was claimed, in store time.
  * @beta
  */
  startedAt: StoreTime;
  /**
  * When it ended, or null while it runs.
  * @beta
  */
  finishedAt: StoreTime | null;
  /**
  * How long it ran, or null while it runs.
  * @beta
  */
  durationMs: number | null;
  /**
  * How long the job waited after it was due before this claim.
  * @beta
  */
  waitMs: number;
  /**
  * The batch it ran in, or null.
  * @beta
  */
  batchId: string | null;
  /**
  * How long a batch held it before the handler started, or null.
  * @beta
  */
  heldMs: number | null;
  /**
  * How it ended; `running` while it is open.
  * @beta
  */
  outcome: AttemptOutcome;
  /**
  * The serialized error of a failed attempt, or null.
  * @beta
  */
  error: Payload | null;
  /**
  * What ended it, or null while it runs.
  * @beta
  */
  endedBy: 'worker' | 'sweeper' | 'cancel' | 'shutdown' | null;
  /**
  * Claim time, then the time of every successful renew.
  * @beta
  */
  lastRenewAt: StoreTime;
}
/**
 * Page through one job's attempt records.
 * @beta
 */
export interface GetAttemptsRequest {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
  * The most records to return.
  * @beta
  */
  limit?: number;
  /**
  * Where the previous page ended.
  * @beta
  */
  cursor?: string;
}
/**
 * One page of attempt records.
 * @beta
 */
export interface GetAttemptsResult {
  /**
  * The records, oldest first.
  * @beta
  */
  attempts: StoredAttempt[];
  /**
  * How many records the per-job cap dropped.
  * @beta
  */
  truncated: number;
  /**
  * Pass it to get the next page; null on the last page.
  * @beta
  */
  nextCursor: string | null;
}

/**
 * Delete jobs in one state, oldest first.
 * @beta
 */
export interface CleanRequest {
  /**
  * The state to delete from.
  * @beta
  */
  state: CleanableState;
  /**
  * Only jobs at least this old (finished jobs by `finishedAt`); with `retainExpired`, the age of a job with no `retainUntil`.
  * @beta
  */
  olderThanMs?: number;
  /**
  * Keep the newest N by `finishedAt` then `seq`, never counting a dead letter or a `retained` job; a finished state only.
  * @beta
  */
  keepLast?: number;
  /**
   * Only jobs whose `retainUntil` has passed, whatever their name. With `olderThanMs`, also jobs with no `retainUntil`,
   * no `keep`, no dead letter and not `retained` (a previous release finished them), by `finishedAt`, filtered by name.
   * @beta
   */
  retainExpired?: boolean;
  /**
  * Only jobs of this name; null means unnamed.
  * @beta
  */
  name?: string | null;
  /**
  * Skip jobs of these names (an unnamed job is never skipped).
  * @beta
  */
  excludeNames?: string[];
  /**
  * The most jobs to delete in this call.
  * @beta
  */
  limit: number;
}
/**
 * What a clean call deleted.
 * @beta
 */
export interface CleanResult {
  /**
  * How many jobs were deleted.
  * @beta
  */
  removed: number;
  /**
  * More jobs match than this call removed.
  * @beta
  */
  remaining: boolean;
}

/**
 * Delete a whole queue; without `force`, active jobs make it throw `QueueNotIdleError`.
 * @beta
 */
export interface ObliterateRequest {
  /**
  * Delete even while jobs are active.
  * @beta
  */
  force?: boolean;
  /**
  * Records to delete per batch.
  * @beta
  */
  limit: number;
}
/**
 * What an obliterate call deleted.
 * @beta
 */
export interface ObliterateResult {
  /**
  * How many records were deleted.
  * @beta
  */
  removed: number;
  /**
  * True once nothing of the queue is left.
  * @beta
  */
  done: boolean;
}

/**
 * Redrive failed jobs by id or by a dead-letter filter.
 * @beta
 */
export type RedriveRequest = (
  | { ids: string[]; filter?: never }
  | { filter: { reason?: DeadLetterReason; olderThanMs?: number }; ids?: never }
) & { resetAttempts?: boolean; delayMs?: number; priority?: number; limit: number };
/**
 * What happened to one job of a redrive.
 * @public
 */
export type RedriveOutcome =
  | { id: string; status: 'redriven'; state: 'waiting' | 'delayed'; viaDeadLetter: boolean }
  | { id: string; status: 'skipped'; reason: 'not-failed' | 'not-found' | 'duplicate-id' };

/**
 * Write an active job's progress.
 * @beta
 */
export interface SetProgressRequest {
  /**
  * The job.
  * @beta
  */
  id: string;
  /**
  * The caller's fencing token.
  * @beta
  */
  token: number;
  /**
  * The serialized progress.
  * @beta
  */
  progress: Payload;
  /**
  * Write the job's own `progress` (the default) or its `batchProgress`.
  * @beta
  */
  field?: 'progress' | 'batchProgress';
}
/**
 * `ok` with store time, or a fenced rejection.
 * @beta
 */
export type SetProgressResult = { ok: true; now: StoreTime } | FencedRejection;

/**
 * A worker's registry record as the worker writes it.
 * @beta
 */
export interface RegisterWorkerRequest {
  /**
  * The worker's id.
  * @beta
  */
  workerId: string;
  /**
  * The queues it serves.
  * @beta
  */
  queues: string[];
  /**
  * The job names it handles; null matches unnamed jobs. Absent means any.
  * @beta
  */
  names?: (string | null)[];
  /**
  * Its concurrency.
  * @beta
  */
  concurrency: number;
  /**
  * The SureQ version it runs.
  * @beta
  */
  sureqVersion: string;
  /**
  * The job format version the worker writes.
  * @beta
  */
  formatVersion: number;
  /**
  * How often it heartbeats, in ms; staleness is judged by this.
  * @beta
  */
  heartbeatIntervalMs: number;
  /**
  * The host it runs on.
  * @beta
  */
  host: string;
  /**
  * Its process id, or null where there is none.
  * @beta
  */
  pid: number | null;
  /**
  * Free-form labels from the worker's options.
  * @beta
  */
  labels: Record<string, string>;
  /**
  * Whether the worker's queue runs a scheduler on that pod.
  * @beta
  */
  scheduler: boolean;
}
/**
 * The registered worker's start time.
 * @beta
 */
export interface RegisterWorkerResult {
  /**
  * When the record was created, in store time.
  * @beta
  */
  startedAt: StoreTime;
  /**
  * The store's time.
  * @beta
  */
  now: StoreTime;
}
/**
 * A worker's registry record as the store returns it.
 * @beta
 */
export interface WorkerRecord extends Omit<RegisterWorkerRequest, 'names'> {
  /**
  * The job names it handles, or null for any.
  * @beta
  */
  names: (string | null)[] | null;
  /**
  * Jobs it was running at its last heartbeat.
  * @beta
  */
  activeJobs: number;
  /**
  * Its run state at its last heartbeat.
  * @beta
  */
  status: WorkerStatus;
  /**
  * When it registered, in store time.
  * @beta
  */
  startedAt: StoreTime;
  /**
  * When it last heartbeat, in store time.
  * @beta
  */
  lastHeartbeatAt: StoreTime;
}
/**
 * What a worker reports on each heartbeat.
 * @beta
 */
export interface HeartbeatWorkerRequest {
  /**
  * The worker's id.
  * @beta
  */
  workerId: string;
  /**
  * Jobs it is running now.
  * @beta
  */
  activeJobs: number;
  /**
  * Its concurrency.
  * @beta
  */
  concurrency: number;
  /**
  * Its run state.
  * @beta
  */
  status: WorkerStatus;
  /**
  * Whether its queue runs a scheduler on that pod.
  * @beta
  */
  scheduler: boolean;
}
/**
 * Worker records and the store's time, to judge staleness.
 * @beta
 */
export interface ListWorkersResult {
  /**
  * The worker records.
  * @beta
  */
  workers: WorkerRecord[];
  /**
  * The store's time.
  * @beta
  */
  now: StoreTime;
}

/**
 * The format versions this pod writes and reads.
 * @beta
 */
export interface EnsureNamespaceMetaRequest {
  /**
  * The format this pod writes.
  * @beta
  */
  current: number;
  /**
  * The oldest format this pod reads.
  * @beta
  */
  minReadable: number;
  /**
  * The newest format this pod reads.
  * @beta
  */
  maxReadable: number;
  /**
  * This pod's SureQ version, recorded on the record.
  * @beta
  */
  sureqVersion: string;
}
/**
 * The namespace's format after the call.
 * @beta
 */
export interface EnsureNamespaceMetaResult {
  /**
  * The namespace's format now.
  * @beta
  */
  formatVersion: number;
  /**
  * True when this call created the record.
  * @beta
  */
  created: boolean;
  /**
  * True when this call raised its version.
  * @beta
  */
  raised: boolean;
}
/**
 * A namespace's format record.
 * @beta
 */
export interface StoreMeta {
  /**
  * The format the namespace is at.
  * @beta
  */
  formatVersion: number;
  /**
  * The SureQ version that created the record.
  * @beta
  */
  createdBy: string;
  /**
  * The SureQ version that last raised the format.
  * @beta
  */
  lastRaisedBy: string;
  /**
  * When it last changed, in store time.
  * @beta
  */
  updatedAt: StoreTime;
}

/**
 * A stored schedule; the store never reads `template.data` or `template.opts`.
 * @beta
 */
export interface ScheduleRecord {
  /**
  * The record format it was written in.
  * @beta
  */
  formatVersion: number;
  /**
  * The namespace it lives in.
  * @beta
  */
  namespace: string;
  /**
  * The queue it fires into.
  * @beta
  */
  queue: string;
  /**
  * The schedule key, unique in its queue.
  * @beta
  */
  key: string;
  /**
  * A cron expression or a fixed interval.
  * @beta
  */
  kind: 'cron' | 'every';
  /**
  * The cron expression, for `kind: 'cron'`.
  * @beta
  */
  cron?: string;
  /**
  * The IANA time zone for `cron`.
  * @beta
  */
  tz?: string;
  /**
  * The interval in ms, for `kind: 'every'`.
  * @beta
  */
  everyMs?: number;
  /**
  * The origin of the interval grid, in store time.
  * @beta
  */
  anchorAt?: StoreTime;
  /**
  * The job each tick inserts. The store never reads its `data` or `opts`.
  * @beta
  */
  template: { name: string | null; data: Payload; opts: Record<string, unknown> };
  /**
  * What to do when the previous job has not finished.
  * @beta
  */
  overlap: OverlapPolicy;
  /**
  * The most ticks kept waiting under the `queue` overlap policy.
  * @beta
  */
  maxQueued: number;
  /**
  * Whether the schedule is paused.
  * @beta
  */
  paused: boolean;
  /**
  * The next tick, in store time.
  * @beta
  */
  nextRunAt: StoreTime;
  /**
  * The tick time of the last tick that produced a job, or null.
  * @beta
  */
  lastFiredFor: StoreTime | null;
  /**
  * The id of the last job it inserted, or null.
  * @beta
  */
  lastJobId: string | null;
  /**
  * Ticks waiting to fire under the `queue` overlap policy.
  * @beta
  */
  queuedTicks: StoreTime[];
  /**
  * How many jobs it has inserted.
  * @beta
  */
  runCount: number;
  /**
  * A hash of the timing, template and overlap, to tell whether a re-upsert changes anything.
  * @beta
  */
  definitionHash: string;
  /**
  * The `version` given with the definition; 0 when unversioned.
  * @beta
  */
  definitionVersion: number;
  /**
  * Revision for optimistic concurrency, growing by 1 on every write.
  * @beta
  */
  rev: number;
  /**
  * When it was created, in store time.
  * @beta
  */
  createdAt: StoreTime;
  /**
  * When it last changed, in store time.
  * @beta
  */
  updatedAt: StoreTime;
}
/**
 * A schedule to write; the store fills scope, revision and timestamps.
 * @beta
 */
export type NewSchedule = Omit<ScheduleRecord, 'namespace' | 'queue' | 'rev' | 'createdAt' | 'updatedAt'>;
/**
 * Write a schedule; `expectedRev: null` means it must not exist yet.
 * @beta
 */
export interface PutScheduleRequest {
  /**
  * The schedule to write.
  * @beta
  */
  schedule: NewSchedule;
  /**
  * The revision the caller read, or null to create a new schedule.
  * @beta
  */
  expectedRev: number | null;
}
/**
 * The written schedule, or why it was not written.
 * @beta
 */
export type PutScheduleResult = { ok: true; schedule: ScheduleRecord } | { ok: false; reason: 'conflict' | 'exists' };
/**
 * Page through a queue's schedules.
 * @beta
 */
export interface ListSchedulesRequest {
  /**
  * Where the previous page ended.
  * @beta
  */
  cursor?: string;
  /**
  * The most schedules to return.
  * @beta
  */
  limit: number;
}
/**
 * One page of schedules, in key order.
 * @beta
 */
export interface ListSchedulesResult {
  /**
  * The schedules.
  * @beta
  */
  schedules: ScheduleRecord[];
  /**
  * Pass it to get the next page; null on the last page.
  * @beta
  */
  nextCursor: string | null;
}
/**
 * Delete a schedule.
 * @beta
 */
export interface DeleteScheduleRequest {
  /**
  * The schedule key.
  * @beta
  */
  key: string;
  /**
  * Delete only at this revision; absent deletes whatever is there.
  * @beta
  */
  expectedRev?: number;
}
/**
 * Whether the schedule was deleted, and why not.
 * @beta
 */
export type DeleteScheduleResult = { deleted: true } | { deleted: false; reason: 'not-found' | 'conflict' };
/**
 * Schedules due now and the next due time.
 * @beta
 */
export interface ListDueSchedulesResult {
  /**
  * The store's time.
  * @beta
  */
  now: StoreTime;
  /**
  * Unpaused schedules due now, earliest first.
  * @beta
  */
  due: ScheduleRecord[];
  /**
  * When the next schedule falls due, or null.
  * @beta
  */
  nextDueAt: StoreTime | null;
}
/**
 * Fire one schedule tick; `nextRunAt` only in tick mode, and `job.id` is `sched:<key>:<scheduledFor>`.
 * @beta
 */
export interface FireScheduleRequest {
  /**
  * The schedule key.
  * @beta
  */
  key: string;
  /**
  * The revision the caller read; a different one is a `conflict`.
  * @beta
  */
  expectedRev: number;
  /**
  * `'tick'` fires the due tick and moves `nextRunAt` on; `'backlog'` fires a tick queued under the `queue` overlap policy.
  * @beta
  */
  mode: 'tick' | 'backlog';
  /**
  * The next tick to store, in tick mode.
  * @beta
  */
  nextRunAt?: StoreTime;
  /**
  * The job to insert.
  * @beta
  */
  job: NewJob;
}
/**
 * What a fire did.
 * @beta
 */
export type FireScheduleResult =
  | { outcome: 'fired'; jobId: string; schedule: ScheduleRecord }
  | { outcome: 'skipped'; reason: 'overlap' | 'backlog-full'; schedule: ScheduleRecord }
  | { outcome: 'queued'; schedule: ScheduleRecord }
  | { outcome: 'busy' }
  | { outcome: 'conflict' }
  | { outcome: 'early' }
  | { outcome: 'gone' }
  | { outcome: 'paused' };
