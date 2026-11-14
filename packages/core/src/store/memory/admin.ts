import type { CleanRequest, JobRecord } from '../contract.js';

/** The age reference of a job for `clean`: when it finished, or when it was added for a waiting or delayed job. */
const refOf = (rec: JobRecord): number => (rec.state === 'waiting' || rec.state === 'delayed' ? rec.createdAt : rec.finishedAt ?? rec.createdAt);

/** The `name` / `excludeNames` filter; an unnamed job is never excluded. */
const named = (rec: JobRecord, req: CleanRequest): boolean =>
  (req.name === undefined || rec.name === req.name) && !(rec.name !== null && req.excludeNames?.includes(rec.name));

/** An age-mode clean of failed jobs: the one mode that also deletes superseded dead letters. */
export const cleansDeadLetters = (req: CleanRequest): boolean => req.state === 'failed' && !req.retainExpired && req.keepLast === undefined;

/**
 * When a finished record expires for `retainExpired`: its `retainUntil`, or, with `olderThanMs`, `finishedAt + olderThanMs`
 * for a record a previous-release pod finished (no `retainUntil`, no own `keep`, no dead letter, not `retained`); else never.
 */
export function expiryOf(rec: JobRecord, req: CleanRequest): number | undefined {
  if (rec.retainUntil !== null) return rec.retainUntil;
  const legacy = req.olderThanMs !== undefined && rec.keep === null && rec.deadLetter === null && rec.uniqueWhile !== 'retained' && named(rec, req);
  return legacy ? (rec.finishedAt ?? rec.createdAt) + req.olderThanMs! : undefined;
}

/** True for a finished record of the request's state that `retainExpired` deletes at `now`. */
export const isExpired = (rec: JobRecord, req: CleanRequest, now: number): boolean => {
  const at = rec.state === req.state ? expiryOf(rec, req) : undefined;
  return at !== undefined && at <= now;
};

/**
 * The records `clean` deletes, up to `limit`; `remaining` is true when a match was left over. Plain: `seq` order.
 * `retainExpired`: expired first. `keepLast`: past the newest `n` by `finishedAt` then `seq`, oldest first, never a dead letter or a `retained` job.
 */
export function selectClean(records: Iterable<JobRecord>, req: CleanRequest, now: number): { pick: JobRecord[]; remaining: boolean } {
  const olderThanMs = req.olderThanMs ?? 0;
  let matches: JobRecord[] = [];
  if (req.retainExpired) {
    for (const rec of records) if (isExpired(rec, req, now)) matches.push(rec);
    matches.sort((a, b) => expiryOf(a, req)! - expiryOf(b, req)! || a.seq - b.seq);
  } else if (req.keepLast !== undefined) {
    for (const rec of records) if (rec.state === req.state && named(rec, req) && rec.deadLetter === null && rec.uniqueWhile !== 'retained') matches.push(rec);
    matches.sort((a, b) => b.finishedAt! - a.finishedAt! || b.seq - a.seq);
    matches = matches.slice(req.keepLast).filter((rec) => now - rec.finishedAt! >= olderThanMs).reverse();
  } else {
    for (const rec of records) if (rec.state === req.state && named(rec, req) && now - refOf(rec) >= olderThanMs) matches.push(rec);
    matches.sort((a, b) => a.seq - b.seq);
  }
  return { pick: matches.slice(0, req.limit), remaining: matches.length > req.limit };
}
