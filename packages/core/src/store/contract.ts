// store contract
import type { StoreCapabilities } from './capabilities.js';

/** The contract version this core speaks. Typed `number` so a later version is not a type change. */
export const STORE_CONTRACT_VERSION: number = 1;
/** The inclusive range `[lowest, highest]` of store contract versions this core accepts. */
export const SUPPORTED_CONTRACT_VERSIONS: readonly [number, number] = Object.freeze([1, 1] as const);

/** The six job states. */
export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'cancelled';
/** An instant as integer epoch milliseconds, read from the store's clock. */
export type StoreTime = number;
/** Opaque job data, result or error bytes. */
export type Payload = string | Uint8Array;
/** Where a job lives: one namespace and one queue. */
export interface Scope {
  /** Isolates apps or environments sharing one backend; set by the queue's `namespace` option. */
  namespace: string;
  /** The queue name. */
  queue: string;
}
/** A namespace without a queue, for namespace-wide records. */
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
 */
export interface Store {
  /** The contract version this store implements; set it to `STORE_CONTRACT_VERSION`. */
  readonly contractVersion: number;
  /** What the store can do, built with `defineCapabilities` and deeply frozen. */
  readonly capabilities: StoreCapabilities;
  /** Connect and check the schema. Calls before `open` throw `StoreRequestError`. */
  open(): Promise<void>;
  /** Stop serving calls. Calls after `close` throw `StoreRequestError`; closing twice is harmless. */
  close(): Promise<void>;
  /** The store's current time. */
  now(): Promise<StoreTime>;
  /** Insert jobs in input order under the duplicate rules. With `atomic: true`, one refused input writes nothing (needs `transactions`). */
  add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]>;
  /** Atomically lease up to `limit` due jobs to one worker, best first. */
  claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult>;
  /** Extend a lease if the caller's token still holds it. */
  renew(scope: Scope, req: RenewRequest): Promise<RenewResult>;
  /** Finish an active job with its result, fenced by its token. */
  complete(scope: Scope, req: CompleteRequest): Promise<CompleteResult>;
  /** Record a failed attempt: retry later or fail for good, fenced by its token. */
  fail(scope: Scope, req: FailRequest): Promise<FailResult>;
  /** Give a claimed job back without finishing it, fenced by its token. */
  release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult>;
  /** Find expired leases, count a crash, and requeue or fail each job. */
  sweep(scope: Scope, req: SweepRequest): Promise<SweepResult>;
  /** Cancel a job that has not finished. */
  cancel(scope: Scope, req: CancelRequest): Promise<CancelResult>;
  /** Delete a job that is not active. */
  remove(scope: Scope, req: { id: string }): Promise<RemoveResult>;
  /** Edit a waiting or delayed job, guarded by its revision. */
  update(scope: Scope, req: UpdateRequest): Promise<UpdateResult>;
  /** One job by id, or null. */
  get(scope: Scope, id: string): Promise<JobRecord | null>;
  /** One page of jobs in one state. */
  list(scope: Scope, req: ListRequest): Promise<JobRecord[]>;
  /** Jobs per state, plus `blocked`. */
  counts(scope: Scope): Promise<JobCounts>;
  /** Set or clear the queue's pause flag; `changed` is false when it already had that value. */
  setPaused(scope: Scope, paused: boolean): Promise<{ changed: boolean }>;
  /** Read the pause flag. `claim` must honour the same flag. */
  isPaused(scope: Scope): Promise<boolean>;
  /** Job counts, the oldest waiting job's due time and the dead-letter count in one read; the request is `{}`. */
  stats(scope: Scope, req: Record<string, never>): Promise<StatsResult>;
  /** One page of a job's attempt records, oldest first. */
  getAttempts(scope: Scope, req: GetAttemptsRequest): Promise<GetAttemptsResult>;
  /**
   * Delete up to `limit` jobs in one state that match the request, each with its attempt records. A deleted job also takes
   * the superseded records of its id (`id#seq`, left by id reuse) that are not dead letters. `retainExpired` also matches
   * those superseded records by their own `retainUntil` (or, with `olderThanMs`, `finishedAt`), as it does live ones, and
   * counts them in `removed`; the age mode of `failed` matches superseded dead letters the same way.
   */
  clean(scope: Scope, req: CleanRequest): Promise<CleanResult>;
  /** Delete a queue's jobs, schedules and pause flag in batches of `limit`. */
  obliterate(scope: Scope, req: ObliterateRequest): Promise<ObliterateResult>;
  /** Move failed jobs back to waiting or delayed. */
  redrive(scope: Scope, req: RedriveRequest): Promise<RedriveOutcome[]>;
  /** Write an active job's progress, fenced by its token. */
  setProgress(scope: Scope, req: SetProgressRequest): Promise<SetProgressResult>;
  /** Create or replace a worker's registry record. */
  registerWorker(ns: NamespaceScope, req: RegisterWorkerRequest): Promise<RegisterWorkerResult>;
  /** Refresh a worker's registry record; `ok: false` when it is gone. */
  heartbeatWorker(ns: NamespaceScope, req: HeartbeatWorkerRequest): Promise<{ ok: boolean }>;
  /** Delete a worker's registry record. */
  unregisterWorker(ns: NamespaceScope, req: { workerId: string }): Promise<void>;
  /** Worker registry records, optionally only those serving one queue. */
  listWorkers(ns: NamespaceScope, req: { queue?: string }): Promise<ListWorkersResult>;
  /**
   * Delete up to `limit` worker records not heard from for `staleIntervals` of their own heartbeat interval: each record
   * by its own `heartbeatIntervalMs`, so a worker that beats slowly is never purged by the pace of a faster one.
   */
  purgeWorkers(ns: NamespaceScope, req: { staleIntervals: number; limit: number }): Promise<{ removed: number }>;
  /** Create the namespace's format record or raise its version, refusing a version this pod cannot read. */
  ensureNamespaceMeta(ns: NamespaceScope, req: EnsureNamespaceMetaRequest): Promise<EnsureNamespaceMetaResult>;
  /** The namespace's format record, or null when none exists. */
  getNamespaceMeta(ns: NamespaceScope): Promise<StoreMeta | null>;
  /** Create or replace a schedule, guarded by its revision. */
  putSchedule(scope: Scope, req: PutScheduleRequest): Promise<PutScheduleResult>;
  /** One schedule by key, or null. */
  getSchedule(scope: Scope, req: { key: string }): Promise<ScheduleRecord | null>;
  /** One page of a queue's schedules in key order. */
  listSchedules(scope: Scope, req: ListSchedulesRequest): Promise<ListSchedulesResult>;
  /** Delete a schedule, optionally guarded by its revision. */
  deleteSchedule(scope: Scope, req: DeleteScheduleRequest): Promise<DeleteScheduleResult>;
  /** Unpaused schedules due at the store's time, earliest first. */
  listDueSchedules(scope: Scope, req: { limit: number }): Promise<ListDueSchedulesResult>;
  /** Insert a schedule's job for its due tick and advance the schedule in one atomic step. */
  fireSchedule(scope: Scope, req: FireScheduleRequest): Promise<FireScheduleResult>;
  /** Optional wake-up channel; resolves to an unsubscribe function. */
  subscribe?(scope: Scope, onWake: () => void): Promise<() => Promise<void>>;
}

/** A stored job as the store returns it. */
export interface JobRecord {
  /** The record format it was written in. */
  formatVersion: number;
  /** The namespace it lives in. */
  namespace: string;
  /** The queue it lives in. */
  queue: string;
  /** The job id, unique in its scope. */
  id: string;
  /** The job name, or null for an unnamed job. */
  name: string | null;
  /** The serialized job data; opaque to the store. */
  data: Payload;
  /** The data schema version given at add, or null. */
  dataVersion: number | null;
  /** The job's current state. */
  state: JobState;
  /** Higher runs first. */
  priority: number;
  /** Insertion order in the scope: unique, never reused, and negative for a job added with `first: true`. */
  seq: number;
  /** When the job is due, in store time. */
  runAt: StoreTime;
  /** Attempts started so far; 0 before the first claim. */
  attempt: number;
  /** Attempts allowed in total, at least 1. */
  maxAttempts: number;
  /** How many times its lease expired while running. */
  crashCount: number;
  /** `held` marks a lease taken for a batch that has not started its handler. */
  lease: { owner: string; token: number; expiresAt: StoreTime; claimId: string; held?: boolean } | null;
  /** The last fencing token issued to this job; 0 if never claimed. Taken from a counter per scope. */
  token: number;
  /** The last finishing write (token, kind, resulting state), so a repeat of it answers the same; cleared by the next claim. */
  lastFinal: { token: number; kind: 'complete' | 'fail' | 'release'; state: JobState; runAt?: StoreTime } | null;
  /** The serialized handler result of a completed job, or null. */
  result: Payload | null;
  /** The serialized error of the latest failed attempt, or null. */
  error: Payload | null;
  /** The serialized backoff spec given at add, opaque to the store; null for the queue default. */
  backoff: Payload | null;
  /** Per-job timeout override given at add, opaque to the store like `backoff`; null when none. */
  timeout: Payload | null;
  /** The key to pass to outside APIs, stable across attempts. */
  idempotencyKey: string | null;
  /** The worker of the latest claim, kept after the lease ends. */
  workerId: string | null;
  /** How long the id stays taken: while `pending` (not finished), or while the record is `retained`. */
  uniqueWhile: 'pending' | 'retained';
  /** The singleton key given at add, or null. */
  singletonKey: string | null;
  /** True while this job holds its singleton key (only while waiting or delayed); at most one holder per key. */
  singletonHeld: boolean;
  /** Revision for optimistic concurrency: starts at 1 and grows by 1 on every change. */
  rev: number;
  /** When the job was added, in store time. */
  createdAt: StoreTime;
  /** When it was last claimed, or null. */
  startedAt: StoreTime | null;
  /** When it completed, failed for good or was cancelled, or null. */
  finishedAt: StoreTime | null;
  /** Set when the job failed for good and was kept as a dead letter. */
  deadLetter: DeadLetterInfo | null;
  /** When a finished job may be deleted; null when retention does not apply. */
  retainUntil: StoreTime | null;
  /** Opaque per-job retention override given at add. */
  keep: Payload | null;
  /** The job's latest progress, or null. */
  progress: StoredProgress | null;
  /** Progress of the batch this job ran in. */
  batchProgress: StoredProgress | null;
  /** How many times the job was redriven. */
  redriveCount: number;
  /** The error of the last failed attempt, kept across a redrive. */
  lastError: Payload | null;
  /** How many attempt records were dropped by the per-job cap. */
  attemptsTruncated: number;
  /** The schedule that inserted this job; null for a plain add. */
  scheduleKey: string | null;
  /** The schedule tick this job was inserted for. */
  scheduledFor: StoreTime | null;
  /** Who cancelled the job; null when it was not cancelled. */
  cancelReason: 'user' | null;
}

/** A job to add. */
export interface NewJob {
  /** The job id; core always sets one (a UUIDv7 when the user gave none). */
  id: string;
  /** The job name; absent or null for an unnamed job. */
  name?: string | null;
  /** The serialized job data. */
  data: Payload;
  /** The data schema version, if the caller set one. */
  dataVersion?: number | null;
  /** The record format to write the job in. */
  formatVersion: number;
  /** Higher runs first; default 0. */
  priority?: number;
  /** Put the job ahead of every other job of the same priority. */
  first?: boolean;
  /** Delay from store time, in ms; never together with `runAt`. */
  delayMs?: number;
  /** An absolute due time, in store time; never together with `delayMs`. */
  runAt?: StoreTime;
  /** Attempts allowed in total, at least 1. */
  maxAttempts: number;
  /** The serialized backoff spec, opaque to the store. */
  backoff?: Payload | null;
  /** The serialized per-job timeout, opaque to the store. */
  timeout?: Payload | null;
  /** The key to pass to outside APIs; the store keeps it as given. */
  idempotencyKey?: string | null;
  /** How long the id stays taken; default `'pending'`. */
  uniqueWhile?: 'pending' | 'retained';
  /** What to do when the id or singleton key is taken; default `'ignore'`. */
  onDuplicate?: 'ignore' | 'replace' | 'reject';
  /** At most one waiting or delayed job per key in the scope. */
  singletonKey?: string | null;
  /** Fields whose value core took from queue defaults or library fallbacks; `replace` leaves them alone. */
  defaulted?: ReadonlyArray<'priority' | 'maxAttempts' | 'backoff'>;
  /** Opaque per-job retention override. */
  keep?: Payload | null;
}

/** What happened to one job of an add call. */
export type AddOutcome =
  | { status: 'added'; job: JobRecord }
  | { status: 'duplicate'; action: 'ignored' | 'replaced' | 'rejected'; by: 'id' | 'singletonKey'; existingState: JobState; job: JobRecord }
  | { status: 'not-applied' };

/** Ask the store for jobs to run. */
export interface ClaimRequest {
  /** The claiming worker; becomes the lease owner. */
  workerId: string;
  /** The most jobs to claim, from 1 to `capabilities.limits.maxClaimLimit`. */
  limit: number;
  /** Lease length, in ms. */
  leaseMs: number;
  /** Lease length per job name, overriding `leaseMs`. */
  leaseMsByName?: Record<string, number>;
  /** Only jobs of these names; null matches unnamed jobs. Absent means any. */
  names?: (string | null)[];
  /** Within one priority, oldest first (`'fifo'`, the default) or newest first. */
  order?: 'fifo' | 'lifo';
  /** Unique per logical claim. A retry after an unknown outcome reuses it, and the store returns that claim's live jobs. */
  claimId: string;
  /** Take the leases as held: the handler has not started yet. */
  hold?: boolean;
  /** The attempt record to open for each claimed job; false writes none. */
  history?: ClaimHistoryOption;
  /** Skip jobs written in a format newer than this. */
  maxFormat?: number;
}
/** Jobs claimed, plus the store's time and the next due instant. */
export interface ClaimResult {
  /** The claimed jobs, in claim order; may be fewer than `limit`. */
  jobs: JobRecord[];
  /** The store's time. */
  now: StoreTime;
  /** The earliest due time among delayed jobs, so an idle worker knows how long to sleep; null when none. */
  nextRunAt: StoreTime | null;
  /** True when the queue is paused; same as `blocked?.reason === 'paused'`. */
  paused: boolean;
  /** Present only when nothing was claimed although due jobs exist. */
  blocked?: ClaimBlocked;
  /** The jobs are an earlier claim with the same `claimId`; nothing new was claimed. */
  recovered?: true;
}
/** Why a claim returned nothing. */
export interface ClaimBlocked {
  /** What blocks the claim. */
  reason: 'paused';
}

/** A write refused because the caller no longer holds the lease. */
export type FencedRejection = { ok: false; reason: 'superseded' | 'expired' | 'not-active' };

/** Extend a lease. */
export interface RenewRequest {
  /** The job. */
  id: string;
  /** The caller's fencing token. */
  token: number;
  /** New lease length from store time, in ms. */
  leaseMs: number;
  /** The handler of a held lease has started. */
  started?: boolean;
  /** The batch the job runs in; only together with `started: true`. */
  batchId?: string;
}
/** A renewed lease with its new expiry, or a fenced rejection. */
export type RenewResult = { ok: true; expiresAt: StoreTime; now: StoreTime } | FencedRejection;

/** Finish an active job with its result. */
export interface CompleteRequest {
  /** The job. */
  id: string;
  /** The caller's fencing token. */
  token: number;
  /** The serialized result, or null. */
  result: Payload | null;
  /** How to close the attempt record; false writes none. */
  history?: HistoryOption;
  /** Delete the job or set how long it is kept. */
  retention?: RetentionDirective;
}
/** `ok` with store time (`repeated` for a repeat of the same write), or a fenced rejection. */
export type CompleteResult = { ok: true; now: StoreTime; repeated?: true } | FencedRejection;

/** Record a failed attempt. */
export interface FailRequest {
  /** The job. */
  id: string;
  /** The caller's fencing token. */
  token: number;
  /** The serialized error of this attempt. */
  error: Payload;
  /** Retry after this delay; absent fails the job for good. */
  retryInMs?: number;
  /** How to close the attempt record; false writes none. */
  history?: HistoryOption;
  /** For a final failure: delete the job or set how long it is kept. */
  retention?: RetentionDirective;
  /** Keep a final failure as a dead letter; an absent `reason` means `exhausted`. */
  deadLetter?: false | { reason?: Exclude<DeadLetterReason, 'crashLimit' | 'legacy'>; keepMs?: number };
}
/** The state the job moved to (`delayed` for a retry, `failed` for good), or a fenced rejection. */
export type FailResult =
  | { ok: true; state: 'delayed' | 'failed'; runAt?: StoreTime; now: StoreTime; repeated?: true }
  | FencedRejection;

/** Give a claimed job back without finishing it. */
export interface ReleaseRequest {
  /** The job. */
  id: string;
  /** The caller's fencing token. */
  token: number;
  /** Absent or 0: back to `waiting` now. Above 0: `delayed` for that long. */
  delayMs?: number;
  /** True when the attempt should not count, so `attempt` goes back by one. */
  refundAttempt: boolean;
  /** Whether this attempt's handler started. */
  handlerStarted: boolean;
  /** Why the job was given back, for the attempt record. */
  reason?: 'shutdown' | 'pause';
  /** How to close the attempt record; false writes none. */
  history?: HistoryOption;
}
/** The state the job moved to and when it is due, or a fenced rejection. */
export type ReleaseResult =
  | { ok: true; state: 'waiting' | 'delayed'; runAt: StoreTime; now: StoreTime; repeated?: true }
  | FencedRejection;

/** Recover jobs whose lease expired. */
export interface SweepRequest {
  /** The most jobs to act on, from 1 to `capabilities.limits.maxClaimLimit`. */
  limit: number;
  /** Fail a job for good once its lease has expired this many times. */
  maxCrashes: number;
  /** The serialized `StalledJobError` to store when a job is failed because its attempts are used up. */
  failError: Payload;
  /** The serialized `PoisonPillError` to store when a job reaches `maxCrashes`; wins when both limits are hit. */
  poisonError: Payload;
  /** How to close the attempt records; false writes none. */
  history?: HistoryOption;
  /** For jobs the sweep fails: delete them or set how long they are kept. */
  retention?: RetentionDirective;
  /** Keep jobs failed by the sweep as dead letters; the store picks the reason. */
  deadLetter?: false | { keepMs?: number };
  /** Skip jobs written in a format newer than this. */
  maxFormat?: number;
}
/** One job a sweep acted on. */
export interface SweptJob {
  /** The job. */
  id: string;
  /** The token of the expired lease. */
  token: number;
  /** The worker that held the expired lease. */
  previousOwner: string;
  /** Whether the job was requeued or failed for good. */
  action: 'requeued' | 'failed';
  /** The job's attempt count after the sweep. */
  attempt: number;
  /** The job's crash count after the sweep. */
  crashCount: number;
}
/** What a sweep did. */
export interface SweepResult {
  /** Every job the sweep acted on. */
  swept: SweptJob[];
  /** The store's time. */
  now: StoreTime;
}

/** Cancel a job that has not finished. */
export interface CancelRequest {
  /** The job. */
  id: string;
  /**
   * The attempt record of an active job, as on the other writes. Absent (a caller that keeps no history settings, such
   * as a producer): close the job's open attempt record if one exists, apply no cap and insert no record.
   */
  history?: HistoryOption;
  /** Delete the job or set how long it is kept. */
  retention?: RetentionDirective;
}
/** The state the job was cancelled from, or why it could not be. */
export type CancelResult =
  | { ok: true; previousState: 'waiting' | 'delayed' | 'active' }
  | { ok: false; reason: 'not-found' | 'already-terminal'; state?: JobState };
/** The state the job was removed from, or why it was not. */
export type RemoveResult =
  | { removed: true; previousState: JobState }
  | { removed: false; reason: 'not-found' | 'active' };

/** Edit a waiting or delayed job, guarded by its revision. */
export interface UpdateRequest {
  /** The job. */
  id: string;
  /** The revision the caller read; a different one is a `conflict`. */
  expectedRev: number;
  /** The fields to change. */
  patch: { data?: Payload; priority?: number; delayMs?: number; runAt?: StoreTime };
}
/** The updated job, or why it was not changed. */
export type UpdateResult = { ok: true; job: JobRecord } | { ok: false; reason: 'conflict' | 'not-found' | 'not-editable' };

/** Page through jobs in one state. */
export interface ListRequest {
  /** The state to list. */
  state: JobState;
  /** Jobs to skip. */
  offset: number;
  /** The most jobs to return. */
  limit: number;
  /** `deadLetterAt` requires the `deadLetter` filter; `seq` breaks ties. */
  orderBy?: 'seq' | 'runAt' | 'startedAt' | 'finishedAt' | 'deadLetterAt';
  /** Sort direction; ties are broken by `seq` in the same direction, so pages are stable. */
  order: 'asc' | 'desc';
  /** Only dead letters, optionally of one reason and older than `olderThanMs`. */
  deadLetter?: { reason?: DeadLetterReason; olderThanMs?: number };
  /** Only jobs of this name; null means unnamed. */
  name?: string | null;
}
/** Jobs per state, plus those blocked. */
export type JobCounts = Record<JobState, number> & { blocked: number };

/** Attempt history on a write: false writes no record; `max` caps records per job. */
export type HistoryOption = false | { max?: number };
/** Attempt history on claim, which also names the host of the record it opens. */
export type ClaimHistoryOption = false | { max?: number; host?: string | null };
/** At finish, delete the job or set `retainUntil` to now plus `retainMs`. */
export interface RetentionDirective {
  /** Delete the job as it finishes. */
  discard?: boolean;
  /** Keep the job this long after it finishes, by setting `retainUntil`. */
  retainMs?: number;
}
/** Why a job became a dead letter. */
export type DeadLetterReason = 'exhausted' | 'unrecoverable' | 'retryRejected' | 'crashLimit' | 'legacy';
/** When and why a job became a dead letter. */
export interface DeadLetterInfo {
  /** When it became a dead letter, in store time. */
  at: StoreTime;
  /** Why it became a dead letter. */
  reason: DeadLetterReason;
}
/** States `clean` can delete from. */
export type CleanableState = 'completed' | 'failed' | 'cancelled' | 'waiting' | 'delayed';
/** A worker's run state in the registry. */
export type WorkerStatus = 'running' | 'paused' | 'draining';
/** What a schedule does when its previous job has not finished. */
export type OverlapPolicy = 'skip' | 'queue' | 'allow';
/** Opaque progress and when it was written. */
export interface StoredProgress {
  /** The serialized progress. */
  value: Payload;
  /** When it was written, in store time. */
  updatedAt: StoreTime;
}

/** Counts, the oldest waiting job's due time and the dead-letter count. */
export interface StatsResult {
  /** Jobs per state, plus `blocked`. */
  counts: JobCounts;
  /** The due time of the oldest waiting job, or null when none waits. */
  oldestWaitingRunAt: StoreTime | null;
  /** How many dead letters the queue holds. */
  deadLetters: number;
  /** The store's time. */
  now: StoreTime;
}

/** How an attempt ended; `running` while it is open. */
export type AttemptOutcome = 'running' | 'completed' | 'failed' | 'crashed' | 'cancelled' | 'released';
/** One attempt record as the store keeps it. */
export interface StoredAttempt {
  /** The record format it was written in. */
  formatVersion: number;
  /** The job it belongs to. */
  jobId: string;
  /** The attempt number, from 1. */
  attempt: number;
  /** How many times the job had been redriven when this attempt ran. */
  cycle: number;
  /** The fencing token of this attempt's lease. */
  token: number;
  /** The worker that ran it. */
  workerId: string;
  /** The host the worker ran on, or null. */
  host: string | null;
  /** When it was claimed, in store time. */
  startedAt: StoreTime;
  /** When it ended, or null while it runs. */
  finishedAt: StoreTime | null;
  /** How long it ran, or null while it runs. */
  durationMs: number | null;
  /** How long the job waited after it was due before this claim. */
  waitMs: number;
  /** The batch it ran in, or null. */
  batchId: string | null;
  /** How long a batch held it before the handler started, or null. */
  heldMs: number | null;
  /** How it ended; `running` while it is open. */
  outcome: AttemptOutcome;
  /** The serialized error of a failed attempt, or null. */
  error: Payload | null;
  /** What ended it, or null while it runs. */
  endedBy: 'worker' | 'sweeper' | 'cancel' | 'shutdown' | null;
  /** Claim time, then the time of every successful renew. */
  lastRenewAt: StoreTime;
}
/** Page through one job's attempt records. */
export interface GetAttemptsRequest {
  /** The job. */
  id: string;
  /** The most records to return. */
  limit?: number;
  /** Where the previous page ended. */
  cursor?: string;
}
/** One page of attempt records. */
export interface GetAttemptsResult {
  /** The records, oldest first. */
  attempts: StoredAttempt[];
  /** How many records the per-job cap dropped. */
  truncated: number;
  /** Pass it to get the next page; null on the last page. */
  nextCursor: string | null;
}

/** Delete jobs in one state, oldest first. */
export interface CleanRequest {
  /** The state to delete from. */
  state: CleanableState;
  /** Only jobs at least this old (finished jobs by `finishedAt`); with `retainExpired`, the age of a job with no `retainUntil`. */
  olderThanMs?: number;
  /** Keep the newest N by `finishedAt` then `seq`, never counting a dead letter or a `retained` job; a finished state only. */
  keepLast?: number;
  /**
   * Only jobs whose `retainUntil` has passed, whatever their name. With `olderThanMs`, also jobs with no `retainUntil`,
   * no `keep`, no dead letter and not `retained` (a previous release finished them), by `finishedAt`, filtered by name.
   */
  retainExpired?: boolean;
  /** Only jobs of this name; null means unnamed. */
  name?: string | null;
  /** Skip jobs of these names (an unnamed job is never skipped). */
  excludeNames?: string[];
  /** The most jobs to delete in this call. */
  limit: number;
}
/** What a clean call deleted. */
export interface CleanResult {
  /** How many jobs were deleted. */
  removed: number;
  /** More jobs match than this call removed. */
  remaining: boolean;
}

/** Delete a whole queue; without `force`, active jobs make it throw `QueueNotIdleError`. */
export interface ObliterateRequest {
  /** Delete even while jobs are active. */
  force?: boolean;
  /** Records to delete per batch. */
  limit: number;
}
/** What an obliterate call deleted. */
export interface ObliterateResult {
  /** How many records were deleted. */
  removed: number;
  /** True once nothing of the queue is left. */
  done: boolean;
}

/** Redrive failed jobs by id or by a dead-letter filter. */
export type RedriveRequest = (
  | { ids: string[]; filter?: never }
  | { filter: { reason?: DeadLetterReason; olderThanMs?: number }; ids?: never }
) & { resetAttempts?: boolean; delayMs?: number; priority?: number; limit: number };
/** What happened to one job of a redrive. */
export type RedriveOutcome =
  | { id: string; status: 'redriven'; state: 'waiting' | 'delayed'; viaDeadLetter: boolean }
  | { id: string; status: 'skipped'; reason: 'not-failed' | 'not-found' | 'duplicate-id' };

/** Write an active job's progress. */
export interface SetProgressRequest {
  /** The job. */
  id: string;
  /** The caller's fencing token. */
  token: number;
  /** The serialized progress. */
  progress: Payload;
  /** Write the job's own `progress` (the default) or its `batchProgress`. */
  field?: 'progress' | 'batchProgress';
}
/** `ok` with store time, or a fenced rejection. */
export type SetProgressResult = { ok: true; now: StoreTime } | FencedRejection;

/** A worker's registry record as the worker writes it. */
export interface RegisterWorkerRequest {
  /** The worker's id. */
  workerId: string;
  /** The queues it serves. */
  queues: string[];
  /** The job names it handles; null matches unnamed jobs. Absent means any. */
  names?: (string | null)[];
  /** Its concurrency. */
  concurrency: number;
  /** The SureQ version it runs. */
  sureqVersion: string;
  /** The job format version the worker writes. */
  formatVersion: number;
  /** How often it heartbeats, in ms; staleness is judged by this. */
  heartbeatIntervalMs: number;
  /** The host it runs on. */
  host: string;
  /** Its process id, or null where there is none. */
  pid: number | null;
  /** Free-form labels from the worker's options. */
  labels: Record<string, string>;
  /** Whether the worker's queue runs a scheduler on that pod. */
  scheduler: boolean;
}
/** The registered worker's start time. */
export interface RegisterWorkerResult {
  /** When the record was created, in store time. */
  startedAt: StoreTime;
  /** The store's time. */
  now: StoreTime;
}
/** A worker's registry record as the store returns it. */
export interface WorkerRecord extends Omit<RegisterWorkerRequest, 'names'> {
  /** The job names it handles, or null for any. */
  names: (string | null)[] | null;
  /** Jobs it was running at its last heartbeat. */
  activeJobs: number;
  /** Its run state at its last heartbeat. */
  status: WorkerStatus;
  /** When it registered, in store time. */
  startedAt: StoreTime;
  /** When it last heartbeat, in store time. */
  lastHeartbeatAt: StoreTime;
}
/** What a worker reports on each heartbeat. */
export interface HeartbeatWorkerRequest {
  /** The worker's id. */
  workerId: string;
  /** Jobs it is running now. */
  activeJobs: number;
  /** Its concurrency. */
  concurrency: number;
  /** Its run state. */
  status: WorkerStatus;
  /** Whether its queue runs a scheduler on that pod. */
  scheduler: boolean;
}
/** Worker records and the store's time, to judge staleness. */
export interface ListWorkersResult {
  /** The worker records. */
  workers: WorkerRecord[];
  /** The store's time. */
  now: StoreTime;
}

/** The format versions this pod writes and reads. */
export interface EnsureNamespaceMetaRequest {
  /** The format this pod writes. */
  current: number;
  /** The oldest format this pod reads. */
  minReadable: number;
  /** The newest format this pod reads. */
  maxReadable: number;
  /** This pod's SureQ version, recorded on the record. */
  sureqVersion: string;
}
/** The namespace's format after the call. */
export interface EnsureNamespaceMetaResult {
  /** The namespace's format now. */
  formatVersion: number;
  /** True when this call created the record. */
  created: boolean;
  /** True when this call raised its version. */
  raised: boolean;
}
/** A namespace's format record. */
export interface StoreMeta {
  /** The format the namespace is at. */
  formatVersion: number;
  /** The SureQ version that created the record. */
  createdBy: string;
  /** The SureQ version that last raised the format. */
  lastRaisedBy: string;
  /** When it last changed, in store time. */
  updatedAt: StoreTime;
}

/** A stored schedule; the store never reads `template.data` or `template.opts`. */
export interface ScheduleRecord {
  /** The record format it was written in. */
  formatVersion: number;
  /** The namespace it lives in. */
  namespace: string;
  /** The queue it fires into. */
  queue: string;
  /** The schedule key, unique in its queue. */
  key: string;
  /** A cron expression or a fixed interval. */
  kind: 'cron' | 'every';
  /** The cron expression, for `kind: 'cron'`. */
  cron?: string;
  /** The IANA time zone for `cron`. */
  tz?: string;
  /** The interval in ms, for `kind: 'every'`. */
  everyMs?: number;
  /** The origin of the interval grid, in store time. */
  anchorAt?: StoreTime;
  /** The job each tick inserts. The store never reads its `data` or `opts`. */
  template: { name: string | null; data: Payload; opts: Record<string, unknown> };
  /** What to do when the previous job has not finished. */
  overlap: OverlapPolicy;
  /** The most ticks kept waiting under the `queue` overlap policy. */
  maxQueued: number;
  /** Whether the schedule is paused. */
  paused: boolean;
  /** The next tick, in store time. */
  nextRunAt: StoreTime;
  /** The tick time of the last tick that produced a job, or null. */
  lastFiredFor: StoreTime | null;
  /** The id of the last job it inserted, or null. */
  lastJobId: string | null;
  /** Ticks waiting to fire under the `queue` overlap policy. */
  queuedTicks: StoreTime[];
  /** How many jobs it has inserted. */
  runCount: number;
  /** A hash of the timing, template and overlap, to tell whether a re-upsert changes anything. */
  definitionHash: string;
  /** The `version` given with the definition; 0 when unversioned. */
  definitionVersion: number;
  /** Revision for optimistic concurrency, growing by 1 on every write. */
  rev: number;
  /** When it was created, in store time. */
  createdAt: StoreTime;
  /** When it last changed, in store time. */
  updatedAt: StoreTime;
}
/** A schedule to write; the store fills scope, revision and timestamps. */
export type NewSchedule = Omit<ScheduleRecord, 'namespace' | 'queue' | 'rev' | 'createdAt' | 'updatedAt'>;
/** Write a schedule; `expectedRev: null` means it must not exist yet. */
export interface PutScheduleRequest {
  /** The schedule to write. */
  schedule: NewSchedule;
  /** The revision the caller read, or null to create a new schedule. */
  expectedRev: number | null;
}
/** The written schedule, or why it was not written. */
export type PutScheduleResult = { ok: true; schedule: ScheduleRecord } | { ok: false; reason: 'conflict' | 'exists' };
/** Page through a queue's schedules. */
export interface ListSchedulesRequest {
  /** Where the previous page ended. */
  cursor?: string;
  /** The most schedules to return. */
  limit: number;
}
/** One page of schedules, in key order. */
export interface ListSchedulesResult {
  /** The schedules. */
  schedules: ScheduleRecord[];
  /** Pass it to get the next page; null on the last page. */
  nextCursor: string | null;
}
/** Delete a schedule. */
export interface DeleteScheduleRequest {
  /** The schedule key. */
  key: string;
  /** Delete only at this revision; absent deletes whatever is there. */
  expectedRev?: number;
}
/** Whether the schedule was deleted, and why not. */
export type DeleteScheduleResult = { deleted: true } | { deleted: false; reason: 'not-found' | 'conflict' };
/** Schedules due now and the next due time. */
export interface ListDueSchedulesResult {
  /** The store's time. */
  now: StoreTime;
  /** Unpaused schedules due now, earliest first. */
  due: ScheduleRecord[];
  /** When the next schedule falls due, or null. */
  nextDueAt: StoreTime | null;
}
/** Fire one schedule tick; `nextRunAt` only in tick mode, and `job.id` is `sched:<key>:<scheduledFor>`. */
export interface FireScheduleRequest {
  /** The schedule key. */
  key: string;
  /** The revision the caller read; a different one is a `conflict`. */
  expectedRev: number;
  /** `'tick'` fires the due tick and moves `nextRunAt` on; `'backlog'` fires a tick queued under the `queue` overlap policy. */
  mode: 'tick' | 'backlog';
  /** The next tick to store, in tick mode. */
  nextRunAt?: StoreTime;
  /** The job to insert. */
  job: NewJob;
}
/** What a fire did. */
export type FireScheduleResult =
  | { outcome: 'fired'; jobId: string; schedule: ScheduleRecord }
  | { outcome: 'skipped'; reason: 'overlap' | 'backlog-full'; schedule: ScheduleRecord }
  | { outcome: 'queued'; schedule: ScheduleRecord }
  | { outcome: 'busy' }
  | { outcome: 'conflict' }
  | { outcome: 'early' }
  | { outcome: 'gone' }
  | { outcome: 'paused' };
