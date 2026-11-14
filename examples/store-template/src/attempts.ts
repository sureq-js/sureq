// Attempt records: one row per attempt of a job, opened by the claim and closed by the call that ends the attempt
// (complete, fail, release, sweep, cancel), in the same transaction as the job change. Rows are keyed by the
// fencing token, which never repeats, so a refunded attempt number never merges two attempts.
import type { GetAttemptsRequest, GetAttemptsResult, JobRecord, Payload, Scope, StoredAttempt } from '@sureq/core';
import type { Tx } from './backend.js';
import { check, int, isObj, text, type Pred } from './check.js';

/** The `history` field of a request: absent means on with the default cap of 50 records per job. */
export type HistoryExt = false | { max?: number; host?: string | null } | undefined;

const DEFAULT_MAX = 50;
const MAX_PAGE = 1000;

/** The `history` check: `false`, or `{ max?: integer >= 1 }`; only the claim also names the `host`. */
export const historyOf = (claim: boolean): Pred => (v) => v === false || (isObj(v) &&
  Object.keys(v).every((k) => k === 'max' || (claim && k === 'host')) &&
  (v['max'] === undefined || int(1)(v['max'])) && (v['host'] === undefined || v['host'] === null || typeof v['host'] === 'string'));

/** Drop the oldest closed rows while the job has more than the cap; the running row stays. Returns how many went. */
function cap(rows: StoredAttempt[], ext: HistoryExt): number {
  const max = (ext ? ext.max : undefined) ?? DEFAULT_MAX;
  let dropped = 0;
  while (rows.length > max) {
    const i = rows.findIndex((r) => r.outcome !== 'running');
    if (i < 0) break;
    rows.splice(i, 1);
    dropped += 1;
  }
  return dropped;
}

/**
 * The claim opens the running row; `rec` already carries the new token and attempt, `runAt` is the one it waited for.
 * WHY: the cap counts are added to the job's `attemptsTruncated` by the caller, in the same transaction.
 */
export function openAttempt(tx: Tx, scope: Scope, rec: JobRecord, now: number, workerId: string, ext: HistoryExt): void {
  if (ext === false) return;
  const rows = tx.getAttempts(scope, rec.id);
  rows.push({
    formatVersion: rec.formatVersion, jobId: rec.id, attempt: rec.attempt, cycle: rec.redriveCount, token: rec.token, workerId,
    host: ext?.host ?? null, startedAt: now, finishedAt: null, durationMs: null, waitMs: now - rec.runAt, batchId: null, heldMs: null,
    outcome: 'running', error: null, endedBy: null, lastRenewAt: now,
  });
  rec.attemptsTruncated += cap(rows, ext);
  tx.setAttempts(scope, rec.id, rows);
}

/**
 * A cancel without `history` (a producer keeps no history settings) only ends the open row of the attempt holding `token`.
 * WHY: it applies no cap and inserts no row, so it never trims or adds to what the job's workers keep.
 */
export function closeOpenAttempt(tx: Tx, scope: Scope, rec: JobRecord, token: number, now: number): void {
  const rows = tx.getAttempts(scope, rec.id);
  const row = rows.find((r) => r.token === token && r.outcome === 'running');
  if (!row) return;
  Object.assign(row, { outcome: 'cancelled', endedBy: 'cancel', error: null, finishedAt: now, durationMs: now - row.startedAt });
  tx.setAttempts(scope, rec.id, rows);
}

/**
 * A closer ends the row of the attempt holding `token`. Call it before the closer edits `runAt`, `attempt` or the lease.
 * WHY: a job claimed without a row (history off, or a pod of an older release) gets a closed row built from the job, so a
 * closer never fails for a missing row.
 */
export function closeAttempt(
  tx: Tx, scope: Scope, rec: JobRecord, token: number, now: number,
  end: { outcome: 'completed' | 'failed' | 'crashed' | 'cancelled' | 'released'; endedBy: 'worker' | 'sweeper' | 'cancel' | 'shutdown'; error: Payload | null },
  ext: HistoryExt,
): void {
  if (ext === false) return;
  const rows = tx.getAttempts(scope, rec.id);
  let row = rows.find((r) => r.token === token);
  if (!row) {
    const startedAt = rec.startedAt ?? now;
    row = {
      formatVersion: rec.formatVersion, jobId: rec.id, attempt: rec.attempt, cycle: rec.redriveCount, token, workerId: rec.lease?.owner ?? rec.workerId ?? '',
      host: null, startedAt, finishedAt: null, durationMs: null, waitMs: Math.max(0, startedAt - rec.runAt), batchId: null, heldMs: null,
      outcome: 'running', error: null, endedBy: null, lastRenewAt: startedAt,
    };
    const at = rows.findIndex((r) => r.token > token);
    rows.splice(at < 0 ? rows.length : at, 0, row);
  }
  if (row.outcome === 'running') Object.assign(row, { ...end, finishedAt: now, durationMs: now - row.startedAt });
  rec.attemptsTruncated += cap(rows, ext);
  tx.setAttempts(scope, rec.id, rows);
}

/** A successful renew records its time; one with `started` and `batchId` also the batch and how long the lease was held before the handler started. */
export function noteRenew(tx: Tx, scope: Scope, id: string, token: number, now: number, batchId: string | undefined): void {
  const rows = tx.getAttempts(scope, id);
  const row = rows.find((r) => r.token === token);
  if (!row) return;
  row.lastRenewAt = now;
  if (batchId !== undefined) Object.assign(row, { batchId, heldMs: now - row.startedAt });
  tx.setAttempts(scope, id, rows);
}

/** The request check of `getAttempts`; the cursor is the decimal token of the last record of the previous page. */
export function checkGetAttempts(req: GetAttemptsRequest): void {
  check('getAttempts', 'request', req, {
    id: text, limit: int(1, MAX_PAGE), cursor: (v) => typeof v === 'string' && /^\d{1,16}$/.test(v) && Number.isSafeInteger(Number(v)),
  }, ['id']);
}

/*
 * SUREQ-CONTRACT: getAttempts
 * WHY: one consistent read of a job's rows (a live id or a history key `id#seq`), ordered by token, after `cursor`.
 * WHY: `truncated` is the job's count of rows the cap dropped; an unknown id is an empty page, not an error.
 */
export function pageAttempts(tx: Tx, scope: Scope, req: GetAttemptsRequest): GetAttemptsResult {
  // REPLACE-ME: SQL SELECT ... FROM attempts WHERE namespace, queue, job_id AND token > $cursor ORDER BY token LIMIT $limit + 1, Redis LRANGE on the job's list, Mongo find({ jobId, token: { $gt } }).sort({ token: 1 }).limit().
  const after = req.cursor === undefined ? 0 : Number(req.cursor);
  const rows = tx.getAttempts(scope, req.id).filter((r) => r.token > after);
  const page = rows.slice(0, req.limit ?? 100);
  const truncated = (tx.get(scope, req.id) ?? tx.getHistory(scope, req.id))?.attemptsTruncated ?? 0;
  return { attempts: page, truncated, nextCursor: rows.length > page.length ? String(page.at(-1)!.token) : null };
}
