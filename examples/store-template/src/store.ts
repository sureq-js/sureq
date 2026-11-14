// The template store: the SureQ store contract on top of a tiny backend (methods not built yet are in pending.ts).
//
// Three comment tags run through this file, and the tests check them:
//   SUREQ-CONTRACT: <method>  opens each method's block. WHY: lines under it state the rule the method keeps.
//   WHY:                      the reason for a line or a step, so you know what you may change when you port it.
//   REPLACE-ME:               a real database uses another primitive here; the line names the SQL, Redis and Mongo one.
//                             Everything without this tag you can keep as it is.
//
// Rules that hold in every method:
//   1. One `transact` per call, and every read and write of the call happens inside it.
//   2. Time is read once per call, inside the transaction, from `backend.serverNow()`. Never from this process.
//   3. Requests are checked before anything is read or written; a bad request throws `StoreRequestError`.
//   4. Records come out of the backend as copies, so a method can edit what it read and `put` it back.
import {
  CapabilityError, defineCapabilities, STORE_CONTRACT_VERSION,
  type AddOutcome, type CancelRequest, type CancelResult, type CleanRequest, type CleanResult, type ObliterateRequest, type ObliterateResult, type ClaimRequest, type ClaimResult, type CompleteRequest, type CompleteResult,
  type DeleteScheduleRequest, type DeleteScheduleResult, type EnsureNamespaceMetaRequest, type EnsureNamespaceMetaResult, type FailRequest,
  type FailResult, type FireScheduleRequest, type FireScheduleResult, type GetAttemptsRequest, type GetAttemptsResult, type JobCounts,
  type JobRecord, type JobState, type ListDueSchedulesResult, type ListRequest, type ListSchedulesRequest, type ListSchedulesResult,
  type HeartbeatWorkerRequest, type ListWorkersResult, type NamespaceScope, type NewJob, type PutScheduleRequest, type PutScheduleResult,
  type RedriveOutcome, type RedriveRequest, type RegisterWorkerRequest, type RegisterWorkerResult, type ReleaseRequest, type ReleaseResult,
  type RemoveResult, type RenewRequest, type RenewResult, type ScheduleRecord, type Scope, type SetProgressRequest, type SetProgressResult,
  type StatsResult, type Store, type StoreMeta, type SweepRequest, type SweepResult, type SweptJob, type UpdateRequest, type UpdateResult,
} from '@sureq/core';
import { assertWritable, checkClean, checkObliterate, cleanTx, deleteJob, leaveTombstone, obliterateTx, stats, tombKey } from './admin.js';
import type { TemplateBackend, Tx } from './backend.js';
import { fenceCheck, type FinalKind, type Verdict } from './fence.js';
import { checkGetAttempts, closeAttempt, closeOpenAttempt, historyOf, noteRenew, openAttempt, pageAttempts } from './attempts.js';
import { ensureNamespaceMeta, getNamespaceMeta } from './namespace.js';
import { withPending, type PendingOp } from './pending.js';
import { checkRedrive, deadLetterFilter, deadLetterOf, listScan, markDeadLetter, redrive, removeSuperseded, takeOrSkipKey } from './dlq.js';
import { applyReplace } from './replace.js';
import { finish, retentionOf } from './retention.js';
import { deleteSchedule, fireSchedule, getSchedule, listDueSchedules, listSchedules, putSchedule } from './schedules.js';
import { heartbeatWorker, inNamespace, listWorkers, purgeWorkers, registerWorker, unregisterWorker } from './workers.js';
import { bad, bool, check, checkJob, FENCED, int, isObj, oneOf, optPayload, optText, payload, safeAt, SCOPE, text } from './check.js';

export interface TemplateStoreOptions { backend: TemplateBackend }

const STATES: readonly JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];
const MAX_LIST_LIMIT = 1000;
/** The writes an obliterating queue refuses (renew only when it starts a held job). */
const MARKED = new Set(['add', 'claim', 'sweep', 'redrive', 'setProgress', 'fireSchedule', 'putSchedule']);
const isFinished = (s: JobState): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';

/** An atomic add that met a rejected duplicate throws this to roll the whole transaction back. */
class Rollback {
  constructor(readonly outcomes: AddOutcome[]) {}
}

export const createTemplateStore = (opts: TemplateStoreOptions): Store => withPending(new TemplateStore(opts.backend));

class TemplateStore implements Omit<Store, PendingOp> {
  readonly contractVersion = STORE_CONTRACT_VERSION;
  readonly capabilities = defineCapabilities({ transactions: true, skipLocked: true, notify: false, ttl: false, durable: true, shared: false });
  readonly #backend: TemplateBackend;
  #opened = false;

  constructor(backend: TemplateBackend) { this.#backend = backend; }

  /*
   * SUREQ-CONTRACT: open
   * WHY: core calls open before any other method; calling it twice must be harmless.
   * WHY: this is where an adapter connects and checks its schema, so a wrong database fails here, not on a claim.
   */
  async open(): Promise<void> {
    // REPLACE-ME: connect and check the schema: SQL pool and migration check, Redis PING and load scripts, Mongo connect and indexes.
    await this.#backend.transact(() => undefined);
    this.#opened = true;
  }

  /*
   * SUREQ-CONTRACT: close
   * WHY: after close every call throws StoreRequestError, and close twice is harmless; the data stays.
   */
  async close(): Promise<void> {
    // REPLACE-ME: release the connection here: SQL pool.end(), Redis quit(), Mongo client.close().
    this.#opened = false;
  }

  /*
   * SUREQ-CONTRACT: now
   * WHY: the store's clock is the only clock for leases and delays; it is an integer and never goes backwards.
   */
  async now(): Promise<number> {
    this.#ready('now');
    return this.#backend.transact(() => (this.#ready('now'), this.#backend.serverNow()));
  }

  /*
   * SUREQ-CONTRACT: add
   * WHY: the whole call is one transaction, and inputs run in order, so a later input sees an earlier one.
   * WHY: a duplicate by id is decided first (onDuplicate), then a held singletonKey; neither changes the holder.
   * WHY: with `atomic`, one rejected duplicate writes nothing; every other input answers `not-applied`.
   */
  async add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    const { maxIdBytes } = this.capabilities.limits;
    check('add', 'opts', opts ?? {}, { atomic: bool });
    if (!Array.isArray(jobs)) bad('add', 'jobs must be an array');
    for (const job of jobs) checkJob('add', job, maxIdBytes);
    // WHY: an atomic add needs a real transaction; a store without one must say so instead of pretending.
    if (opts?.atomic && !this.capabilities.transactions) throw new CapabilityError('transactions');
    try {
      return await this.#run('add', scope, (tx, now) => {
        const outcomes: AddOutcome[] = [];
        for (const [i, job] of jobs.entries()) {
          safeAt('add', now + (job.delayMs ?? 0), 'delayMs puts runAt');
          const outcome = this.#addOne(tx, scope, job, now);
          if (opts?.atomic && outcome.status === 'duplicate' && outcome.action === 'rejected') {
            // WHY: throwing makes the backend roll back every write of this call; the answer is built from the throw.
            throw new Rollback(jobs.map((_, k) => (k === i ? outcome : { status: 'not-applied' })));
          }
          outcomes.push(outcome);
        }
        return outcomes;
      });
    } catch (err) {
      if (err instanceof Rollback) return err.outcomes;
      throw err;
    }
  }

  /** One input of an add. */
  #addOne(tx: Tx, scope: Scope, job: NewJob, now: number): AddOutcome {
    const duplicate = (action: 'ignored' | 'replaced' | 'rejected', rec: JobRecord, by: 'id' | 'singletonKey' = 'id', existingState = rec.state): AddOutcome => ({
      status: 'duplicate', action, by, existingState, job: rec,
    });
    const rule = job.onDuplicate ?? 'ignore';
    const old = tx.get(scope, job.id);
    // WHY: a record holds its id while it is pending, or for good when it was added `retained`.
    const holder = old && (old.uniqueWhile === 'retained' || !isFinished(old.state)) ? old : undefined;
    if (holder) {
      if (rule === 'reject') return duplicate('rejected', holder);
      // WHY: replace only touches a job nobody has started; an active or finished job is left alone.
      if (rule === 'ignore' || (holder.state !== 'waiting' && holder.state !== 'delayed')) return duplicate('ignored', holder);
      const next = applyReplace(holder, job, now);
      if (Object.hasOwn(job, 'singletonKey') && job.singletonKey !== holder.singletonKey) {
        const key = job.singletonKey ?? null;
        const other = key === null ? undefined : tx.scan(scope, { holdsKey: key, limit: 1 })[0];
        if (other && other.id !== holder.id) return duplicate('ignored', other, 'singletonKey');
        next.singletonKey = key;
        next.singletonHeld = key !== null;
      }
      tx.put(scope, next);
      return duplicate('replaced', next, 'id', holder.state);
    }
    const key = job.singletonKey ?? null;
    // REPLACE-ME: a held key must be unique among waiting and delayed jobs: SQL a partial unique index on singleton_key where held, Redis SET NX on a key-hold key, Mongo a partial unique index.
    const keyHolder = key === null ? undefined : tx.scan(scope, { holdsKey: key, limit: 1 })[0];
    if (keyHolder) return duplicate(rule === 'reject' ? 'rejected' : 'ignored', keyHolder, 'singletonKey');
    // WHY: a finished record that held the id only while pending moves to the history key `id#seq` in this same
    // transaction, so the id is free and nothing is lost. get, counts and claim never read history; list reads only its
    // dead letters (dlq.ts).
    if (old) {
      // WHY: the new job takes the id, so the old one's last write moves to a tombstone and a late repeat still answers.
      leaveTombstone(tx, scope, old, now);
      tx.delete(scope, old.id);
      tx.putHistory(scope, { ...old, id: `${old.id}#${old.seq}` });
    }
    const runAt = job.runAt ?? now + (job.delayMs ?? 0);
    const rec: JobRecord = {
      formatVersion: job.formatVersion, namespace: scope.namespace, queue: scope.queue, id: job.id, name: job.name ?? null, data: job.data,
      dataVersion: job.dataVersion ?? null, state: runAt > now ? 'delayed' : 'waiting', priority: job.priority ?? 0,
      // WHY: seq only grows; `first` takes the next number below every earlier one, so it sorts ahead of all.
      seq: job.first ? tx.lowSeq(scope) : tx.nextSeq(scope),
      runAt, attempt: 0, maxAttempts: job.maxAttempts, crashCount: 0, lease: null, token: 0, lastFinal: null, result: null, error: null,
      backoff: job.backoff ?? null, timeout: job.timeout ?? null, idempotencyKey: job.idempotencyKey ?? null, workerId: null, uniqueWhile: job.uniqueWhile ?? 'pending',
      singletonKey: key, singletonHeld: key !== null, rev: 1, createdAt: now, startedAt: null, finishedAt: null,
      deadLetter: null, retainUntil: null, keep: job.keep ?? null, progress: null, batchProgress: null, redriveCount: 0, lastError: null,
      attemptsTruncated: 0, scheduleKey: null, scheduledFor: null, cancelReason: null,
    };
    tx.put(scope, rec);
    return { status: 'added', job: rec };
  }

  /*
   * SUREQ-CONTRACT: claim
   * WHY: taking jobs and writing their leases is one transaction, so two claimers never get the same job.
   * WHY: best first: highest priority, then oldest (fifo) or newest (lifo) seq; names narrow the choice.
   * WHY: a repeat with the same workerId and claimId returns that claim's live jobs, so a lost response loses no job.
   * WHY: a paused queue claims nothing, and says `blocked` only when it holds back a job this claim could take.
   */
  async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    check('claim', 'request', req, {
      workerId: text, claimId: text, limit: int(1, this.capabilities.limits.maxClaimLimit), leaseMs: int(1), order: oneOf('fifo', 'lifo'), hold: bool,
      leaseMsByName: (v) => isObj(v) && Object.values(v).every(int(1)), names: (v) => Array.isArray(v) && v.every(optText), maxFormat: int(1), history: historyOf(true),
    }, ['workerId', 'claimId', 'limit', 'leaseMs']);
    return this.#run('claim', scope, (tx, now) => {
      const byName = req.leaseMsByName ?? {};
      safeAt('claim', now + Math.max(req.leaseMs, ...Object.values(byName)), 'leaseMs puts expiresAt');
      const nextRunAt = tx.scan(scope, { state: 'delayed', order: { by: 'runAt', dir: 'asc' }, limit: 1 })[0]?.runAt ?? null;
      const mine = tx
        .scan(scope, { state: 'active', claim: { owner: req.workerId, claimId: req.claimId }, order: { by: 'token', dir: 'asc' } })
        .filter((rec) => rec.lease!.expiresAt > now);
      if (mine.length > 0) return { jobs: mine, now, nextRunAt, paused: false, recovered: true };
      // WHY: a job written in a format newer than `maxFormat` is left for a pod that reads it.
      const which = { ...(req.names && { names: req.names }), ...(req.maxFormat !== undefined && { formatAtMost: req.maxFormat }) };
      if (tx.getFlag(scope, 'paused')) {
        const held = tx.scan(scope, { state: 'waiting', ...which, limit: 1 }).length > 0;
        return held ? { jobs: [], now, nextRunAt, paused: true, blocked: { reason: 'paused' } } : { jobs: [], now, nextRunAt, paused: false };
      }
      // REPLACE-ME: pick and lock in one statement so concurrent claimers skip each other's rows: SQL SELECT ... FOR UPDATE SKIP LOCKED LIMIT n, Redis a Lua script that pops from the sorted set, Mongo findOneAndUpdate in a loop.
      const picked = tx.scan(scope, { state: 'waiting', ...which, order: { by: 'queue', dir: req.order ?? 'fifo' }, limit: req.limit });
      const jobs = picked.map((rec) => {
        const leaseMs = rec.name !== null && Object.hasOwn(byName, rec.name) ? byName[rec.name]! : req.leaseMs;
        rec.state = 'active';
        rec.attempt += 1;
        rec.startedAt = now;
        // WHY: progress belongs to one attempt, so a new claim starts both fields empty.
        rec.progress = rec.batchProgress = null;
        rec.workerId = req.workerId;
        // WHY: the token comes from one counter per queue and never repeats, so a newer claim always outranks an older one.
        rec.token = tx.nextToken(scope);
        // WHY: a lease held for a batch is marked until its handler starts (renew with `started`).
        rec.lease = { owner: req.workerId, token: rec.token, expiresAt: now + leaseMs, claimId: req.claimId, ...(req.hold && { held: true }) };
        rec.lastFinal = null;
        // WHY: a started job gives up its singleton key, so a new job with that key may wait.
        rec.singletonHeld = false;
        rec.rev += 1;
        openAttempt(tx, scope, rec, now, req.workerId, req.history);
        tx.put(scope, rec);
        return rec;
      });
      return { jobs, now, nextRunAt, paused: false };
    });
  }

  /** Read a job and judge a fenced write against it; a pass carries the record. */
  #fenced(tx: Tx, scope: Scope, req: { id: string; token: number }, now: number, kind?: FinalKind): Verdict {
    const rec = tx.get(scope, req.id);
    return fenceCheck(rec, req.token, now, kind, kind ? tx.getTombstone(tombKey(scope, req.id)) : undefined);
  }

  /*
   * SUREQ-CONTRACT: renew
   * WHY: only the holder of the newest unexpired lease may extend it; owner, token and attempt stay.
   * WHY: `started` clears `held`: the handler runs, so from now on an expiry is a crash.
   */
  async renew(scope: Scope, req: RenewRequest): Promise<RenewResult> {
    check('renew', 'request', req, { ...FENCED, leaseMs: int(1), started: bool, batchId: text }, ['id', 'token', 'leaseMs']); if (req.batchId !== undefined && req.started !== true) bad('renew', 'batchId needs started: true');
    return this.#run('renew', scope, (tx, now) => {
      if (req.started) assertWritable(tx, scope);
      const verdict = this.#fenced(tx, scope, req, now);
      if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
      const { rec } = verdict as Extract<Verdict, { verdict: 'pass' }>; // no kind, so never a repeat
      const expiresAt = now + req.leaseMs;
      safeAt('renew', expiresAt, 'leaseMs puts expiresAt');
      const { held: _held, ...started } = rec.lease!;
      rec.lease = { ...(req.started ? started : rec.lease!), expiresAt };
      rec.rev += 1;
      noteRenew(tx, scope, rec.id, req.token, now, req.started ? req.batchId : undefined);
      tx.put(scope, rec);
      return { ok: true, expiresAt, now };
    });
  }

  /*
   * SUREQ-CONTRACT: setProgress
   * WHY: fenced like renew, so a stale worker never overwrites the new attempt's progress; the lease is not touched.
   */
  async setProgress(scope: Scope, req: SetProgressRequest): Promise<SetProgressResult> {
    check('setProgress', 'request', req, { ...FENCED, progress: payload, field: oneOf('progress', 'batchProgress') }, ['id', 'token', 'progress']);
    return this.#run('setProgress', scope, (tx, now) => {
      const verdict = this.#fenced(tx, scope, req, now);
      if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
      const { rec } = verdict as Extract<Verdict, { verdict: 'pass' }>; // no kind, so never a repeat
      rec[req.field ?? 'progress'] = { value: req.progress, updatedAt: now };
      rec.rev += 1;
      tx.put(scope, rec);
      return { ok: true, now };
    });
  }

  /*
   * SUREQ-CONTRACT: complete
   * WHY: the fence check decides; a repeat with the same token answers `repeated: true` and changes nothing.
   */
  async complete(scope: Scope, req: CompleteRequest): Promise<CompleteResult> {
    check('complete', 'request', req, { ...FENCED, result: optPayload, history: historyOf(false), retention: retentionOf }, ['id', 'token', 'result']);
    return this.#run('complete', scope, (tx, now) => {
      const verdict = this.#fenced(tx, scope, req, now, 'complete');
      if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
      if (verdict.verdict === 'repeat') return { ok: true, now, repeated: true };
      const { rec } = verdict;
      closeAttempt(tx, scope, rec, req.token, now, { outcome: 'completed', endedBy: 'worker', error: null }, req.history);
      rec.lease = null;
      rec.state = 'completed';
      rec.result = req.result;
      rec.finishedAt = now;
      rec.lastFinal = { token: req.token, kind: 'complete', state: 'completed' };
      rec.rev += 1;
      finish('complete', tx, scope, rec, now, req.retention);
      return { ok: true, now };
    });
  }

  /*
   * SUREQ-CONTRACT: fail
   * WHY: the attempt is over: with `retryInMs` and attempts left the job is delayed by that long on store time, else failed.
   * WHY: the caller decides retry timing; the store only enforces `maxAttempts`.
   */
  async fail(scope: Scope, req: FailRequest): Promise<FailResult> {
    check('fail', 'request', req, { ...FENCED, error: payload, retryInMs: int(0), history: historyOf(false), deadLetter: deadLetterOf(false), retention: retentionOf }, ['id', 'token', 'error']);
    return this.#run('fail', scope, (tx, now) => {
      const verdict = this.#fenced(tx, scope, req, now, 'fail');
      if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
      if (verdict.verdict === 'repeat') return { ok: true, state: verdict.state as 'delayed' | 'failed', ...(verdict.runAt !== undefined && { runAt: verdict.runAt }), now, repeated: true };
      const { rec } = verdict;
      const retry = req.retryInMs !== undefined && rec.attempt < rec.maxAttempts;
      if (retry) safeAt('fail', now + req.retryInMs!, 'retryInMs puts runAt');
      closeAttempt(tx, scope, rec, req.token, now, { outcome: 'failed', endedBy: 'worker', error: req.error }, req.history);
      rec.lease = null;
      rec.error = req.error;
      rec.rev += 1;
      if (retry) {
        rec.state = 'delayed';
        rec.runAt = now + req.retryInMs!;
        takeOrSkipKey(tx, scope, rec);
        rec.lastFinal = { token: req.token, kind: 'fail', state: 'delayed', runAt: rec.runAt };
      } else {
        markDeadLetter('fail', rec, now, req.deadLetter);
        rec.state = 'failed';
        rec.finishedAt = now;
        rec.lastFinal = { token: req.token, kind: 'fail', state: 'failed' };
      }
      if (retry) tx.put(scope, rec);
      else finish('fail', tx, scope, rec, now, req.retention);
      return retry ? { ok: true, state: 'delayed', runAt: rec.runAt, now } : { ok: true, state: 'failed', now };
    });
  }

  /*
   * SUREQ-CONTRACT: release
   * WHY: a worker that stops gives the job back without finishing it: waiting now, or delayed by `delayMs`.
   * WHY: the token is kept (a repeat must answer), and `refundAttempt` returns the attempt it used.
   */
  async release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult> {
    check('release', 'request', req, {
      ...FENCED, delayMs: int(0), refundAttempt: bool, handlerStarted: bool, reason: oneOf('shutdown', 'pause'), history: historyOf(false),
    }, ['id', 'token', 'refundAttempt', 'handlerStarted']);
    return this.#run('release', scope, (tx, now) => {
      const verdict = this.#fenced(tx, scope, req, now, 'release');
      if (verdict.verdict === 'reject') return { ok: false, reason: verdict.reason };
      if (verdict.verdict === 'repeat') return { ok: true, state: verdict.state as 'waiting' | 'delayed', runAt: verdict.runAt!, now, repeated: true };
      const { rec } = verdict;
      const delayMs = req.delayMs ?? 0;
      safeAt('release', now + delayMs, 'delayMs puts runAt');
      const state = delayMs > 0 ? 'delayed' : 'waiting';
      closeAttempt(tx, scope, rec, req.token, now, { outcome: 'released', endedBy: 'shutdown', error: null }, req.history);
      rec.lease = null;
      rec.state = state;
      rec.runAt = now + delayMs;
      if (req.refundAttempt) rec.attempt -= 1;
      rec.lastFinal = { token: req.token, kind: 'release', state, runAt: rec.runAt };
      rec.rev += 1;
      takeOrSkipKey(tx, scope, rec);
      tx.put(scope, rec);
      return { ok: true, state, runAt: rec.runAt, now };
    });
  }

  /*
   * SUREQ-CONTRACT: sweep
   * WHY: a job whose lease ran out has a crashed worker; each sweep counts one crash, oldest expiry first.
   * WHY: the job is requeued, or failed with `poisonError` at maxCrashes (or `failError` when attempts are used up).
   * WHY: the token stays, so the dead worker's late writes are still refused by the fence.
   */
  async sweep(scope: Scope, req: SweepRequest): Promise<SweepResult> {
    check('sweep', 'request', req, {
      limit: int(1, this.capabilities.limits.maxClaimLimit), maxCrashes: int(1), failError: payload, poisonError: payload, maxFormat: int(1), history: historyOf(false), deadLetter: deadLetterOf(true), retention: retentionOf,
    }, ['limit', 'maxCrashes', 'failError', 'poisonError']);
    return this.#run('sweep', scope, (tx, now) => {
      const swept: SweptJob[] = [];
      const expired = tx.scan(scope, {
        state: 'active', leaseExpiresAtAtMost: now, ...(req.maxFormat !== undefined && { formatAtMost: req.maxFormat }), order: { by: 'leaseExpiresAt', dir: 'asc' }, limit: req.limit,
      });
      for (const rec of expired) {
        const { owner: previousOwner, held } = rec.lease!;
        // WHY: a held job's handler never ran, so its row closes as a give-back, not a crash.
        closeAttempt(tx, scope, rec, rec.token, now, { outcome: held ? 'released' : 'crashed', endedBy: 'sweeper', error: null }, req.history);
        rec.lease = null;
        // WHY: a job held for a batch never reached its handler, so its expiry is a give-back, not a crash.
        if (held) rec.attempt -= 1;
        else rec.crashCount += 1;
        const failed = !held && (rec.crashCount >= req.maxCrashes || rec.attempt >= rec.maxAttempts);
        const poison = failed && rec.crashCount >= req.maxCrashes;
        if (failed) {
          markDeadLetter('sweep', rec, now, req.deadLetter, poison ? 'crashLimit' : 'exhausted');
          rec.state = 'failed';
          rec.finishedAt = now;
          rec.error = poison ? req.poisonError : req.failError;
        } else {
          rec.state = 'waiting';
          rec.runAt = now;
          takeOrSkipKey(tx, scope, rec);
        }
        rec.lastFinal = null;
        rec.rev += 1;
        if (failed) finish('sweep', tx, scope, rec, now, req.retention);
        else tx.put(scope, rec);
        swept.push({ id: rec.id, token: rec.token, previousOwner, action: failed ? 'failed' : 'requeued', attempt: rec.attempt, crashCount: rec.crashCount });
      }
      return { swept, now };
    });
  }

  /*
   * SUREQ-CONTRACT: cancel
   * WHY: a job that has not finished goes to cancelled, even an active one; its lease is cleared so its worker's writes fail.
   * WHY: `cancelReason: 'user'` tells a cancelled job apart from one that finished another way.
   */
  async cancel(scope: Scope, req: CancelRequest): Promise<CancelResult> {
    check('cancel', 'request', req, { id: text, history: historyOf(false), retention: retentionOf }, ['id']);
    return this.#run('cancel', scope, (tx, now) => {
      const rec = tx.get(scope, req.id);
      if (!rec) return { ok: false, reason: 'not-found' };
      if (isFinished(rec.state)) return { ok: false, reason: 'already-terminal', state: rec.state };
      const previousState = rec.state as 'waiting' | 'delayed' | 'active';
      // WHY: without `history` only an open row is closed: no cap, no new row (attempts.ts).
      if (previousState === 'active' && req.history === undefined) closeOpenAttempt(tx, scope, rec, rec.token, now);
      else if (previousState === 'active') closeAttempt(tx, scope, rec, rec.token, now, { outcome: 'cancelled', endedBy: 'cancel', error: null }, req.history);
      rec.state = 'cancelled';
      rec.lease = null;
      rec.singletonHeld = false;
      rec.finishedAt = now;
      rec.cancelReason = 'user';
      rec.rev += 1;
      finish('cancel', tx, scope, rec, now, req.retention);
      return { ok: true, previousState };
    });
  }

  /*
   * SUREQ-CONTRACT: remove
   * WHY: an active job cannot be removed. A job with a last finalising write leaves a tombstone, so a late repeat of that write still answers.
   * WHY: a superseded dead letter is removed by its history key (dlq.ts).
   */
  async remove(scope: Scope, req: { id: string }): Promise<RemoveResult> {
    check('remove', 'request', req, { id: text }, ['id']);
    return this.#run('remove', scope, (tx, now) => {
      const rec = tx.get(scope, req.id);
      if (!rec) return removeSuperseded(tx, scope, req.id);
      if (rec.state === 'active') return { removed: false, reason: 'active' };
      deleteJob(tx, scope, rec, now);
      return { removed: true, previousState: rec.state };
    });
  }

  /*
   * SUREQ-CONTRACT: update
   * WHY: only a waiting or delayed job can be edited, and only when `expectedRev` is its current rev; seq is kept.
   */
  async update(scope: Scope, req: UpdateRequest): Promise<UpdateResult> {
    check('update', 'request', req, { id: text, expectedRev: int(1), patch: isObj }, ['id', 'expectedRev', 'patch']);
    check('update', 'patch', req.patch, { data: payload, priority: int(Number.MIN_SAFE_INTEGER), delayMs: int(0), runAt: int(0) });
    if (Object.keys(req.patch).length === 0) bad('update', 'patch must set at least one field');
    if (req.patch.delayMs !== undefined && req.patch.runAt !== undefined) bad('update', 'delayMs and runAt cannot both be set');
    return this.#run('update', scope, (tx, now) => {
      const rec = tx.get(scope, req.id);
      if (!rec) return { ok: false, reason: 'not-found' };
      if (rec.state !== 'waiting' && rec.state !== 'delayed') return { ok: false, reason: 'not-editable' };
      if (rec.rev !== req.expectedRev) return { ok: false, reason: 'conflict' };
      const { patch } = req;
      const runAt = patch.runAt ?? (patch.delayMs === undefined ? undefined : now + patch.delayMs);
      if (runAt !== undefined) safeAt('update', runAt, 'delayMs puts runAt');
      if (patch.data !== undefined) rec.data = patch.data;
      if (patch.priority !== undefined) rec.priority = patch.priority;
      if (runAt !== undefined) {
        rec.runAt = runAt;
        rec.state = runAt > now ? 'delayed' : 'waiting';
      }
      rec.rev += 1;
      tx.put(scope, rec);
      return { ok: true, job: rec };
    });
  }

  /*
   * SUREQ-CONTRACT: get
   * WHY: a read returns a copy of the stored record, or null; an unknown scope is just empty.
   */
  async get(scope: Scope, id: string): Promise<JobRecord | null> {
    if (!text(id)) bad('get', 'id must be a non-empty string');
    return this.#run('get', scope, (tx) => tx.get(scope, id) ?? null);
  }

  /*
   * SUREQ-CONTRACT: list
   * WHY: one state's records, paged, ordered by `orderBy` (default seq); ties break by seq in the same direction.
   * WHY: `deadLetter` (failed jobs only) and `name` narrow it; `deadLetterAt` orders by the dead-letter time (dlq.ts).
   */
  async list(scope: Scope, req: ListRequest): Promise<JobRecord[]> {
    check('list', 'request', req, {
      state: oneOf(...STATES), offset: int(0), limit: int(1, MAX_LIST_LIMIT), orderBy: oneOf('seq', 'runAt', 'startedAt', 'finishedAt', 'deadLetterAt'), order: oneOf('asc', 'desc'),
      deadLetter: deadLetterFilter, name: optText,
    }, ['state', 'offset', 'limit', 'order']);
    return this.#run('list', scope, (tx, now) => tx.scan(scope, listScan(req, now)));
  }

  /*
   * SUREQ-CONTRACT: counts
   * WHY: jobs per state; a delayed job that is due already counts as waiting. `blocked` is every waiting job while the queue is paused.
   */
  async counts(scope: Scope): Promise<JobCounts> {
    return this.#run('counts', scope, (tx) => {
      // REPLACE-ME: one grouped query answers this: SQL SELECT state, count(*) GROUP BY state, Redis ZCARD per state set, Mongo $group.
      const counts = Object.fromEntries(STATES.map((s) => [s, tx.scan(scope, { state: s }).length])) as Record<JobState, number>;
      return { ...counts, blocked: tx.getFlag(scope, 'paused') ? counts.waiting : 0 };
    });
  }

  /*
   * SUREQ-CONTRACT: setPaused
   * WHY: the pause flag belongs to the queue, not to a job, so no job's rev changes; `changed` says whether it flipped.
   */
  async setPaused(scope: Scope, paused: boolean): Promise<{ changed: boolean }> {
    if (typeof paused !== 'boolean') bad('setPaused', 'paused must be a boolean');
    return this.#run('setPaused', scope, (tx) => {
      const changed = tx.getFlag(scope, 'paused') !== paused;
      if (changed) tx.setFlag(scope, 'paused', paused);
      return { changed };
    });
  }

  /*
   * SUREQ-CONTRACT: isPaused
   * WHY: claim reads the same flag, so what this says is what claim does.
   */
  async isPaused(scope: Scope): Promise<boolean> {
    return this.#run('isPaused', scope, (tx) => tx.getFlag(scope, 'paused'));
  }

  // The bodies and their SUREQ-CONTRACT blocks: stats, clean and obliterate in admin.ts, schedule records in
  // schedules.ts, attempt records in attempts.ts, redrive in dlq.ts, the namespace format record in namespace.ts, the
  // worker registry in workers.ts.
  async stats(scope: Scope, req: Record<string, never>): Promise<StatsResult> { return this.#run('stats', scope, stats(scope, req)); }
  async clean(scope: Scope, req: CleanRequest): Promise<CleanResult> { checkClean(req); return this.#run('clean', scope, (tx, now) => cleanTx(tx, scope, req, now)); }
  async obliterate(scope: Scope, req: ObliterateRequest): Promise<ObliterateResult> { checkObliterate(req); return this.#run('obliterate', scope, (tx, now) => obliterateTx(tx, scope, req, now)); }
  async putSchedule(scope: Scope, req: PutScheduleRequest): Promise<PutScheduleResult> { return this.#run('putSchedule', scope, putSchedule(scope, req)); }
  async getSchedule(scope: Scope, req: { key: string }): Promise<ScheduleRecord | null> { return this.#run('getSchedule', scope, getSchedule(scope, req)); }
  async listSchedules(scope: Scope, req: ListSchedulesRequest): Promise<ListSchedulesResult> { return this.#run('listSchedules', scope, listSchedules(scope, req)); }
  async deleteSchedule(scope: Scope, req: DeleteScheduleRequest): Promise<DeleteScheduleResult> { return this.#run('deleteSchedule', scope, deleteSchedule(scope, req)); }
  async redrive(scope: Scope, req: RedriveRequest): Promise<RedriveOutcome[]> { checkRedrive(req); return this.#run('redrive', scope, (tx, now) => redrive(tx, scope, req, now)); }
  async getAttempts(scope: Scope, req: GetAttemptsRequest): Promise<GetAttemptsResult> { checkGetAttempts(req); return this.#run('getAttempts', scope, (tx) => pageAttempts(tx, scope, req)); }
  async ensureNamespaceMeta(ns: NamespaceScope, req: EnsureNamespaceMetaRequest): Promise<EnsureNamespaceMetaResult> { this.#ready('ensureNamespaceMeta'); return ensureNamespaceMeta(this.#backend, () => this.#ready('ensureNamespaceMeta'), ns, req); }
  async getNamespaceMeta(ns: NamespaceScope): Promise<StoreMeta | null> { this.#ready('getNamespaceMeta'); return getNamespaceMeta(this.#backend, () => this.#ready('getNamespaceMeta'), ns); }
  async listDueSchedules(scope: Scope, req: { limit: number }): Promise<ListDueSchedulesResult> { return this.#run('listDueSchedules', scope, listDueSchedules(scope, req)); }
  async fireSchedule(scope: Scope, req: FireScheduleRequest): Promise<FireScheduleResult> {
    return this.#run('fireSchedule', scope, fireSchedule(scope, req, this.capabilities.limits.maxIdBytes, (tx, job, now) => this.#addOne(tx, scope, job, now)));
  }

  async registerWorker(ns: NamespaceScope, req: RegisterWorkerRequest): Promise<RegisterWorkerResult> { return this.#runNs('registerWorker', ns, registerWorker(ns, req)); }
  async heartbeatWorker(ns: NamespaceScope, req: HeartbeatWorkerRequest): Promise<{ ok: boolean }> { return this.#runNs('heartbeatWorker', ns, heartbeatWorker(ns, req)); }
  async unregisterWorker(ns: NamespaceScope, req: { workerId: string }): Promise<void> { return this.#runNs('unregisterWorker', ns, unregisterWorker(ns, req)); }
  async listWorkers(ns: NamespaceScope, req: { queue?: string }): Promise<ListWorkersResult> { return this.#runNs('listWorkers', ns, listWorkers(ns, req)); }
  async purgeWorkers(ns: NamespaceScope, req: { staleIntervals: number; limit: number }): Promise<{ removed: number }> { return this.#runNs('purgeWorkers', ns, purgeWorkers(ns, req)); }
  #runNs<T>(op: string, ns: NamespaceScope, body: (tx: Tx, now: number) => T): Promise<T> { return inNamespace(this.#backend, () => this.#ready(op), op, ns, body); }

  #ready(op: string): void { if (!this.#opened) bad(op, 'the store is not open'); }

  /**
   * The start of every scoped call (rules 1 and 2): open check, scope check, one transaction, one clock read.
   * WHY: delayed jobs that came due become waiting here, at their original seq and without touching rev, so
   * every method sees the same states.
   */
  async #run<T>(op: string, scope: Scope, body: (tx: Tx, now: number) => T): Promise<T> {
    this.#ready(op);
    check(op, 'scope', scope, SCOPE, ['namespace', 'queue']);
    return this.#backend.transact((tx) => {
      // WHY: a call queued before close must not be served after it.
      this.#ready(op);
      const now = this.#backend.serverNow();
      // WHY: an obliterating queue refuses writes inside their own transaction (admin.ts).
      if (MARKED.has(op)) assertWritable(tx, scope);
      // REPLACE-ME: promoting due delayed jobs on every call scans them each time; do it in the same statement as the read, on an index of the due time: SQL UPDATE ... SET state = 'waiting' WHERE state = 'delayed' AND run_at <= now, Redis ZRANGEBYSCORE on a delayed sorted set inside the script, Mongo updateMany on an indexed runAt.
      for (const rec of tx.scan(scope, { state: 'delayed', runAtAtMost: now })) {
        rec.state = 'waiting';
        tx.put(scope, rec);
      }
      return body(tx, now);
    });
  }
}
