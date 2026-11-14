// The worker registry: one record per running worker, per namespace. Core only reads it to show who is running
// (queue.getWorkers) and to warn about version skew; claims, renewals and sweeps never look at it, so a lost or
// wiped record costs nothing but a listing until the worker's next heartbeat registers it again.
// Same rules as store.ts: each function checks its request first, then returns the body store.ts runs inside
// its one transaction with the one clock read.
import type { HeartbeatWorkerRequest, ListWorkersResult, NamespaceScope, RegisterWorkerRequest, RegisterWorkerResult } from '@sureq/core';
import type { TemplateBackend, Tx } from './backend.js';
import { bool, check, int, isObj, oneOf, text } from './check.js';

type Body<T> = (tx: Tx, now: number) => T;

const MAX_PURGE_LIMIT = 1000;
const REGISTER = {
  workerId: text, queues: (v: unknown) => Array.isArray(v) && v.every(text), names: (v: unknown) => Array.isArray(v) && v.every((n) => n === null || typeof n === 'string'),
  concurrency: int(1), sureqVersion: text, formatVersion: int(1), heartbeatIntervalMs: int(1), host: (v: unknown) => typeof v === 'string',
  pid: (v: unknown) => v === null || int(0)(v), labels: (v: unknown) => isObj(v) && Object.values(v).every((x) => typeof x === 'string'), scheduler: bool,
};
const HEARTBEAT = { workerId: text, activeJobs: int(0), concurrency: int(1), status: oneOf('running', 'paused', 'draining'), scheduler: bool };

/** A namespace-wide call (rules 1 and 2): open check, scope check, one transaction, one clock read; `ready` runs again inside it. */
export function inNamespace<T>(backend: TemplateBackend, ready: () => void, op: string, ns: NamespaceScope, body: Body<T>): Promise<T> {
  ready();
  check(op, 'scope', ns, { namespace: text }, ['namespace']);
  // WHY: a call queued before close must not be served after it.
  return backend.transact((tx) => (ready(), body(tx, backend.serverNow())));
}

/*
 * SUREQ-CONTRACT: registerWorker
 * WHY: an upsert that keeps nothing of an old record: a worker whose record was purged registers again under the
 * same id with a new `startedAt`. `startedAt` and `lastHeartbeatAt` are both store now; a new record runs, idle.
 */
export function registerWorker(ns: NamespaceScope, req: RegisterWorkerRequest): Body<RegisterWorkerResult> {
  check('registerWorker', 'request', req, REGISTER, Object.keys(REGISTER).filter((k) => k !== 'names'));
  return (tx, now) => {
    const { names, ...rest } = req;
    // REPLACE-ME: one upsert keyed (namespace, worker_id): SQL INSERT ... ON CONFLICT DO UPDATE on a workers table, Redis HSET on a hash per namespace plus ZADD on a set by heartbeat, Mongo replaceOne with upsert.
    tx.putWorker(ns.namespace, { ...rest, names: names ?? null, activeJobs: 0, status: 'running', startedAt: now, lastHeartbeatAt: now });
    return { startedAt: now, now };
  };
}

/*
 * SUREQ-CONTRACT: heartbeatWorker
 * WHY: refreshes `lastHeartbeatAt` to store now with the worker's counters; a record that is gone is not
 * recreated (`ok: false`), so the worker knows to register again.
 */
export function heartbeatWorker(ns: NamespaceScope, req: HeartbeatWorkerRequest): Body<{ ok: boolean }> {
  check('heartbeatWorker', 'request', req, HEARTBEAT, Object.keys(HEARTBEAT));
  return (tx, now) => {
    const rec = tx.getWorker(ns.namespace, req.workerId);
    if (!rec) return { ok: false };
    const { activeJobs, concurrency, status, scheduler } = req;
    tx.putWorker(ns.namespace, { ...rec, activeJobs, concurrency, status, scheduler, lastHeartbeatAt: now });
    return { ok: true };
  };
}

/*
 * SUREQ-CONTRACT: unregisterWorker
 * WHY: a graceful shutdown deletes the record; deleting one that is gone is not an error.
 */
export function unregisterWorker(ns: NamespaceScope, req: { workerId: string }): Body<void> {
  check('unregisterWorker', 'request', req, { workerId: text }, ['workerId']);
  return (tx) => tx.deleteWorker(ns.namespace, req.workerId);
}

/*
 * SUREQ-CONTRACT: listWorkers
 * WHY: every record of the namespace, or those whose `queues` include `queue`, with store now: core judges
 * liveness as `now - lastHeartbeatAt` on the store's one clock, never a pod's.
 */
export function listWorkers(ns: NamespaceScope, req: { queue?: string }): Body<ListWorkersResult> {
  check('listWorkers', 'request', req, { queue: text });
  return (tx, now) => {
    // REPLACE-ME: a read of the namespace's records: SQL SELECT ... WHERE namespace = $1 AND $queue = ANY(queues), Redis HGETALL on the namespace hash, Mongo find({ namespace, queues: queue }).
    const workers = tx.scanWorkers(ns.namespace).filter((w) => req.queue === undefined || w.queues.includes(req.queue));
    return { workers, now };
  };
}

/*
 * SUREQ-CONTRACT: purgeWorkers
 * WHY: deletes at most `limit` records whose `lastHeartbeatAt` is before `now - staleIntervals × heartbeatIntervalMs`, by
 * store time and each by its own interval, so a worker that beats slowly is never purged at a faster worker's pace; a
 * dead worker's record goes away without anyone unregistering it.
 */
export function purgeWorkers(ns: NamespaceScope, req: { staleIntervals: number; limit: number }): Body<{ removed: number }> {
  check('purgeWorkers', 'request', req, { staleIntervals: int(0), limit: int(1, MAX_PURGE_LIMIT) }, ['staleIntervals', 'limit']);
  return (tx, now) => {
    // REPLACE-ME: a bounded delete on a stale-at index: staleIntervals is per request, so never store the cutoff: SQL DELETE ... WHERE last_heartbeat_at < now - $n * heartbeat_interval_ms LIMIT n (or a CTE), Redis a sorted set scored by last heartbeat then the same check per member and HDEL, Mongo a $expr filter with deleteMany by id.
    const stale = tx.scanWorkers(ns.namespace).filter((w) => w.lastHeartbeatAt < now - req.staleIntervals * w.heartbeatIntervalMs).slice(0, req.limit);
    for (const w of stale) tx.deleteWorker(ns.namespace, w.workerId);
    return { removed: stale.length };
  };
}
