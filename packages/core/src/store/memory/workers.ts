import type { HeartbeatWorkerRequest, ListWorkersResult, RegisterWorkerRequest, RegisterWorkerResult, WorkerRecord } from '../contract.js';

/** One namespace's worker registry records by worker id. */
export type WorkerTable = Map<string, WorkerRecord>;

/** Create or replace the record: nothing of an old one is kept. */
export function registerWorker(table: WorkerTable, req: RegisterWorkerRequest, now: number): RegisterWorkerResult {
  const { names, ...rest } = structuredClone(req);
  table.set(req.workerId, { ...rest, names: names ?? null, activeJobs: 0, status: 'running', startedAt: now, lastHeartbeatAt: now });
  return { startedAt: now, now };
}

export function heartbeatWorker(table: WorkerTable, req: HeartbeatWorkerRequest, now: number): { ok: boolean } {
  const rec = table.get(req.workerId);
  if (!rec) return { ok: false };
  Object.assign(rec, { activeJobs: req.activeJobs, concurrency: req.concurrency, status: req.status, scheduler: req.scheduler, lastHeartbeatAt: now });
  return { ok: true };
}

export function listWorkers(table: WorkerTable, queue: string | undefined, now: number): ListWorkersResult {
  const workers = [...table.values()].filter((w) => queue === undefined || w.queues.includes(queue));
  return { workers: structuredClone(workers), now };
}

/** Delete up to `limit` records whose last heartbeat is older than `now - staleIntervals × heartbeatIntervalMs`, each by its own interval. */
export function purgeWorkers(table: WorkerTable, req: { staleIntervals: number; limit: number }, now: number): { removed: number } {
  let removed = 0;
  for (const [id, rec] of table) {
    if (removed >= req.limit) break;
    if (rec.lastHeartbeatAt >= now - req.staleIntervals * rec.heartbeatIntervalMs) continue;
    table.delete(id);
    removed++;
  }
  return { removed };
}
