// Retention: the write that finishes a job deletes it or stamps when it may be deleted, and `clean` deletes by those rules.
import type { CleanRequest, JobRecord, RetentionDirective, Scope } from '@sureq/core';
import type { Tx } from './backend.js';
import { deleteJob } from './admin.js';
import { bad, int, isObj, safeAt, type Pred } from './check.js';

/** The `retention` field of a finishing write: `discard: true` or `retainMs` (>= 0), not both. */
export const retentionOf: Pred = (v) => isObj(v) && Object.keys(v).every((k) => k === 'discard' || k === 'retainMs') &&
  (v['discard'] === undefined || v['discard'] === true) && (v['retainMs'] === undefined || int(0)(v['retainMs'])) &&
  (v['discard'] === undefined || v['retainMs'] === undefined);

/**
 * Write a job that just finished, under the request's `retention`, in place of `tx.put`.
 * WHY: it runs after `lastFinal` is set, so a discarded job leaves a tombstone and a repeat of its write still answers.
 * WHY: a dead letter marked in this same write keeps its own `retainUntil` (`deadLetter.keepMs`); retention is ignored.
 * WHY: `retainUntil` is store time plus `retainMs`; without `retainMs` the job has no age limit.
 */
export function finish(op: string, tx: Tx, scope: Scope, rec: JobRecord, now: number, ext: RetentionDirective | undefined): void {
  if (rec.deadLetter === null && ext?.discard) return deleteJob(tx, scope, rec, now);
  if (rec.deadLetter === null) {
    if (ext?.retainMs !== undefined) safeAt(op, now + ext.retainMs, 'retention.retainMs puts retainUntil');
    rec.retainUntil = ext?.retainMs === undefined ? null : now + ext.retainMs;
  }
  tx.put(scope, rec);
}

/** `clean`'s retention fields: `keepLast` or `retainExpired` on a finished state only, `name` or `excludeNames`. */
export function checkCleanModes(req: CleanRequest): void {
  if (req.excludeNames !== undefined && !(Array.isArray(req.excludeNames) && req.excludeNames.every((n) => typeof n === 'string'))) bad('clean', 'excludeNames must be an array of strings');
  if (req.name !== undefined && req.excludeNames !== undefined) bad('clean', 'name and excludeNames cannot both be set');
  if (req.keepLast !== undefined && req.retainExpired === true) bad('clean', 'keepLast and retainExpired cannot both be set');
  if ((req.keepLast !== undefined || req.retainExpired === true) && (req.state === 'waiting' || req.state === 'delayed')) bad('clean', 'keepLast and retainExpired need a finished state');
}

/** The `name` / `excludeNames` filter; an unnamed job is never excluded. */
export const named = (rec: JobRecord, req: CleanRequest): boolean =>
  (req.name === undefined || rec.name === req.name) && !(rec.name !== null && req.excludeNames?.includes(rec.name));

/**
 * When `retainExpired` takes a record: at its `retainUntil`; with `olderThanMs`, a record a previous-release pod finished
 * (no `retainUntil`, no own `keep`, no dead letter, not `retained`) at `finishedAt + olderThanMs`.
 */
const expiryOf = (rec: JobRecord, req: CleanRequest): number | undefined =>
  rec.retainUntil ?? (req.olderThanMs !== undefined && rec.keep === null && rec.deadLetter === null && rec.uniqueWhile !== 'retained' && named(rec, req)
    ? rec.finishedAt! + req.olderThanMs : undefined);

/**
 * The jobs a retention `clean` matches, in the order it deletes them.
 * WHY: `retainExpired` goes oldest expiry first; `keepLast: n` skips the newest n by (finishedAt, seq) and never counts a
 * dead letter or a `retained` job (their ids or their `deadLetter.keep` decide), then takes only jobs at least `olderThanMs` old.
 */
export function retentionMatches(tx: Tx, scope: Scope, req: CleanRequest, now: number): JobRecord[] {
  if (req.retainExpired) {
    // REPLACE-ME: read expired jobs from an index on retain_until: SQL DELETE ... WHERE state = $1 AND retain_until <= now() LIMIT $2, Redis a ZSET on retainUntil with ZRANGEBYSCORE, Mongo a TTL-style index on retainUntil.
    // WHY: a superseded record (`id#seq`, read only by getAttempts) expires by the same rule as a live one; a superseded
    // dead letter is a dead letter still and never expires here.
    const hits = [...tx.scan(scope, { state: req.state }), ...tx.scanHistory(scope).filter((r) => r.state === req.state && r.deadLetter === null)].filter((r) => (expiryOf(r, req) ?? Infinity) <= now);
    return hits.sort((a, b) => expiryOf(a, req)! - expiryOf(b, req)! || a.seq - b.seq);
  }
  // REPLACE-ME: skip the newest n in one query: SQL ROW_NUMBER() OVER (ORDER BY finished_at DESC, seq DESC) > n, Redis ZREVRANGE from n on a finishedAt sorted set, Mongo sort({ finishedAt: -1, seq: -1 }).skip(n).
  const ranked = tx.scan(scope, { state: req.state, order: { by: 'finishedAt', dir: 'desc' } }).filter((r) => named(r, req) && r.deadLetter === null && r.uniqueWhile !== 'retained');
  return ranked.slice(req.keepLast).filter((r) => now - r.finishedAt! >= (req.olderThanMs ?? 0)).reverse();
}
