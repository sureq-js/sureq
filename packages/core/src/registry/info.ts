import type { ListWorkersResult, WorkerStatus } from '../store/contract.js';

/** One worker as `queue.getWorkers()` lists it; times are store epoch ms. */
export interface WorkerInfo {
  /** The worker's id. */
  workerId: string;
  /** The worker option `host`, default the host name. */
  host: string;
  /** Its process id, or null. */
  pid: number | null;
  /** The queues it serves. */
  queues: string[];
  /** Its concurrency. */
  concurrency: number;
  /** Jobs it was running at its last heartbeat. */
  activeJobs: number;
  /** `'running'`, `'paused'` or `'draining'` (closing). */
  status: WorkerStatus;
  /** Its SureQ release. */
  sureqVersion: string;
  /** The record format it writes. */
  formatVersion: number;
  /** This worker's queue runs a scheduler on its pod. */
  scheduler: boolean;
  /** When it registered, in store time. */
  startedAt: number;
  /** When it last heartbeat, in store time. */
  lastHeartbeatAt: number;
  /** Age of that heartbeat by store time. */
  heartbeatAgeMs: number;
  /** Not heard from for more than three of its own heartbeat intervals. */
  stale: boolean;
  /** The worker option `labels`. */
  labels: Record<string, string>;
}

/** A record is live while its last heartbeat is at most this many of its own intervals old. */
export const LIVE_INTERVALS = 3;

/** Records as `WorkerInfo`, judged by the store's `now`: live ones only unless `includeStale`, by `startedAt` then `workerId`. */
export function toWorkerInfos(res: ListWorkersResult, opts: { includeStale: boolean }): WorkerInfo[] {
  const out: WorkerInfo[] = [];
  for (const w of res.workers) {
    const heartbeatAgeMs = res.now - w.lastHeartbeatAt;
    const stale = heartbeatAgeMs > LIVE_INTERVALS * w.heartbeatIntervalMs;
    if (stale && !opts.includeStale) continue;
    out.push({
      workerId: w.workerId, host: w.host, pid: w.pid, queues: [...w.queues], concurrency: w.concurrency, activeJobs: w.activeJobs, status: w.status,
      sureqVersion: w.sureqVersion, formatVersion: w.formatVersion, scheduler: w.scheduler, startedAt: w.startedAt, lastHeartbeatAt: w.lastHeartbeatAt,
      heartbeatAgeMs, stale, labels: { ...w.labels },
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0));
}
