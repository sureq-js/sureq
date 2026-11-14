import type { ClaimHistoryOption, JobRecord, Payload, StoredAttempt } from '../contract.js';

/** The `history` field of a request; absent means on with the default cap. */
export type HistoryExt = ClaimHistoryOption | undefined;

/** Records kept per job when a request does not name a cap. */
export const DEFAULT_MAX_RECORDS = 50;

/** How an attempt ended. */
export interface AttemptEnd {
  outcome: 'completed' | 'failed' | 'crashed' | 'cancelled' | 'released';
  endedBy: 'worker' | 'sweeper' | 'cancel' | 'shutdown';
  error: Payload | null;
}

/** Drop the oldest closed rows while the job has more than `max`; the running row is never dropped. Returns how many went. */
function cap(rows: StoredAttempt[], ext: HistoryExt): number {
  const max = (ext ? ext.max : undefined) ?? DEFAULT_MAX_RECORDS;
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
 * Open the running row of the attempt `rec` was just claimed for (`rec` already carries the new token and
 * attempt, `runAt` is still the one it waited for). Returns how many rows the cap dropped.
 */
export function openAttempt(rows: StoredAttempt[], rec: JobRecord, now: number, workerId: string, ext: HistoryExt): number {
  if (ext === false) return 0;
  rows.push({
    formatVersion: rec.formatVersion, jobId: rec.id, attempt: rec.attempt, cycle: rec.redriveCount, token: rec.token, workerId,
    host: ext?.host ?? null, startedAt: now, finishedAt: null, durationMs: null, waitMs: now - rec.runAt, batchId: null, heldMs: null,
    outcome: 'running', error: null, endedBy: null, lastRenewAt: now,
  });
  return cap(rows, ext);
}

/**
 * Close the row of the attempt holding `token`. A job claimed without a row (history off, or a pod that wrote
 * none) gets a closed row built from the record, so a closer never fails for a missing row. Call it before the
 * closer edits the record's `runAt`, `attempt` or lease. Returns how many rows the cap dropped.
 */
export function closeAttempt(rows: StoredAttempt[], rec: JobRecord, token: number, now: number, end: AttemptEnd, ext: HistoryExt): number {
  if (ext === false) return 0;
  let row = rows.find((r) => r.token === token);
  if (!row) {
    const startedAt = rec.startedAt ?? now;
    row = {
      formatVersion: rec.formatVersion, jobId: rec.id, attempt: rec.attempt, cycle: rec.redriveCount, token,
      workerId: rec.lease?.owner ?? rec.workerId ?? '', host: null, startedAt, finishedAt: null, durationMs: null,
      waitMs: Math.max(0, startedAt - rec.runAt), batchId: null, heldMs: null, outcome: 'running', error: null, endedBy: null, lastRenewAt: startedAt,
    };
    const at = rows.findIndex((r) => r.token > token);
    rows.splice(at < 0 ? rows.length : at, 0, row);
  }
  closeRow(row, now, end);
  return cap(rows, ext);
}

function closeRow(row: StoredAttempt, now: number, end: AttemptEnd): void {
  if (row.outcome === 'running') Object.assign(row, { ...end, finishedAt: now, durationMs: now - row.startedAt });
}

/** Close the open row of the attempt holding `token` when there is one; inserts nothing and drops nothing. */
export function closeOpenAttempt(rows: StoredAttempt[] | undefined, token: number, now: number, end: AttemptEnd): void {
  const row = rows?.find((r) => r.token === token);
  if (row) closeRow(row, now, end);
}

/** A successful renew: the row's last renew time; with `batchId`, the batch and the time the lease was held before the handler started. */
export function noteRenew(rows: StoredAttempt[] | undefined, token: number, now: number, batchId?: string): void {
  const row = rows?.find((r) => r.token === token);
  if (!row) return;
  row.lastRenewAt = now;
  if (batchId !== undefined) Object.assign(row, { batchId, heldMs: now - row.startedAt });
}
