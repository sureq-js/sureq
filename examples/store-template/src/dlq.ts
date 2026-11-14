// Dead letters: a job that fails for good is marked in the same write that fails it, and `redrive` moves failed
// jobs back to waiting. There is no second queue: a dead letter is a failed job with a `deadLetter` marker.
import type { DeadLetterReason, JobRecord, ListRequest, RedriveOutcome, RedriveRequest, RemoveResult, Scope } from '@sureq/core';
import type { ScanFilter, Tx } from './backend.js';
import { bad, check, int, isObj, oneOf, safeAt, text, type Pred } from './check.js';

const MAX_LIMIT = 1000;
const REASONS = ['exhausted', 'unrecoverable', 'retryRejected', 'crashLimit', 'legacy'];
type DeadLetterExt = false | { reason?: DeadLetterReason; keepMs?: number } | undefined;

/** The `deadLetter` field of `fail` (`reason?`, `keepMs?`) or `sweep` (`keepMs?` only; the store picks the reason). */
export const deadLetterOf = (sweep: boolean): Pred => (v) => v === false || (isObj(v) &&
  Object.keys(v).every((k) => k === 'keepMs' || (!sweep && k === 'reason')) &&
  (v['keepMs'] === undefined || int(0)(v['keepMs'])) && (v['reason'] === undefined || oneOf('exhausted', 'unrecoverable', 'retryRejected')(v['reason'])));

/** A dead-letter filter: `{ reason?, olderThanMs? }`. */
export const deadLetterFilter: Pred = (v) => isObj(v) && Object.keys(v).every((k) => k === 'reason' || k === 'olderThanMs') &&
  (v['reason'] === undefined || REASONS.includes(v['reason'] as string)) && (v['olderThanMs'] === undefined || int(0)(v['olderThanMs']));

/** The scan that answers a dead-letter filter at `now`. */
const scanOf = (f: NonNullable<ListRequest['deadLetter']>, now: number): NonNullable<ScanFilter['deadLetter']> =>
  ({ ...(f.reason !== undefined && { reason: f.reason }), ...(f.olderThanMs !== undefined && { atAtMost: now - f.olderThanMs }) });

/**
 * Mark a job that fails for good, on the record the fail or sweep is about to write.
 * WHY: the marker goes in the same write as `state = failed`, so no reader ever sees a failed job without it.
 * WHY: an absent field comes from a previous-release pod, which knows no dead letters: `legacy`. `false` keeps a plain failed job.
 */
export function markDeadLetter(op: 'fail' | 'sweep', rec: JobRecord, now: number, ext: DeadLetterExt, derived?: DeadLetterReason): void {
  if (ext === false) return;
  if (ext?.keepMs !== undefined) safeAt(op, now + ext.keepMs, 'deadLetter.keepMs puts retainUntil');
  rec.deadLetter = { at: now, reason: ext === undefined ? 'legacy' : derived ?? ext.reason ?? 'exhausted' };
  rec.retainUntil = ext?.keepMs === undefined ? null : now + ext.keepMs;
}

/** The list request's dead-letter and name filters as a scan: `deadLetter` (failed jobs only) and `name`; `deadLetterAt` needs the filter. */
export function listScan(req: ListRequest, now: number): ScanFilter {
  if (req.deadLetter && req.state !== 'failed') bad('list', 'deadLetter needs state failed');
  if (req.orderBy === 'deadLetterAt' && !req.deadLetter) bad('list', 'orderBy deadLetterAt needs the deadLetter filter');
  return {
    // WHY: a superseded dead letter (history key `id#seq`) is a dead letter still, so the dead-letter filter lists it.
    state: req.state, ...(req.name !== undefined && { names: [req.name] }), ...(req.deadLetter && { deadLetter: scanOf(req.deadLetter, now), history: true as const }),
    order: { by: req.orderBy ?? 'seq', dir: req.order }, offset: req.offset, limit: req.limit,
  };
}

/** A job coming back to waiting or delayed takes its singleton key if nobody holds it, else comes back without. */
export function takeOrSkipKey(tx: Tx, scope: Scope, rec: JobRecord): void {
  if (rec.singletonKey === null) return;
  const holder = tx.scan(scope, { holdsKey: rec.singletonKey, limit: 1 })[0];
  rec.singletonHeld = holder === undefined || holder.id === rec.id;
}

export function checkRedrive(req: RedriveRequest): void {
  check('redrive', 'request', req, {
    ids: (v) => Array.isArray(v) && v.every(text), filter: deadLetterFilter, resetAttempts: (v) => typeof v === 'boolean', delayMs: int(0),
    priority: int(Number.MIN_SAFE_INTEGER), limit: int(1, MAX_LIMIT),
  }, ['limit']);
  if ((req.ids === undefined) === (req.filter === undefined)) bad('redrive', 'exactly one of ids and filter must be set');
  if (req.ids && req.ids.length > req.limit) bad('redrive', 'ids must have at most limit entries');
}

/*
 * SUREQ-CONTRACT: redrive
 * WHY: each job is one conditional write, valid only while `state = failed`, so two redrives of one job move it once.
 * WHY: `seq` is kept, so a redriven job keeps its FIFO place; `token` and attempt rows are kept too.
 * WHY: by ids the outcomes follow the request order; by filter the oldest dead letters go first, up to `limit`.
 * WHY: a superseded dead letter answers `duplicate-id` by its history key; the filter form passes it by, so it never fills a page.
 */
export function redrive(tx: Tx, scope: Scope, req: RedriveRequest, now: number): RedriveOutcome[] {
  const delayMs = req.delayMs ?? 0;
  safeAt('redrive', now + delayMs, 'delayMs puts runAt');
  // REPLACE-ME: the filter form reads dead letters in (dead_letter_at, seq) order: SQL an index on (dead_letter_at, seq) where state = 'failed', Redis a sorted set of dead letters, Mongo a compound index on deadLetter.at and seq.
  const ids = req.ids ?? tx.scan(scope, { state: 'failed', deadLetter: scanOf(req.filter!, now), order: { by: 'deadLetterAt', dir: 'asc' }, limit: req.limit }).map((r) => r.id);
  return ids.map((id): RedriveOutcome => {
    // REPLACE-ME: one conditional write per job: SQL UPDATE jobs SET ... WHERE id = $1 AND state = 'failed' RETURNING, Redis a script per id, Mongo findOneAndUpdate({ id, state: 'failed' }).
    const rec = tx.get(scope, id);
    if (!rec) return { id, status: 'skipped', reason: tx.getHistory(scope, id) ? 'duplicate-id' : 'not-found' };
    if (rec.state !== 'failed') return { id, status: 'skipped', reason: 'not-failed' };
    const viaDeadLetter = rec.deadLetter !== null;
    const state = delayMs > 0 ? 'delayed' : 'waiting';
    Object.assign(rec, { state, runAt: now + delayMs, deadLetter: null, retainUntil: null, finishedAt: null, progress: null, batchProgress: null, lastError: rec.error });
    rec.redriveCount += 1;
    if (req.priority !== undefined) rec.priority = req.priority;
    // WHY: without resetAttempts the job keeps its attempt and crash counts, so it gets one more attempt.
    if (req.resetAttempts !== false) Object.assign(rec, { attempt: 0, crashCount: 0 });
    rec.rev += 1;
    takeOrSkipKey(tx, scope, rec);
    tx.put(scope, rec);
    return { id, status: 'redriven', state, viaDeadLetter };
  });
}

/**
 * `remove` of an id no live job holds: a superseded dead letter goes by its history key `id#seq`, with its attempt rows.
 * WHY: it stays a dead letter until redriven or removed, so remove is how one is deleted on its own.
 */
export function removeSuperseded(tx: Tx, scope: Scope, id: string): RemoveResult {
  const old = tx.getHistory(scope, id);
  if (!old || old.deadLetter === null) return { removed: false, reason: 'not-found' };
  tx.deleteHistory(scope, id);
  return { removed: true, previousState: old.state };
}
