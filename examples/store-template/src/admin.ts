// Queue-wide reads and admin helpers, each run inside one store transaction.
import { QueueNotIdleError, QueueObliteratingError, type CleanRequest, type CleanResult, type JobRecord, type JobState, type ObliterateRequest, type ObliterateResult, type Scope, type StatsResult } from '@sureq/core';
import type { Tx } from './backend.js';
import { bool, check, int, oneOf, optText } from './check.js';
import { checkCleanModes, named, retentionMatches } from './retention.js';

const STATES: readonly JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];
/** How long a deleted job's last finalising write stays answerable. */
const FINALS_TTL_MS = 600_000;
/** The largest page an admin call may ask for. */
const MAX_ADMIN_LIMIT = 5000;
/** The live id a superseded record's key `id#seq` belongs to; undefined for any other key. */
const supersededOf = (key: string): string | undefined => (/#-?\d+$/.test(key) ? key.slice(0, key.lastIndexOf('#')) : undefined);
export const tombKey = (s: Scope, id: string): string => `${s.namespace}\u0000${s.queue}\u0000${id}`;

/**
 * The single job deletion, used by remove, clean and obliterate.
 * WHY: the attempt rows go with the job, and a job with a last finalising write leaves a tombstone, so a late repeat of that write still answers.
 * WHY: a job that finished more than the tombstone's lifetime ago gets no such repeat any more, so it leaves none.
 */
export function deleteJob(tx: Tx, scope: Scope, rec: JobRecord, now: number): void {
  tx.delete(scope, rec.id);
  tx.setAttempts(scope, rec.id, null);
  leaveTombstone(tx, scope, rec, now);
}

/**
 * Keep the job's last finalising write under its id, so a repeat of it still answers once the id is gone or taken by a
 * new job (removed, or superseded by a new add).
 * WHY: a job that finished more than the tombstone's lifetime ago gets no such repeat any more, so it leaves none.
 */
export function leaveTombstone(tx: Tx, scope: Scope, rec: JobRecord, now: number): void {
  const stale = rec.finishedAt !== null && rec.finishedAt + FINALS_TTL_MS <= now;
  if (rec.lastFinal && !stale) tx.putTombstone(tombKey(scope, rec.id), { ...rec.lastFinal, expiresAt: now + FINALS_TTL_MS });
}

export function checkClean(req: CleanRequest): void {
  check('clean', 'request', req, {
    state: oneOf('completed', 'failed', 'cancelled', 'waiting', 'delayed'), olderThanMs: int(0), keepLast: int(0), retainExpired: bool, name: optText,
    excludeNames: (v) => Array.isArray(v), limit: int(1, MAX_ADMIN_LIMIT),
  }, ['state', 'limit']);
  checkCleanModes(req);
}

/*
 * SUREQ-CONTRACT: clean
 * WHY: deletes up to `limit` jobs of one state that are at least `olderThanMs` old on store time, oldest seq first.
 * WHY: the age counts from `finishedAt` for a finished job and from `createdAt` for a waiting or delayed one.
 * WHY: the read and the deletes are one transaction, so a job a claim took meanwhile is never deleted.
 * WHY: `name` / `excludeNames` narrow it; `retainExpired` and `keepLast` are the retention rules (retention.ts).
 * WHY: a deleted job takes the superseded records of its id (`id#seq`) with it, so nothing of a deleted id stays behind,
 * except a superseded dead letter: that is a dead letter still, which only the age mode of `failed` (or remove) deletes.
 */
export function cleanTx(tx: Tx, scope: Scope, req: CleanRequest, now: number): CleanResult {
  const cutoff = now - (req.olderThanMs ?? 0);
  const finished = req.state !== 'waiting' && req.state !== 'delayed';
  // REPLACE-ME: delete in one statement on a state and time index: SQL DELETE ... WHERE state = $1 AND finished_at <= now - $2 LIMIT $3, Redis ZRANGEBYSCORE plus DEL in a script, Mongo deleteMany on a state and time index.
  const aged = (r: JobRecord): boolean => (finished ? r.finishedAt ?? r.createdAt : r.createdAt) <= cutoff && named(r, req);
  // WHY: the age mode of failed also takes superseded dead letters, merged in seq order.
  const deadOnes = req.state === 'failed' ? tx.scanHistory(scope).filter((r) => r.state === 'failed' && r.deadLetter !== null) : [];
  const matches = req.retainExpired || req.keepLast !== undefined ? retentionMatches(tx, scope, req, now)
    : [...tx.scan(scope, { state: req.state }), ...deadOnes].filter(aged).sort((a, b) => a.seq - b.seq);
  const pick = matches.slice(0, req.limit);
  // REPLACE-ME: superseded records go in the same statement: SQL DELETE FROM job_history WHERE job_id = ANY($1), Redis HDEL of the id#seq fields in the script, Mongo deleteMany on the history collection by job id.
  const history = tx.scanHistory(scope);
  for (const rec of pick) {
    if (history.some((h) => h.id === rec.id)) {
      tx.deleteHistory(scope, rec.id);
      continue;
    }
    deleteJob(tx, scope, rec, now);
    for (const h of history) if (supersededOf(h.id) === rec.id && h.deadLetter === null) tx.deleteHistory(scope, h.id);
  }
  return { removed: pick.length, remaining: matches.length > pick.length };
}

/** Counts, the oldest claimable waiting `runAt` and the dead-letter count, all from the transaction `tx`. */
export function statsTx(tx: Tx, scope: Scope, now: number): StatsResult {
  // REPLACE-ME: one snapshot answers this: SQL SELECT state, count(*) ... GROUP BY state plus SELECT min(run_at) FROM jobs WHERE state = 'waiting' on a partial index, under REPEATABLE READ; Redis ZCARD per state plus ZRANGE waiting 0 0 WITHSCORES in one script; Mongo one $facet aggregate.
  // WHY: these scans grow with the queue; stats runs on every sweeper, alert and metrics read, so a real adapter keeps per-state counts (and a dead-letter count) updated in the writes that change them.
  const counts = Object.fromEntries(STATES.map((s) => [s, tx.scan(scope, { state: s }).length])) as Record<JobState, number>;
  const paused = tx.getFlag(scope, 'paused');
  // WHY: a paused queue's waiting jobs are blocked, so none of them is aging toward a claim.
  const oldest = paused ? null : tx.scan(scope, { state: 'waiting', order: { by: 'runAt', dir: 'asc' }, limit: 1 })[0]?.runAt ?? null;
  // WHY: a superseded dead letter (history key `id#seq`) is a dead letter still, so it is counted.
  const deadLetters = tx.scan(scope, { state: 'failed', deadLetter: {}, history: true }).length;
  return { counts: { ...counts, blocked: paused ? counts.waiting : 0 }, oldestWaitingRunAt: oldest, deadLetters, now };
}

/*
 * SUREQ-CONTRACT: stats
 * WHY: counts, the oldest waiting runAt and the dead-letter count come from one transaction, so they never disagree.
 * WHY: the oldest skips blocked (paused) and not-yet-due jobs; a due delayed job ages from its runAt.
 */
export function stats(scope: Scope, req: Record<string, never>): (tx: Tx, now: number) => StatsResult {
  check('stats', 'request', req, {});
  return (tx, now) => statsTx(tx, scope, now);
}

/**
 * Refuse a write to a queue that is being obliterated.
 * WHY: the check runs inside the write's own transaction, so no job, claim or schedule tick slips in behind the obliterate.
 */
export function assertWritable(tx: Tx, scope: Scope): void {
  // REPLACE-ME: read the marker under a lock the obliterate's marker write conflicts with, in the write's own transaction: SQL SELECT obliterating FROM queues WHERE ... FOR SHARE (obliterate sets it with FOR UPDATE), Redis read the flag inside the same script as the write, Mongo read the queue document inside the write's transaction.
  if (tx.getFlag(scope, 'obliterating')) throw new QueueObliteratingError({ queue: scope.queue });
}

export function checkObliterate(req: ObliterateRequest): void {
  check('obliterate', 'request', req, { force: bool, limit: int(1, MAX_ADMIN_LIMIT) }, ['limit']);
}

/*
 * SUREQ-CONTRACT: obliterate
 * WHY: the first call counts active jobs and sets the marker in one transaction; without `force`, active jobs refuse it and nothing is written.
 * WHY: the marker makes every other write throw, so a call that dies between pages leaves the queue blocked, and the next call (marker set, no check) goes on.
 * WHY: the call that deletes the last job also drops history, schedules and the pause flag, then clears the marker; seq and token counters stay, so a stale worker's token stays lower.
 */
export function obliterateTx(tx: Tx, scope: Scope, req: ObliterateRequest, now: number): ObliterateResult {
  if (!tx.getFlag(scope, 'obliterating')) {
    // REPLACE-ME: count and mark in one transaction: SQL SELECT count(*) ... WHERE state = 'active' FOR UPDATE on the queue row, Redis ZCARD active plus SET in one script, Mongo countDocuments plus updateOne in one transaction.
    const active = tx.scan(scope, { state: 'active' }).length;
    if (active > 0 && !req.force) throw new QueueNotIdleError({ queue: scope.queue, active });
    tx.setFlag(scope, 'obliterating', true);
  }
  // REPLACE-ME: delete a page in one statement: SQL DELETE ... WHERE id IN (SELECT id ... LIMIT $1), Redis a script over the queue's keys, Mongo deleteMany on a page of ids.
  const page = tx.scan(scope, { limit: req.limit + 1 });
  for (const rec of page.slice(0, req.limit)) deleteJob(tx, scope, rec, now);
  if (page.length > req.limit) return { removed: req.limit, done: false };
  tx.clearHistory(scope);
  for (const rec of tx.scanSchedules(scope, {})) tx.deleteSchedule(scope, rec.key);
  tx.setFlag(scope, 'paused', false);
  tx.setFlag(scope, 'obliterating', false);
  return { removed: page.length, done: true };
}
