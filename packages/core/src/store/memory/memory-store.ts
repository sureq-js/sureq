import { InternalError, QueueNotIdleError, QueueObliteratingError, StoreFormatError } from '../../errors/catalog.js';
import { parseDuration, type Duration } from '../../util/duration.js';
import { defineCapabilities } from '../capabilities.js';
import {
  STORE_CONTRACT_VERSION, type AddOutcome, type Store, type CancelRequest, type CancelResult, type ClaimRequest, type ClaimResult,
  type CleanRequest, type CleanResult, type CompleteRequest, type DeadLetterReason, type CompleteResult, type DeleteScheduleRequest, type DeleteScheduleResult,
  type EnsureNamespaceMetaRequest, type EnsureNamespaceMetaResult, type FailRequest, type FailResult, type FireScheduleRequest,
  type FireScheduleResult, type GetAttemptsRequest, type GetAttemptsResult, type HeartbeatWorkerRequest, type JobCounts, type JobRecord,
  type JobState, type ListDueSchedulesResult, type RetentionDirective, type ListRequest, type ListSchedulesRequest, type ListSchedulesResult,
  type ListWorkersResult, type NamespaceScope, type NewJob, type ObliterateRequest, type ObliterateResult, type PutScheduleRequest,
  type PutScheduleResult, type RedriveOutcome, type RedriveRequest, type RegisterWorkerRequest, type RegisterWorkerResult,
  type ReleaseRequest, type ReleaseResult, type RemoveResult, type RenewRequest, type RenewResult, type ScheduleRecord, type Scope,
  type SetProgressRequest, type SetProgressResult, type StatsResult, type StoreMeta, type StoredAttempt, type SweepRequest, type SweepResult,
  type SweptJob, type UpdateRequest, type UpdateResult,
} from '../contract.js';
import { cleansDeadLetters, selectClean } from './admin.js';
import { RecordMap, applyReplace, findHolder, releaseHold, supersede, takeOrSkipHold, unsupersede, type DedupState } from './dedup.js';
import { fence, type FinalKind, type Verdict } from './fence.js';
import { closeAttempt, closeOpenAttempt, noteRenew, openAttempt, type AttemptEnd, type HistoryExt } from './history.js';
import { checkStamp } from './format.js';
import type { FaultHooks, StoreOp, StoreSnapshot, Tombstone } from './hooks.js';
import { DelayedHeap, OrderedIndex } from './ordered-index.js';
import { canMove } from './transitions.js';
import {
  bad, checkAdd, checkCancel, checkClaim, checkClean, checkComplete, checkDeleteSchedule, checkEnsureMeta, checkFail, checkFire, checkGetAttempts, checkId,
  checkIdRequest, checkList, checkListDue, checkListSchedules, checkNamespace, checkObliterate, checkPaused, checkPutSchedule, checkRedrive, checkRelease, checkRenew,
  checkScheduleKey, checkScope, checkSetProgress, checkStats, checkSweep, checkUpdate, checkRegisterWorker, checkHeartbeatWorker, checkWorkerId,
  checkListWorkers, checkPurgeWorkers,
} from './validate.js';
import { heartbeatWorker, listWorkers, purgeWorkers, registerWorker, type WorkerTable } from './workers.js';
import { deleteSchedule, fire, getSchedule, listDue, listSchedules, putSchedule, type ScheduleTable } from './schedules.js';

/** Waiting jobs of one job name: one ordered bucket (by `seq`) per priority level. */
interface NameIndex {
  /** Priority levels present, sorted high to low. */
  levels: number[];
  buckets: Map<number, OrderedIndex<string>>;
}

/** One queue's jobs inside one namespace, plus its counters (never reset). */
interface ScopeData extends DedupState {
  names: Map<string | null, NameIndex>;
  delayed: DelayedHeap;
  /** Active jobs by lease expiry. */
  leases: DelayedHeap;
  /** Ids per `owner\u0000claimId`, in claim order. */
  claims: Map<string, Set<string>>;
  nextSeq: number;
  lowSeq: number;
  lastToken: number;
  paused: boolean;
  /** Set while an `obliterate` is under way: every write in `MARKED` (and a starting renew) is refused. */
  obliterating: boolean;
  subscribers: Set<Subscriber>;
  schedules: ScheduleTable;
}

/** One `subscribe` call; `scheduled` coalesces wakes into one call per microtask. */
interface Subscriber {
  onWake: () => void;
  scheduled: boolean;
}

interface NamespaceData {
  /** Written only by `ensureNamespaceMeta`. */
  meta: StoreMeta | null;
  queues: Map<string, ScopeData>;
  workers: WorkerTable;
}

/** Insert into a descending sorted array of numbers (binary search; no full sort). */
function insertDesc(levels: number[], p: number): void {
  let lo = 0;
  let hi = levels.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (levels[mid]! > p) lo = mid + 1;
    else hi = mid;
  }
  levels.splice(lo, 0, p);
}

type Lease = JobRecord['lease'];
const claimKey = (lease: NonNullable<Lease>): string => `${lease.owner}\u0000${lease.claimId}`;
const tombstoneKey = (s: Scope, id: string): string => `${s.namespace}\u0000${s.queue}\u0000${id}`;
const checkSafe = (op: StoreOp, at: number, what: string): void => {
  if (at > Number.MAX_SAFE_INTEGER) bad(op, `${what} beyond the safe integer range`);
};
const isTerminal = (state: JobState): boolean => state === 'completed' || state === 'failed' || state === 'cancelled';

type DeadLetterFilter = NonNullable<ListRequest['deadLetter']>;
type DeadLetterExt = { reason?: DeadLetterReason; keepMs?: number } | false | undefined;
/** Refuse a `keepMs` whose `retainUntil` would leave the safe integer range, before any write. */
const checkKeep = (op: StoreOp, now: number, ext: DeadLetterExt): void => checkSafe(op, now + (ext ? ext.keepMs ?? 0 : 0), 'deadLetter.keepMs puts retainUntil');
/** A live record matching a dead-letter filter: failed with a marker of that reason, at least `olderThanMs` old. */
const isDeadLetter = (rec: JobRecord, f: DeadLetterFilter, now: number): boolean =>
  rec.state === 'failed' && rec.deadLetter !== null && (f.reason === undefined || rec.deadLetter.reason === f.reason) &&
  (f.olderThanMs === undefined || rec.deadLetter.at <= now - f.olderThanMs);
const byDeadLetterAt = (a: JobRecord, b: JobRecord): number => a.deadLetter!.at - b.deadLetter!.at || a.seq - b.seq;

/**
 * Mark a job that failed for good, in the write that fails it. An absent field comes from a previous-release pod
 * (`legacy`); `false` leaves a plain failed job.
 */
function markDeadLetter(rec: JobRecord, now: number, ext: DeadLetterExt, reason: DeadLetterReason): void {
  if (ext === false) return;
  rec.deadLetter = { at: now, reason: ext === undefined ? 'legacy' : reason };
  rec.retainUntil = ext?.keepMs === undefined ? null : now + ext.keepMs;
}

/** Refuse a `retainMs` whose `retainUntil` would leave the safe integer range, before any write. */
const checkRetain = (op: StoreOp, now: number, ext: RetentionDirective | undefined): void => checkSafe(op, now + (ext?.retainMs ?? 0), 'retention.retainMs puts retainUntil');

/** A copy of a record for the caller, after its format stamp is checked (core judges which versions it reads). */
const out = (rec: JobRecord): JobRecord => (checkStamp('job', rec), structuredClone(rec));

/** Fields every new record starts with. */
const NEW_RECORD_DEFAULTS = {
  deadLetter: null, retainUntil: null, keep: null, progress: null, batchProgress: null, redriveCount: 0, lastError: null,
  attemptsTruncated: 0, scheduleKey: null, scheduledFor: null, cancelReason: null,
} as const satisfies Partial<JobRecord>;

/** The writes an obliterating queue refuses, atomically with their own work. */
const MARKED: ReadonlySet<StoreOp> = new Set<StoreOp>(['add', 'claim', 'sweep', 'redrive', 'setProgress', 'fireSchedule', 'putSchedule']);

const DEFAULT_FINALS_TTL_MS = 600_000;
const UNSAFE_KEYS = ['state', 'lease', 'token', 'rev', 'crashCount', 'maxAttempts', 'attempt', 'runAt', 'formatVersion', 'seq', 'keep', 'progress', 'batchProgress'];

// The `faults` option, `dump()` and `unsafeMutate()` are test-only hooks, kept out of the published declarations.
/**
 * The built-in in-memory store. Every operation is one synchronous critical section inside an
 * async method.
 * @beta It implements the store contract, which is experimental until 1.1.
 */
export class MemoryStore implements Store {
  /** The contract version this store implements: `STORE_CONTRACT_VERSION`. */
  readonly contractVersion = STORE_CONTRACT_VERSION;
  /** Transactions, skip-locked claims and notify; not durable and not shared between processes. */
  readonly capabilities = defineCapabilities({ transactions: true, skipLocked: true, notify: true, ttl: false, durable: false, shared: false });
  readonly #clock: () => number;
  readonly #faults: FaultHooks | undefined;
  readonly #finalsTtl: number;
  readonly #namespaces = new Map<string, NamespaceData>();
  /** Deleted jobs' last finalising writes; insertion order is expiry order. */
  readonly #tombstones = new Map<string, Tombstone>();
  #last = -Infinity;
  #opened = false;

  constructor(opts: {
    clock?: () => number;
    finalsTtl?: Duration;
    /** @internal Test-only: intercepts every operation. */
    faults?: FaultHooks;
  } = {}) {
    this.#clock = opts.clock ?? Date.now;
    this.#faults = opts.faults;
    this.#finalsTtl = parseDuration(opts.finalsTtl ?? DEFAULT_FINALS_TTL_MS, 'finalsTtl');
  }

  /**
   * Start serving calls. Nothing to connect to; calls before `open` throw `StoreRequestError`.
   * @beta
   */
  async open(): Promise<void> {
    return this.#run('open', () => void (this.#opened = true));
  }

  /**
   * Stops serving calls and drops every subscription; the data stays (the store object is the database).
   * @beta
   */
  async close(): Promise<void> {
    return this.#run('close', () => {
      this.#opened = false;
      for (const ns of this.#namespaces.values()) for (const data of ns.queues.values()) data.subscribers.clear();
    });
  }

  /**
   * Store time in integer ms; never goes backwards.
   * @beta
   */
  async now(): Promise<number> {
    return this.#run('now', () => {
      this.#ready('now');
      return this.#tick();
    });
  }

  /**
   * Insert jobs in input order under the duplicate rules (`onDuplicate`, `uniqueWhile`). A finished record
   * whose id is reused moves to `id#<seq>`, where nothing reads it. `atomic`: a rejected input writes nothing.
   * @beta
   */
  async add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    return this.#run('add', () => this.#add(scope, jobs, opts));
  }

  /**
   * One job by id, or null.
   * @beta
   */
  async get(scope: Scope, id: string): Promise<JobRecord | null> {
    return this.#run('get', () => this.#get(scope, id));
  }

  /**
   * One state's records, paged, by `orderBy` (default `seq`); ties by `seq` in the same direction.
   * @beta
   */
  async list(scope: Scope, req: ListRequest): Promise<JobRecord[]> {
    return this.#run('list', () => this.#list(scope, req));
  }

  /**
   * Jobs per state (due delayed jobs count as waiting); `blocked` is every waiting job while paused.
   * @beta
   */
  async counts(scope: Scope): Promise<JobCounts> {
    return this.#run('counts', () => this.#counts(scope));
  }

  /**
   * Atomically move up to `limit` waiting jobs to `active`, best first: highest priority, then
   * oldest (fifo) or newest (lifo) `seq`. A record with an unreadable format is skipped and left as it was.
   * A repeat with the same `workerId` and `claimId` returns that claim's still-live jobs (`recovered: true`)
   * and claims nothing new; a paused queue claims nothing and reports `blocked` when waiting jobs are held back.
   * @beta
   */
  async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    return this.#run('claim', () => this.#claim(scope, req));
  }

  /**
   * Extend a live lease to `now + leaseMs` (it may shrink); owner, token and attempt stay.
   * @beta
   */
  async renew(scope: Scope, req: RenewRequest): Promise<RenewResult> {
    return this.#run('renew', () => this.#renew(scope, req));
  }

  /**
   * Finish an active job. A repeat with the same token returns `repeated: true` and changes nothing.
   * @beta
   */
  async complete(scope: Scope, req: CompleteRequest): Promise<CompleteResult> {
    return this.#run('complete', () => this.#complete(scope, req));
  }

  /**
   * Fail an attempt: to `delayed` when `retryInMs` is given and attempts remain, else to `failed`.
   * @beta
   */
  async fail(scope: Scope, req: FailRequest): Promise<FailResult> {
    return this.#run('fail', () => this.#fail(scope, req));
  }

  /**
   * Give a claimed job back: `waiting` now, or `delayed` by `delayMs`; the token is kept.
   * @beta
   */
  async release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult> {
    return this.#run('release', () => this.#release(scope, req));
  }

  /**
   * Recover up to `limit` active jobs whose lease expired, oldest expiry first: each crash counts once;
   * the job is requeued, or failed with `poisonError` at `maxCrashes` (else `failError` when attempts are used up).
   * @beta
   */
  async sweep(scope: Scope, req: SweepRequest): Promise<SweepResult> {
    return this.#run('sweep', () => this.#sweep(scope, req));
  }

  /**
   * Edit a waiting or delayed job whose `rev` matches; `seq` is kept.
   * @beta
   */
  async update(scope: Scope, req: UpdateRequest): Promise<UpdateResult> {
    return this.#run('update', () => this.#update(scope, req));
  }

  /**
   * Delete a job that is not active, or a superseded dead letter by its `id#seq`; a finalised job leaves a tombstone for `finalsTtl`.
   * @beta
   */
  async remove(scope: Scope, req: { id: string }): Promise<RemoveResult> {
    return this.#run('remove', () => this.#remove(scope, req));
  }

  /**
   * Move a waiting, delayed or active job to cancelled and clear its lease; without `history` it only closes an open attempt row.
   * @beta
   */
  async cancel(scope: Scope, req: CancelRequest): Promise<CancelResult> {
    return this.#run('cancel', () => this.#cancel(scope, req));
  }

  /**
   * Set the queue's pause flag (queue state: no job `rev` changes).
   * @beta
   */
  async setPaused(scope: Scope, paused: boolean): Promise<{ changed: boolean }> {
    return this.#run('setPaused', () => {
      checkPaused(paused);
      const { data } = this.#begin('setPaused', scope);
      const changed = data.paused !== paused;
      data.paused = paused;
      if (changed && !paused) this.#wake(data);
      return { changed };
    });
  }

  /**
   * Read the queue's pause flag.
   * @beta
   */
  async isPaused(scope: Scope): Promise<boolean> {
    return this.#run('isPaused', () => this.#begin('isPaused', scope).data.paused);
  }

  /**
   * Counts, the oldest claimable waiting `runAt` (null while paused) and the dead-letter count, in one critical section.
   * @beta
   */
  async stats(scope: Scope, req: Record<string, never>): Promise<StatsResult> {
    return this.#run('stats', () => this.#stats(scope, req));
  }

  /**
   * Create (`expectedRev: null`) or replace a schedule whose `rev` matches; the store stamps scope, `rev` and timestamps.
   * @beta
   */
  async putSchedule(scope: Scope, req: PutScheduleRequest): Promise<PutScheduleResult> {
    return this.#run('putSchedule', () => {
      checkPutSchedule(req);
      const { now, data } = this.#begin('putSchedule', scope);
      return putSchedule(data.schedules, scope, req, now);
    });
  }

  /**
   * One schedule by key, or null.
   * @beta
   */
  async getSchedule(scope: Scope, req: { key: string }): Promise<ScheduleRecord | null> {
    return this.#run('getSchedule', () => {
      checkScheduleKey('getSchedule', req);
      return getSchedule(this.#begin('getSchedule', scope).data.schedules, req.key);
    });
  }

  /**
   * One page of schedules in key order.
   * @beta
   */
  async listSchedules(scope: Scope, req: ListSchedulesRequest): Promise<ListSchedulesResult> {
    return this.#run('listSchedules', () => {
      checkListSchedules(req);
      return listSchedules(this.#begin('listSchedules', scope).data.schedules, req);
    });
  }

  /**
   * Delete a schedule, only when its `rev` matches if `expectedRev` is given.
   * @beta
   */
  async deleteSchedule(scope: Scope, req: DeleteScheduleRequest): Promise<DeleteScheduleResult> {
    return this.#run('deleteSchedule', () => {
      checkDeleteSchedule(req);
      return deleteSchedule(this.#begin('deleteSchedule', scope).data.schedules, req);
    });
  }

  /**
   * One page of a job's attempt records (live or history key), by token; `truncated` is the job's count of records the cap dropped.
   * @beta
   */
  async getAttempts(scope: Scope, req: GetAttemptsRequest): Promise<GetAttemptsResult> {
    return this.#run('getAttempts', () => {
      checkGetAttempts(req);
      const { data } = this.#begin('getAttempts', scope);
      const after = req.cursor === undefined ? 0 : Number(req.cursor);
      const rows = (data.attempts.get(req.id) ?? []).filter((r) => r.token > after);
      const page = rows.slice(0, req.limit ?? 100);
      const truncated = (data.records.get(req.id) ?? data.history.get(req.id))?.attemptsTruncated ?? 0;
      const nextCursor = rows.length > page.length ? String(page.at(-1)!.token) : null;
      return { attempts: structuredClone(page), truncated, nextCursor };
    });
  }

  /**
   * Move failed jobs back to waiting (or delayed by `delayMs`), by ids in request order or by a dead-letter filter,
   * oldest dead letter first. Each job is one conditional write: only a failed job moves; `seq`, `token` and attempt rows stay.
   * @beta
   */
  async redrive(scope: Scope, req: RedriveRequest): Promise<RedriveOutcome[]> {
    return this.#run('redrive', () => this.#redrive(scope, req));
  }

  /**
   * Due schedules by store time, plus the earliest `nextRunAt` of any schedule that is not paused.
   * @beta
   */
  async listDueSchedules(scope: Scope, req: { limit: number }): Promise<ListDueSchedulesResult> {
    return this.#run('listDueSchedules', () => {
      checkListDue(req);
      const { now, data } = this.#begin('listDueSchedules', scope);
      return listDue(data.schedules, req.limit, now);
    });
  }

  /**
   * One tick in one critical section: the overlap read, the job insert and the schedule write.
   * @beta
   */
  async fireSchedule(scope: Scope, req: FireScheduleRequest): Promise<FireScheduleResult> {
    return this.#run('fireSchedule', () => {
      checkFire(req, this.capabilities.limits);
      const { now, data } = this.#begin('fireSchedule', scope);
      checkSafe('fireSchedule', req.job.runAt ?? now + (req.job.delayMs ?? 0), 'job runAt');
      let added = false;
      const res = fire(data.schedules, req, now, {
        insert: (job, scheduledFor) => {
          const o = this.#addOne(scope, data, { ...job, onDuplicate: 'ignore' }, now, []) as Exclude<AddOutcome, { status: 'not-applied' }>;
          if (o.status === 'added') {
            added = true;
            Object.assign(data.records.get(o.job.id)!, { scheduleKey: req.key, scheduledFor });
          }
          return o.job.id;
        },
        stateOf: (id) => data.records.get(id)?.state,
      });
      if (added) this.#wake(data);
      return res;
    });
  }

  /**
   * Delete up to `limit` jobs of one state by the request's mode (age, `retainExpired` or `keepLast`), each with its
   * attempt rows and the superseded records of its id (`id#seq`) that are not dead letters; `retainExpired` also matches
   * those superseded records by their own expiry, and the age mode of `failed` matches superseded dead letters.
   * @beta
   */
  async clean(scope: Scope, req: CleanRequest): Promise<CleanResult> {
    return this.#run('clean', () => {
      checkClean(req);
      const { now, data } = this.#begin('clean', scope);
      // a superseded dead letter is deleted only by a plain clean of failed jobs; retainExpired expires the other superseded records
      const history = [...data.history.values()].filter((h) => (h.deadLetter === null ? req.retainExpired === true : cleansDeadLetters(req)));
      const candidates = history.length > 0 ? [...data.records.values(), ...history] : data.records.values();
      const { pick, remaining } = selectClean(candidates, req, now);
      // the superseded records of each id that go with it (never a dead letter), read once per call
      const superseded = new Map<string, string[]>();
      for (const [key, h] of data.history) {
        const at = key.lastIndexOf('#');
        if (h.deadLetter === null && at > 0 && /^-?\d+$/.test(key.slice(at + 1))) superseded.set(key.slice(0, at), [...(superseded.get(key.slice(0, at)) ?? []), key]);
      }
      // decided before the loop: deleting a live job drops its superseded records, which may come later in the pick
      const historical = new Set(data.history.values());
      for (const rec of pick) {
        if (historical.has(rec)) this.#dropHistory(data, rec.id);
        else {
          this.#deleteJob(scope, data, rec, now);
          for (const key of superseded.get(rec.id) ?? []) this.#dropHistory(data, key);
        }
      }
      return { removed: pick.length, remaining };
    });
  }

  /** Delete one superseded record and its attempt rows. */
  #dropHistory(data: ScopeData, key: string): void {
    data.history.delete(key);
    data.attempts.delete(key);
  }

  /**
   * Delete the whole queue, `limit` jobs per call. The first call checks for active jobs (refused without `force`)
   * and sets the marker; the call that deletes the last job also deletes history, schedules and settings and clears it.
   * The seq and token counters are kept, so a re-added id never reuses a token.
   * @beta
   */
  async obliterate(scope: Scope, req: ObliterateRequest): Promise<ObliterateResult> {
    return this.#run('obliterate', () => {
      checkObliterate(req);
      const { now, data } = this.#begin('obliterate', scope);
      if (!data.obliterating) {
        const active = data.records.byState.active;
        if (active > 0 && !req.force) throw new QueueNotIdleError({ queue: scope.queue, active });
        data.obliterating = true;
      }
      let removed = 0;
      for (const rec of data.records.values()) {
        if (removed === req.limit) return { removed, done: false };
        this.#deleteJob(scope, data, rec, now);
        removed++;
      }
      for (const id of data.history.keys()) data.attempts.delete(id);
      data.history.clear();
      data.schedules.clear();
      data.paused = false;
      data.obliterating = false;
      return { removed, done: true };
    });
  }

  /**
   * Write an active job's progress, fenced by its token.
   * @beta
   */
  async setProgress(scope: Scope, req: SetProgressRequest): Promise<SetProgressResult> { return this.#run('setProgress', () => this.#setProgress(scope, req)); }

  /**
   * Create the namespace's format record at `current`, or raise a readable older one to `current`; never lowers it,
   * and writes nothing when the stored format is outside what the caller reads.
   * @beta
   */
  async ensureNamespaceMeta(ns: NamespaceScope, req: EnsureNamespaceMetaRequest): Promise<EnsureNamespaceMetaResult> {
    return this.#run('ensureNamespaceMeta', () => {
      this.#ready('ensureNamespaceMeta');
      checkNamespace('ensureNamespaceMeta', ns);
      checkEnsureMeta(req);
      const now = this.#tick();
      const data = this.#namespace(ns.namespace);
      const meta = data.meta;
      if (!meta) {
        data.meta = { formatVersion: req.current, createdBy: req.sureqVersion, lastRaisedBy: req.sureqVersion, updatedAt: now };
        return { formatVersion: req.current, created: true, raised: false };
      }
      const raised = meta.formatVersion >= req.minReadable && meta.formatVersion < req.current;
      if (raised) Object.assign(meta, { formatVersion: req.current, lastRaisedBy: req.sureqVersion, updatedAt: now });
      return { formatVersion: meta.formatVersion, created: false, raised };
    });
  }

  /**
   * The namespace's format record, or null when none exists.
   * @beta
   */
  async getNamespaceMeta(ns: NamespaceScope): Promise<StoreMeta | null> {
    return this.#run('getNamespaceMeta', () => {
      this.#ready('getNamespaceMeta');
      checkNamespace('getNamespaceMeta', ns);
      return structuredClone(this.#namespaces.get(ns.namespace)?.meta ?? null);
    });
  }

  /**
   * Create or replace a worker's record; `startedAt` and `lastHeartbeatAt` are store now.
   * @beta
   */
  async registerWorker(ns: NamespaceScope, req: RegisterWorkerRequest): Promise<RegisterWorkerResult> {
    return this.#run('registerWorker', () => {
      checkRegisterWorker(req);
      const { now, workers } = this.#workers('registerWorker', ns);
      return registerWorker(workers, req, now);
    });
  }

  /**
   * Refresh a worker's record at store now; `ok: false` when it is gone.
   * @beta
   */
  async heartbeatWorker(ns: NamespaceScope, req: HeartbeatWorkerRequest): Promise<{ ok: boolean }> {
    return this.#run('heartbeatWorker', () => {
      checkHeartbeatWorker(req);
      const { now, workers } = this.#workers('heartbeatWorker', ns);
      return heartbeatWorker(workers, req, now);
    });
  }

  /**
   * Delete a worker's registry record.
   * @beta
   */
  async unregisterWorker(ns: NamespaceScope, req: { workerId: string }): Promise<void> {
    return this.#run('unregisterWorker', () => {
      checkWorkerId('unregisterWorker', req);
      this.#workers('unregisterWorker', ns).workers.delete(req.workerId);
    });
  }

  /**
   * The namespace's worker records (only those serving `queue` when given) and store now.
   * @beta
   */
  async listWorkers(ns: NamespaceScope, req: { queue?: string }): Promise<ListWorkersResult> {
    return this.#run('listWorkers', () => {
      checkListWorkers(req);
      const { now, workers } = this.#workers('listWorkers', ns);
      return listWorkers(workers, req.queue, now);
    });
  }

  /**
   * Delete up to `limit` records not heard from for `staleIntervals` of their own heartbeat interval.
   * @beta
   */
  async purgeWorkers(ns: NamespaceScope, req: { staleIntervals: number; limit: number }): Promise<{ removed: number }> {
    return this.#run('purgeWorkers', () => {
      checkPurgeWorkers(req);
      const { now, workers } = this.#workers('purgeWorkers', ns);
      return purgeWorkers(workers, req, now);
    });
  }

  /**
   * A hint that claimable work may exist: `onWake` is called (coalesced, after the write) on add, a release to
   * waiting, a sweep requeue and a resume. A throwing `onWake` is ignored. Resolves to an unsubscribe function.
   * @beta
   */
  async subscribe(scope: Scope, onWake: () => void): Promise<() => Promise<void>> {
    return this.#run('subscribe', () => {
      if (typeof onWake !== 'function') bad('subscribe', 'onWake must be a function');
      const { data } = this.#begin('subscribe', scope);
      const sub: Subscriber = { onWake, scheduled: false };
      data.subscribers.add(sub);
      return async () => void data.subscribers.delete(sub);
    });
  }

  /** @internal Deep copy of everything the store holds, for tests only. */
  dump(): StoreSnapshot {
    const meta: Record<string, StoreMeta> = {};
    const jobs: JobRecord[] = [];
    const schedules: ScheduleRecord[] = [];
    const attempts: StoredAttempt[] = [];
    for (const [ns, data] of this.#namespaces) {
      if (data.meta) meta[ns] = structuredClone(data.meta);
      for (const scope of data.queues.values()) {
        for (const rec of [...scope.records.values(), ...scope.history.values()]) jobs.push(structuredClone(rec));
        schedules.push(...structuredClone([...scope.schedules.values()]));
        for (const rows of scope.attempts.values()) attempts.push(...structuredClone(rows));
      }
    }
    return { meta, jobs, attempts, tombstones: structuredClone([...this.#tombstones.values()]), schedules };
  }

  /**
   * @internal Test-only: assign fields on a stored record without validation and without bumping `rev`
   * (a `rev` key sets it verbatim), then re-index the record for its new state, `runAt` and lease.
   * Only the listed record fields may be set; a field the record lacks is added (an unknown future field).
   */
  unsafeMutate(scope: Scope, id: string, patch: Record<string, unknown>): void {
    this.#tick();
    const data = this.#scope(scope);
    const rec = data.records.get(id);
    for (const key of Object.keys(patch)) {
      // a field the record does not have is planted as is, as a later release's record would carry it
      if (!UNSAFE_KEYS.includes(key) && (!rec || Object.hasOwn(rec, key))) {
        throw new InternalError(`unsafeMutate cannot set ${key}`, { details: { key } });
      }
    }
    if (!rec) return;
    const { lease = rec.lease, ...rest } = structuredClone(patch) as { lease?: Lease };
    this.#detach(data, rec);
    const { state = rec.state, ...others } = rest as { state?: JobState };
    data.records.restate(rec, state);
    Object.assign(rec, others);
    this.#index(data, rec);
    if (rec.state === 'active') this.#setLease(data, rec, lease);
    else rec.lease = lease;
  }

  /** The only place that awaits: fault hooks around one synchronous body. */
  async #run<T>(op: StoreOp, body: () => T): Promise<T> {
    await this.#faults?.before?.(op);
    const result = body();
    await this.#faults?.after?.(op);
    return result;
  }

  #add(scope: Scope, jobs: NewJob[], opts: { atomic?: boolean } | undefined): AddOutcome[] {
    checkAdd(jobs, opts, this.capabilities.limits);
    const { now, data } = this.#begin('add', scope);
    for (const job of jobs) {
      if (now + (job.delayMs ?? 0) > Number.MAX_SAFE_INTEGER) bad('add', 'delayMs puts runAt beyond the safe integer range');
    }
    // Inputs run in order against live state, so a later input sees an earlier one; `undo` reverses each write.
    const undo: Array<() => void> = [];
    const outcomes: AddOutcome[] = [];
    for (const [i, job] of jobs.entries()) {
      const outcome = this.#addOne(scope, data, job, now, undo);
      if (opts?.atomic && outcome.status === 'duplicate' && outcome.action === 'rejected') {
        for (const step of undo.reverse()) step();
        return jobs.map((_, k) => (k === i ? outcome : { status: 'not-applied' }));
      }
      outcomes.push(outcome);
    }
    if (outcomes.some((o) => o.status === 'added' || (o.status === 'duplicate' && o.action === 'replaced'))) this.#wake(data);
    return outcomes;
  }

  /**
   * One input of an add: the duplicate rules by id first, then by `singletonKey` (a key conflict never
   * changes the holder), then the insert, moving a finished pending record that owned the id aside.
   */
  #addOne(scope: Scope, data: ScopeData, job: NewJob, now: number, undo: Array<() => void>): AddOutcome {
    const duplicate = (action: 'ignored' | 'replaced' | 'rejected', rec: JobRecord, by: 'id' | 'singletonKey' = 'id', existingState = rec.state): AddOutcome => ({
      status: 'duplicate', action, by, existingState, job: structuredClone(rec),
    });
    const rule = job.onDuplicate ?? 'ignore';
    const holder = findHolder(data, job.id);
    if (holder) {
      if (rule === 'reject') return duplicate('rejected', holder);
      if (rule === 'ignore' || (holder.state !== 'waiting' && holder.state !== 'delayed')) return duplicate('ignored', holder);
      const next = applyReplace(holder, job, now);
      if (Object.hasOwn(job, 'singletonKey') && job.singletonKey !== holder.singletonKey) {
        const key = job.singletonKey ?? null;
        const other = key === null ? undefined : data.holders.get(key);
        if (other !== undefined && other !== holder.id) return duplicate('ignored', data.records.get(other)!, 'singletonKey');
        next.singletonKey = key;
        next.singletonHeld = key !== null;
      }
      this.#swap(data, holder, next);
      undo.push(() => this.#swap(data, next, holder));
      return duplicate('replaced', next, 'id', holder.state);
    }
    const key = job.singletonKey ?? null;
    const keyHolder = key === null ? undefined : data.holders.get(key);
    if (keyHolder !== undefined) return duplicate(rule === 'reject' ? 'rejected' : 'ignored', data.records.get(keyHolder)!, 'singletonKey');
    const old = data.records.get(job.id);
    if (old) {
      const untomb = this.#leaveTombstone(scope, old, job.id, now);
      supersede(data, old);
      undo.push(() => {
        unsupersede(data, old, job.id);
        untomb();
      });
    }
    const runAt = job.runAt ?? now + (job.delayMs ?? 0);
    const rec: JobRecord = {
      // first, so no default overwrites a field this job sets
      ...NEW_RECORD_DEFAULTS,
      formatVersion: job.formatVersion,
      namespace: scope.namespace,
      queue: scope.queue,
      id: job.id,
      name: job.name ?? null,
      data: structuredClone(job.data),
      dataVersion: job.dataVersion ?? null,
      state: runAt > now ? 'delayed' : 'waiting',
      priority: job.priority ?? 0,
      seq: job.first ? --data.lowSeq : ++data.nextSeq,
      runAt,
      attempt: 0,
      maxAttempts: job.maxAttempts,
      crashCount: 0,
      lease: null,
      token: 0,
      lastFinal: null,
      result: null,
      error: null,
      backoff: structuredClone(job.backoff ?? null),
      timeout: structuredClone(job.timeout ?? null),
      idempotencyKey: job.idempotencyKey ?? null,
      workerId: null,
      uniqueWhile: job.uniqueWhile ?? 'pending',
      singletonKey: key,
      singletonHeld: key !== null,
      rev: 1,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      keep: structuredClone(job.keep ?? null),
    };
    data.records.set(rec.id, rec);
    this.#index(data, rec);
    if (key !== null) data.holders.set(key, rec.id);
    undo.push(() => {
      this.#unindex(data, rec);
      releaseHold(data, rec);
      data.records.delete(rec.id);
    });
    return { status: 'added', job: structuredClone(rec) };
  }

  /** Put `to` in place of the waiting or delayed record `from` (same id), indexes and key hold included; `from` is left as it was. */
  #swap(data: ScopeData, from: JobRecord, to: JobRecord): void {
    this.#unindex(data, from);
    if (from.singletonHeld && data.holders.get(from.singletonKey!) === from.id) data.holders.delete(from.singletonKey!);
    data.records.set(to.id, to);
    this.#index(data, to);
    if (to.singletonHeld) data.holders.set(to.singletonKey!, to.id);
  }

  #get(scope: Scope, id: string): JobRecord | null {
    checkId('get', id);
    const rec = this.#begin('get', scope).data.records.get(id);
    return rec ? out(rec) : null;
  }

  #list(scope: Scope, req: ListRequest): JobRecord[] {
    checkList(req);
    const { now, data } = this.#begin('list', scope);
    const key = req.orderBy ?? 'seq';
    const dir = req.order === 'asc' ? 1 : -1;
    const value = (r: JobRecord): number => (key === 'deadLetterAt' ? r.deadLetter?.at : r[key]) ?? -Infinity;
    const dead = req.deadLetter;
    // a superseded dead letter is listed by the dead-letter filter, under its history key
    return [...data.records.values(), ...(dead ? data.history.values() : [])]
      .filter((r) => r.state === req.state && (req.name === undefined || r.name === req.name) && (!dead || isDeadLetter(r, dead, now)))
      .sort((a, b) => dir * (value(a) - value(b) || a.seq - b.seq))
      .slice(req.offset, req.offset + req.limit)
      .map(out);
  }

  #counts(scope: Scope): JobCounts {
    const { data } = this.#begin('counts', scope);
    const counts = data.records.byState;
    return { ...counts, blocked: data.paused ? counts.waiting : 0 };
  }

  #stats(scope: Scope, req: Record<string, never>): StatsResult {
    checkStats(req);
    const { now, data } = this.#begin('stats', scope);
    const counts = data.records.byState;
    let oldest: number | null = null;
    let deadLetters = 0;
    // ponytail: O(jobs in the queue) scan per stats call; keep a runAt-ordered waiting index and a dead-letter counter if stats on large memory queues shows up in profiles
    for (const rec of data.records.values()) {
      if (rec.state === 'waiting' && !data.paused && (oldest === null || rec.runAt < oldest)) oldest = rec.runAt;
      else if (rec.state === 'failed' && rec.deadLetter !== null) deadLetters++;
    }
    // a superseded dead letter is a dead letter still
    for (const rec of data.history.values()) if (rec.state === 'failed' && rec.deadLetter !== null) deadLetters++;
    return { counts: { ...counts, blocked: data.paused ? counts.waiting : 0 }, oldestWaitingRunAt: oldest, deadLetters, now };
  }

  #claim(scope: Scope, req: ClaimRequest): ClaimResult {
    checkClaim(req, this.capabilities.limits);
    const { now, data } = this.#begin('claim', scope);
    const byName = req.leaseMsByName ?? {};
    let longest = req.leaseMs;
    for (const ms of Object.values(byName)) if (ms > longest) longest = ms;
    checkSafe('claim', now + longest, 'leaseMs puts expiresAt');
    const nextRunAt = data.delayed.peek()?.runAt ?? null;
    const mine = [...(data.claims.get(`${req.workerId}\u0000${req.claimId}`) ?? [])]
      .map((id) => data.records.get(id)!)
      .filter((rec) => rec.lease!.expiresAt > now);
    if (mine.length > 0) return { jobs: mine.map((rec) => structuredClone(rec)), now, nextRunAt, paused: false, recovered: true };
    const names = req.names ?? [...data.names.keys()];
    if (data.paused) {
      // Blocked only when the pause holds back a job this claim could take; an empty queue is not blocked.
      // ponytail: with maxFormat this scans the queue's records; paused claims poll slowly, so it stays cheap
      const held = req.maxFormat === undefined
        ? names.some((n) => (data.names.get(n)?.levels.length ?? 0) > 0)
        : [...data.records.values()].some((r) => r.state === 'waiting' && names.includes(r.name) && r.formatVersion <= req.maxFormat!);
      return held ? { jobs: [], now, nextRunAt, paused: true, blocked: { reason: 'paused' } } : { jobs: [], now, nextRunAt, paused: false };
    }
    const order = req.order ?? 'fifo';
    const jobs: JobRecord[] = [];
    const setAside: JobRecord[] = [];
    while (jobs.length < req.limit) {
      const id = this.#bestHead(data, names, order);
      if (id === undefined) break;
      const rec = data.records.get(id)!;
      this.#unindex(data, rec);
      if (rec.state !== 'waiting') continue; // a stale index entry: not claimable, drop it
      if (!this.#claimable(rec, req.maxFormat)) {
        setAside.push(rec);
        continue;
      }
      this.#moveTo(data, rec, 'active');
      releaseHold(data, rec);
      rec.attempt += 1;
      rec.startedAt = now;
      rec.progress = null;
      rec.batchProgress = null;
      rec.workerId = req.workerId;
      rec.token = ++data.lastToken;
      const leaseMs = rec.name !== null && Object.hasOwn(byName, rec.name) ? byName[rec.name]! : req.leaseMs;
      this.#setLease(data, rec, { owner: req.workerId, token: rec.token, expiresAt: now + leaseMs, claimId: req.claimId, ...(req.hold && { held: true }) });
      rec.lastFinal = null;
      if (req.history !== false) rec.attemptsTruncated += openAttempt(this.#rows(data, rec.id), rec, now, req.workerId, req.history);
      rec.rev += 1;
      jobs.push(structuredClone(rec));
    }
    for (const rec of setAside) this.#index(data, rec);
    return { jobs, now, nextRunAt, paused: false };
  }

  /** Start a finalising write: the store time, the scope data and the fence verdict (a pass carries the record). */
  #fenced(op: StoreOp, scope: Scope, req: { id: string; token: number }, kind: FinalKind): { now: number; data: ScopeData; verdict: Verdict<JobRecord> } {
    const { now, data } = this.#begin(op, scope);
    const rec = data.records.get(req.id);
    const tombstone = this.#tombstones.get(tombstoneKey(scope, req.id));
    return { now, data, verdict: fence({ rec, tombstone, token: req.token, kind, now }) };
  }

  #renew(scope: Scope, req: RenewRequest): RenewResult {
    checkRenew(req);
    const { now, data } = this.#begin('renew', scope);
    if (req.started) this.#writable(scope, data);
    const verdict = fence({ rec: data.records.get(req.id), tombstone: undefined, token: req.token, kind: null, now });
    if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
    const { rec } = verdict;
    const expiresAt = now + req.leaseMs;
    checkSafe('renew', expiresAt, 'leaseMs puts expiresAt');
    const { held: _held, ...lease } = rec.lease!;
    this.#setLease(data, rec, { ...(req.started ? lease : rec.lease!), expiresAt });
    noteRenew(data.attempts.get(rec.id), req.token, now, req.started ? req.batchId : undefined);
    rec.rev += 1;
    return { ok: true, expiresAt, now };
  }

  #setProgress(scope: Scope, req: SetProgressRequest): SetProgressResult {
    checkSetProgress(req);
    const { now, data } = this.#begin('setProgress', scope);
    const verdict = fence({ rec: data.records.get(req.id), tombstone: undefined, token: req.token, kind: null, now });
    if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
    verdict.rec[req.field ?? 'progress'] = { value: structuredClone(req.progress), updatedAt: now };
    verdict.rec.rev += 1;
    return { ok: true, now };
  }

  #complete(scope: Scope, req: CompleteRequest): CompleteResult {
    checkComplete(req);
    const { now, data, verdict } = this.#fenced('complete', scope, req, 'complete');
    if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
    if (verdict.verdict === 'repeat') return { ok: true, now, repeated: true };
    const { rec } = verdict;
    checkRetain('complete', now, req.retention);
    this.#close(data, rec, req.token, now, { outcome: 'completed', endedBy: 'worker', error: null }, req.history);
    this.#setLease(data, rec, null);
    this.#moveTo(data, rec, 'completed');
    rec.result = structuredClone(req.result);
    rec.finishedAt = now;
    rec.lastFinal = { token: req.token, kind: 'complete', state: 'completed' };
    rec.rev += 1;
    this.#retain(scope, data, rec, now, req.retention);
    return { ok: true, now };
  }

  #fail(scope: Scope, req: FailRequest): FailResult {
    checkFail(req);
    const { now, data, verdict } = this.#fenced('fail', scope, req, 'fail');
    if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
    if (verdict.verdict === 'repeat') {
      const { state, runAt } = verdict.outcome;
      return { ok: true, state: state as 'delayed' | 'failed', ...(runAt !== undefined && { runAt }), now, repeated: true };
    }
    const { rec } = verdict;
    const retry = req.retryInMs !== undefined && rec.attempt < rec.maxAttempts;
    if (retry) checkSafe('fail', now + req.retryInMs!, 'retryInMs puts runAt');
    checkKeep('fail', now, req.deadLetter);
    checkRetain('fail', now, req.retention);
    this.#close(data, rec, req.token, now, { outcome: 'failed', endedBy: 'worker', error: req.error }, req.history);
    this.#setLease(data, rec, null);
    rec.error = structuredClone(req.error);
    rec.rev += 1;
    if (retry) {
      this.#moveTo(data, rec, 'delayed');
      rec.runAt = now + req.retryInMs!;
      this.#index(data, rec);
      takeOrSkipHold(data, rec);
      rec.lastFinal = { token: req.token, kind: 'fail', state: 'delayed', runAt: rec.runAt };
      return { ok: true, state: 'delayed', runAt: rec.runAt, now };
    }
    markDeadLetter(rec, now, req.deadLetter, req.deadLetter ? req.deadLetter.reason ?? 'exhausted' : 'exhausted');
    this.#moveTo(data, rec, 'failed');
    rec.finishedAt = now;
    rec.lastFinal = { token: req.token, kind: 'fail', state: 'failed' };
    this.#retain(scope, data, rec, now, req.retention);
    return { ok: true, state: 'failed', now };
  }

  #release(scope: Scope, req: ReleaseRequest): ReleaseResult {
    checkRelease(req);
    const { now, data, verdict } = this.#fenced('release', scope, req, 'release');
    if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
    if (verdict.verdict === 'repeat') {
      const { state, runAt } = verdict.outcome;
      return { ok: true, state: state as 'waiting' | 'delayed', runAt: runAt!, now, repeated: true };
    }
    const { rec } = verdict;
    const delayMs = req.delayMs ?? 0;
    checkSafe('release', now + delayMs, 'delayMs puts runAt');
    const state = delayMs > 0 ? 'delayed' : 'waiting';
    this.#close(data, rec, req.token, now, { outcome: 'released', endedBy: 'shutdown', error: null }, req.history);
    this.#setLease(data, rec, null);
    this.#moveTo(data, rec, state);
    rec.runAt = now + delayMs;
    if (req.refundAttempt) rec.attempt -= 1;
    rec.lastFinal = { token: req.token, kind: 'release', state, runAt: rec.runAt };
    rec.rev += 1;
    this.#index(data, rec);
    takeOrSkipHold(data, rec);
    if (state === 'waiting') this.#wake(data);
    return { ok: true, state, runAt: rec.runAt, now };
  }

  #sweep(scope: Scope, req: SweepRequest): SweepResult {
    checkSweep(req, this.capabilities.limits);
    const { now, data } = this.#begin('sweep', scope);
    checkKeep('sweep', now, req.deadLetter);
    checkRetain('sweep', now, req.retention);
    const swept: SweptJob[] = [];
    const setAside: Array<{ runAt: number; id: string }> = [];
    for (let top = data.leases.peek(); top && top.runAt <= now && swept.length < req.limit; top = data.leases.peek()) {
      // The lease heap holds exactly the active jobs' leases (#setLease keeps it in step).
      const rec = data.records.get(top.id)!;
      if (req.maxFormat !== undefined && rec.formatVersion > req.maxFormat) {
        setAside.push(data.leases.pop()!); // a newer pod's job: left for a pod that reads it
        continue;
      }
      const { owner: previousOwner, held } = rec.lease!;
      // A held job's handler never ran, so its row closes as a give-back, not a crash.
      this.#close(data, rec, rec.token, now, { outcome: held ? 'released' : 'crashed', endedBy: 'sweeper', error: null }, req.history);
      this.#setLease(data, rec, null);
      // A held job never reached its handler: its expiry gives the attempt back and is no crash.
      if (held) rec.attempt -= 1;
      else rec.crashCount += 1;
      const poison = !held && rec.crashCount >= req.maxCrashes;
      const failed = poison || (!held && rec.attempt >= rec.maxAttempts);
      if (failed) {
        markDeadLetter(rec, now, req.deadLetter, poison ? 'crashLimit' : 'exhausted');
        this.#moveTo(data, rec, 'failed');
        rec.finishedAt = now;
        rec.error = structuredClone(poison ? req.poisonError : req.failError);
      } else {
        this.#moveTo(data, rec, 'waiting');
        rec.runAt = now;
        this.#index(data, rec);
        takeOrSkipHold(data, rec);
      }
      rec.lastFinal = null;
      rec.rev += 1;
      if (failed) this.#retain(scope, data, rec, now, req.retention);
      const { id, token, attempt, crashCount } = rec;
      swept.push({ id, token, previousOwner, action: failed ? 'failed' : 'requeued', attempt, crashCount });
    }
    for (const top of setAside) data.leases.push(top.runAt, top.id);
    if (swept.some((j) => j.action === 'requeued')) this.#wake(data);
    return { swept, now };
  }

  #redrive(scope: Scope, req: RedriveRequest): RedriveOutcome[] {
    checkRedrive(req);
    const { now, data } = this.#begin('redrive', scope);
    const delayMs = req.delayMs ?? 0;
    checkSafe('redrive', now + delayMs, 'delayMs puts runAt');
    // the filter form passes superseded dead letters by: they can never move, so they must not fill a page
    const ids = req.ids ?? [...data.records.values()].filter((r) => isDeadLetter(r, req.filter!, now)).sort(byDeadLetterAt).slice(0, req.limit).map((r) => r.id);
    const outcomes = ids.map((id): RedriveOutcome => {
      const rec = data.records.get(id);
      if (!rec) return { id, status: 'skipped', reason: data.history.has(id) ? 'duplicate-id' : 'not-found' };
      if (rec.state !== 'failed') return { id, status: 'skipped', reason: 'not-failed' };
      const viaDeadLetter = rec.deadLetter !== null;
      const state = delayMs > 0 ? 'delayed' : 'waiting';
      this.#moveTo(data, rec, state);
      Object.assign(rec, { runAt: now + delayMs, deadLetter: null, retainUntil: null, finishedAt: null, progress: null, batchProgress: null, lastError: rec.error });
      rec.redriveCount += 1;
      if (req.priority !== undefined) rec.priority = req.priority;
      if (req.resetAttempts !== false) Object.assign(rec, { attempt: 0, crashCount: 0 });
      rec.rev += 1;
      this.#index(data, rec);
      takeOrSkipHold(data, rec);
      return { id, status: 'redriven', state, viaDeadLetter };
    });
    if (outcomes.some((o) => o.status === 'redriven' && o.state === 'waiting')) this.#wake(data);
    return outcomes;
  }

  /** False for a record whose format stamp is broken or newer than `maxFormat`; claim skips it and leaves it as it was. */
  #claimable(rec: JobRecord, maxFormat: number | undefined): boolean {
    try {
      checkStamp('job', rec);
    } catch (err) {
      if (!(err instanceof StoreFormatError)) throw err;
      return false;
    }
    return maxFormat === undefined || rec.formatVersion <= maxFormat;
  }

  /** The id of the best claimable job across `names`, or undefined when none is waiting. */
  #bestHead(data: ScopeData, names: Array<string | null>, order: 'fifo' | 'lifo'): string | undefined {
    let best: { priority: number; seq: number; id: string } | undefined;
    for (const name of names) {
      const idx = data.names.get(name);
      const priority = idx?.levels[0];
      if (priority === undefined) continue;
      const bucket = idx!.buckets.get(priority)!;
      const head = order === 'fifo' ? bucket.min() : bucket.max();
      if (!head) continue;
      const better =
        !best || priority > best.priority || (priority === best.priority && (order === 'fifo' ? head.key < best.seq : head.key > best.seq));
      if (better) best = { priority, seq: head.key, id: head.value };
    }
    return best?.id;
  }

  #update(scope: Scope, req: UpdateRequest): UpdateResult {
    checkUpdate(req);
    const { now, data } = this.#begin('update', scope);
    const rec = data.records.get(req.id);
    if (!rec) return { ok: false, reason: 'not-found' };
    if (rec.state !== 'waiting' && rec.state !== 'delayed') return { ok: false, reason: 'not-editable' };
    if (rec.rev !== req.expectedRev) return { ok: false, reason: 'conflict' };
    const { patch } = req;
    const runAt = patch.runAt ?? (patch.delayMs === undefined ? undefined : now + patch.delayMs);
    if (runAt !== undefined && runAt > Number.MAX_SAFE_INTEGER) bad('update', 'delayMs puts runAt beyond the safe integer range');
    this.#unindex(data, rec);
    if (patch.data !== undefined) rec.data = structuredClone(patch.data);
    if (patch.priority !== undefined) rec.priority = patch.priority;
    if (runAt !== undefined) {
      rec.runAt = runAt;
      const to = runAt > now ? 'delayed' : 'waiting';
      if (rec.state !== to) this.#moveTo(data, rec, to);
    }
    rec.rev += 1;
    this.#index(data, rec);
    return { ok: true, job: structuredClone(rec) };
  }

  #remove(scope: Scope, req: { id: string }): RemoveResult {
    checkIdRequest('remove', req);
    const { now, data } = this.#begin('remove', scope);
    const rec = data.records.get(req.id);
    if (!rec) {
      // a superseded dead letter is removed by its history key
      const old = data.history.get(req.id);
      if (!old || old.deadLetter === null) return { removed: false, reason: 'not-found' };
      this.#dropHistory(data, req.id);
      return { removed: true, previousState: old.state };
    }
    if (rec.state === 'active') return { removed: false, reason: 'active' };
    this.#deleteJob(scope, data, rec, now);
    return { removed: true, previousState: rec.state };
  }

  /** The single job deletion: out of every index and its key hold, record and attempt rows gone, a tombstone from `lastFinal`. */
  #deleteJob(scope: Scope, data: ScopeData, rec: JobRecord, now: number): void {
    this.#detach(data, rec);
    releaseHold(data, rec);
    data.records.delete(rec.id);
    data.attempts.delete(rec.id);
    this.#leaveTombstone(scope, rec, rec.id, now);
  }

  /**
   * A tombstone from `rec.lastFinal` under `id`, so a repeat of the job's last write still answers once the id is gone or
   * taken by a new job. Returns the undo. A job finished longer than finalsTtl ago gets no repeat any more, so none.
   */
  #leaveTombstone(scope: Scope, rec: JobRecord, id: string, now: number): () => void {
    if (!rec.lastFinal || (rec.finishedAt !== null && rec.finishedAt + this.#finalsTtl <= now)) return () => {};
    const { token, ...outcome } = rec.lastFinal;
    const key = tombstoneKey(scope, id);
    const before = this.#tombstones.get(key);
    this.#tombstones.delete(key); // re-insert so the map stays ordered by expiry
    this.#tombstones.set(key, { ...scope, id, seq: rec.seq, token, outcome, expiresAt: now + this.#finalsTtl });
    return () => {
      this.#tombstones.delete(key);
      if (before) this.#tombstones.set(key, before);
    };
  }

  #cancel(scope: Scope, req: CancelRequest): CancelResult {
    checkCancel(req);
    const { now, data } = this.#begin('cancel', scope);
    const rec = data.records.get(req.id);
    if (!rec) return { ok: false, reason: 'not-found' };
    const previousState = rec.state;
    if (isTerminal(previousState)) return { ok: false, reason: 'already-terminal', state: previousState };
    checkRetain('cancel', now, req.retention);
    if (previousState === 'active') {
      const end: AttemptEnd = { outcome: 'cancelled', endedBy: 'cancel', error: null };
      // no `history`: close the open row if there is one, with no cap and no new row
      if (req.history === undefined) closeOpenAttempt(data.attempts.get(rec.id), rec.token, now, end);
      else this.#close(data, rec, rec.token, now, end, req.history);
    }
    this.#detach(data, rec);
    releaseHold(data, rec);
    this.#moveTo(data, rec, 'cancelled');
    rec.finishedAt = now;
    rec.cancelReason = 'user';
    rec.rev += 1;
    this.#retain(scope, data, rec, now, req.retention);
    return { ok: true, previousState: previousState as 'waiting' | 'delayed' | 'active' };
  }

  /**
   * The `retention` ext of a write that just finished `rec` (after `lastFinal` is set, so a deleted job's repeat still
   * answers): `discard` deletes it, `retainMs` sets `retainUntil`, neither clears it. A dead letter keeps its own `retainUntil`.
   */
  #retain(scope: Scope, data: ScopeData, rec: JobRecord, now: number, ext: RetentionDirective | undefined): void {
    if (rec.deadLetter !== null) return;
    if (ext?.discard) this.#deleteJob(scope, data, rec, now);
    else rec.retainUntil = ext?.retainMs === undefined ? null : now + ext.retainMs;
  }

  /** A job's attempt rows, created empty on first use. */
  #rows(data: ScopeData, id: string): StoredAttempt[] {
    let rows = data.attempts.get(id);
    if (!rows) data.attempts.set(id, (rows = []));
    return rows;
  }

  /** Close the attempt `token` in the same step as the closer's job change; before the closer edits `runAt`, `attempt` or the lease. */
  #close(data: ScopeData, rec: JobRecord, token: number, now: number, end: AttemptEnd, ext: HistoryExt): void {
    if (ext === false) return;
    rec.attemptsTruncated += closeAttempt(this.#rows(data, rec.id), rec, token, now, end, ext);
  }

  /** Take a record out of every index: its bucket, the delayed heap, the lease heap and the claim map. */
  #detach(data: ScopeData, rec: JobRecord): void {
    this.#unindex(data, rec);
    this.#setLease(data, rec, null);
  }

  /** The single place that edits `rec.lease` together with the lease-expiry heap and the claim map. */
  #setLease(data: ScopeData, rec: JobRecord, lease: Lease): void {
    data.leases.remove(rec.id);
    if (lease && rec.lease && claimKey(lease) === claimKey(rec.lease)) {
      // same claim (a renew): keep the job's place in the claim, so a repeated claim returns the same order
      rec.lease = lease;
      data.leases.push(lease.expiresAt, rec.id);
      return;
    }
    if (rec.lease) {
      const key = claimKey(rec.lease);
      const ids = data.claims.get(key);
      ids?.delete(rec.id);
      if (ids?.size === 0) data.claims.delete(key);
    }
    rec.lease = lease;
    if (!lease) return;
    data.leases.push(lease.expiresAt, rec.id);
    const key = claimKey(lease);
    const ids = data.claims.get(key) ?? new Set<string>();
    data.claims.set(key, ids.add(rec.id));
  }

  /** Schedule one `onWake` per subscriber that is not already scheduled. */
  #wake(data: ScopeData): void {
    for (const sub of data.subscribers) {
      if (sub.scheduled) continue;
      sub.scheduled = true;
      queueMicrotask(() => {
        sub.scheduled = false;
        if (!data.subscribers.has(sub)) return;
        try {
          sub.onWake();
        } catch {
          // a wake is only a hint; a broken subscriber must not affect the store
        }
      });
    }
  }

  #ready(op: StoreOp): void {
    if (!this.#opened) bad(op, 'the store is not open');
  }

  /** Start a scoped operation: open check, scope check, one clock read, the scope's data. */
  #begin(op: StoreOp, scope: Scope): { now: number; data: ScopeData } {
    this.#ready(op);
    checkScope(op, scope);
    const now = this.#tick();
    const data = this.#scope(scope);
    if (MARKED.has(op)) this.#writable(scope, data);
    this.#promote(data, now);
    return { now, data };
  }

  /** Start a namespace-wide registry operation: open check, scope check, one clock read, the namespace's records. */
  #workers(op: StoreOp, ns: NamespaceScope): { now: number; workers: WorkerTable } {
    this.#ready(op);
    checkNamespace(op, ns);
    return { now: this.#tick(), workers: this.#namespace(ns.namespace).workers };
  }

  #writable(scope: Scope, data: ScopeData): void {
    if (data.obliterating) throw new QueueObliteratingError({ queue: scope.queue });
  }

  /** Move every due delayed job to waiting at its original `seq`; `rev` is untouched (a read-time effect). */
  #promote(data: ScopeData, now: number): void {
    for (let top = data.delayed.peek(); top && top.runAt <= now; top = data.delayed.peek()) {
      data.delayed.pop();
      const rec = data.records.get(top.id);
      if (rec?.state !== 'delayed' || rec.runAt !== top.runAt) continue;
      this.#moveTo(data, rec, 'waiting');
      this.#index(data, rec);
    }
  }

  /** Put a waiting job in its name/priority bucket, or a delayed job on the delayed heap. */
  #index(data: ScopeData, rec: JobRecord): void {
    if (rec.state === 'delayed') {
      data.delayed.remove(rec.id);
      data.delayed.push(rec.runAt, rec.id);
      return;
    }
    if (rec.state !== 'waiting') return;
    let byName = data.names.get(rec.name);
    if (!byName) {
      byName = { levels: [], buckets: new Map() };
      data.names.set(rec.name, byName);
    }
    let bucket = byName.buckets.get(rec.priority);
    if (!bucket) {
      bucket = new OrderedIndex<string>();
      byName.buckets.set(rec.priority, bucket);
      insertDesc(byName.levels, rec.priority);
    }
    bucket.insert(rec.seq, rec.id);
  }

  /** Take a record out of its bucket and the delayed heap, using its current name, priority and seq. */
  #unindex(data: ScopeData, rec: JobRecord): void {
    data.delayed.remove(rec.id);
    const byName = data.names.get(rec.name);
    const bucket = byName?.buckets.get(rec.priority);
    if (!byName || !bucket) return;
    bucket.delete(rec.seq);
    if (bucket.size === 0) {
      byName.buckets.delete(rec.priority);
      byName.levels.splice(byName.levels.indexOf(rec.priority), 1);
    }
  }

  /** Read the clock once, as an integer clamped so it never goes backwards, and drop expired tombstones. */
  #tick(): number {
    this.#last = Math.max(this.#last, Math.floor(this.#clock()));
    for (const [key, t] of this.#tombstones) {
      if (t.expiresAt > this.#last) break;
      this.#tombstones.delete(key);
    }
    return this.#last;
  }

  /** One namespace's data, created empty (no meta record) on first use. */
  #namespace(name: string): NamespaceData {
    let ns = this.#namespaces.get(name);
    if (!ns) this.#namespaces.set(name, (ns = { meta: null, queues: new Map(), workers: new Map() }));
    return ns;
  }

  /** The data for one scope, creating it on first use. */
  #scope(scope: Scope): ScopeData {
    const ns = this.#namespace(scope.namespace);
    let data = ns.queues.get(scope.queue);
    if (!data) {
      data = {
        records: new RecordMap(), history: new Map(), attempts: new Map(), holders: new Map(), names: new Map(), delayed: new DelayedHeap(), leases: new DelayedHeap(), claims: new Map(),
        nextSeq: 0, lowSeq: 0, lastToken: 0, paused: false, obliterating: false, subscribers: new Set(), schedules: new Map(),
      };
      ns.queues.set(scope.queue, data);
    }
    return data;
  }

  /** The single place that assigns a job's state; refuses any transition the state table forbids. */
  #moveTo(data: ScopeData, rec: JobRecord, to: JobState): void {
    if (!canMove(rec.state, to)) {
      throw new InternalError(`Illegal job state transition ${rec.state} -> ${to}`, { details: { jobId: rec.id, from: rec.state, to } });
    }
    data.records.restate(rec, to);
  }
}
