import type { ConnectionState, StoreClient } from '../store/client.js';
import type { WorkerState } from '../worker/lifecycle.js';
import type { AlertEvent } from '../metrics/alerts.js';
import { platform, type Timer } from '../platform/index.js';

/** An advisory finding in a health report. */
export interface HealthWarning {
  /** A stable code for the advice, such as `'DEAD_LETTERS_HIGH'`. */
  code: string;
  /** The advice, in words. */
  message: string;
}

/** What `queue.health()` returns: a liveness answer that never depends on the store, and a readiness answer. */
export interface HealthReport {
  /** Every running worker's loop is alive. Use for liveness probes. */
  live: boolean;
  /** The store answered, it is connected, and the queue is not closing. Use for readiness probes. */
  ready: boolean;
  /** `'down'` when not live; `'degraded'` when not ready, a renewal is late, the queue is paused, or there is a warning or firing alert; else `'ok'`. */
  status: 'ok' | 'degraded' | 'down';
  /** Pod time of the check, informational. */
  checkedAt: number;
  /** `durable`: the store's capability flag; false means acknowledged jobs are lost when the store restarts. */
  store: { ok: boolean; latencyMs: number | null; state: ConnectionState; durable: boolean; error?: string };
  /** One entry per worker of this queue object on this pod. */
  workers: Array<{
    workerId: string;
    state: WorkerState;
    paused: boolean;
    loopAlive: boolean;
    /** Pod time of the worker's last loop tick, derived from the monotonic clock. */
    lastLoopAt: number | null;
    activeJobs: number;
    renewals: { onTime: boolean; lateJobs: number; worstLagMs: number };
  }>;
  /** The pause flag as this pod last saw it. */
  queue: { paused: boolean };
  /**
   * The namespace's stored format (null before it was read) and the formats this pod reads. `degraded` is the last
   * seen degraded state: the pod stopped claiming because the store moved past it; checks pause while no worker runs.
   */
  format: { storeFormat: number | null; supported: { min: number; max: number }; degraded: boolean };
  /** Advice about the queue's setup or state. */
  warnings: HealthWarning[];
  /** This pod's firing alerts; any makes `status` `'degraded'`, never `live: false`. */
  alerts: AlertEvent[];
}

/** A worker's view for the report (`Worker#healthSnapshot`). */
export interface WorkerSnapshot {
  state: WorkerState;
  paused: boolean;
  tickAgeMs: number | null;
  activeJobs: number;
  renewals: { onTime: boolean; lateJobs: number; worstLagMs: number };
  loopDeadAfterMs: number;
}

/** The narrow view of a queue the report is built from. */
export interface HealthHost {
  readonly client: StoreClient;
  /** The connection state as the report shows it. */
  state(): ConnectionState;
  workers(): Iterable<{ readonly id: string; healthSnapshot(): WorkerSnapshot }>;
  isPaused(): boolean;
  isClosing(): boolean;
  format(): HealthReport['format'];
  /** The queue's scheduler, when it has one; `lastTurnAt` and `startedAt` are `platform.monotonicMs()` values. */
  scheduler(): { running: boolean; lastTurnAt: number | undefined; startedAt: number; tickMs: number } | undefined;
  /** The queue has schedules and no live worker runs a scheduler, as the registry check last saw it (cached, no I/O). */
  noSchedulerRunning(): boolean;
  alerts(): AlertEvent[];
  /** The dead-letter count of the last periodic stats read and the warning level; undefined before one, or with no warning. */
  deadLetters(): { count: number; warnAbove: number } | undefined;
  /** This pod's running sweeper; the times are `platform.monotonicMs()` values. */
  sweeper(): { lastTickAt: number | undefined; startedAt: number; intervalMs: number } | undefined;
}

/** A running worker whose loop has not ticked for longer than this is dead. */
export function loopDeadAfterMs(pollMax: number): number {
  return Math.max(3 * pollMax, 10_000);
}

const TIMEOUT = Symbol('timeout');

/** The message chain of whatever a store threw; never throws itself (getters, null prototypes, proxies). */
function describe(e: unknown): string {
  const parts: string[] = [];
  try {
    for (let c = e, i = 0; c !== undefined && c !== null && i < 5; i++) {
      if (typeof c !== 'object') {
        parts.push(String(c));
        break;
      }
      const message: unknown = (c as { message?: unknown }).message;
      parts.push(typeof message === 'string' ? message : 'unknown error');
      c = (c as { cause?: unknown }).cause;
    }
  } catch {
    parts.push('unknown error');
  }
  return parts.join(': ') || 'unknown error';
}

/** One `now()` call, bounded by `timeoutMs`; never rejects. Not probed unless connected. */
async function checkStore(host: HealthHost, timeoutMs: number): Promise<Omit<HealthReport['store'], 'durable'>> {
  const before = host.state();
  if (before !== 'connected') return { ok: false, latencyMs: null, state: before, error: `store is ${before}` };
  const started = platform.monotonicMs();
  const call = host.client.call('now');
  // Abandoned at the timeout: its late failure must not surface as unhandled.
  call.catch(() => {});
  let timer: Timer | undefined;
  try {
    await Promise.race([call, new Promise((_, reject) => (timer = platform.setTimer(() => reject(TIMEOUT), timeoutMs, { ref: true })))]);
    return { ok: true, latencyMs: platform.monotonicMs() - started, state: host.state() };
  } catch (e) {
    return { ok: false, latencyMs: null, state: host.state(), error: e === TIMEOUT ? 'timeout' : describe(e) };
  } finally {
    timer?.cancel();
  }
}

/**
 * Build the report; the store check is the only I/O and nothing is cached. Never rejects: an internal
 * failure gives a report with `store.error: 'unknown'` and no worker entries, live (a bug here must not
 * restart the pod) but not ready.
 */
export async function buildHealth(host: HealthHost, opts: { timeoutMs: number }): Promise<HealthReport> {
  try {
    return report(host, { ...(await checkStore(host, opts.timeoutMs)), durable: host.client.capabilities.durable });
  } catch {
    const store = { ok: false, latencyMs: null, state: 'closed' as ConnectionState, durable: false, error: 'unknown' };
    try {
      store.state = host.state();
    } catch {
      // keep 'closed'
    }
    try {
      store.durable = host.client.capabilities.durable;
    } catch {
      // keep false
    }
    const format: HealthReport['format'] = { storeFormat: null, supported: { min: 0, max: 0 }, degraded: false };
    try {
      const { minReadable: min, maxReadable: max } = host.client.__formatSupport;
      format.supported = { min, max };
    } catch {
      // keep the empty range
    }
    return { live: true, ready: false, status: 'degraded', checkedAt: Date.now(), store, workers: [], queue: { paused: false }, format, warnings: [], alerts: [] };
  }
}

function report(host: HealthHost, store: HealthReport['store']): HealthReport {
  const now = Date.now();
  const workers = [...host.workers()].map((w) => {
    const s = w.healthSnapshot();
    // Only a running loop is judged: created and stopped ones have none, a stopping one ends on purpose.
    const judged = s.state === 'running' && store.state !== 'reconnecting';
    const loopAlive = !judged || s.tickAgeMs === null || s.tickAgeMs <= s.loopDeadAfterMs;
    return {
      workerId: w.id, state: s.state, paused: s.paused, loopAlive, lastLoopAt: s.tickAgeMs === null ? null : now - s.tickAgeMs,
      activeJobs: s.activeJobs, renewals: s.renewals,
    };
  });
  const paused = host.isPaused();
  const live = workers.every((w) => w.loopAlive);
  const format = host.format();
  const { storeFormat: f, supported } = format;
  const unreadable = format.degraded || (f !== null && (f > supported.max || f < supported.min));
  const ready = store.ok && store.state === 'connected' && !host.isClosing() && !unreadable;
  const warnings: HealthWarning[] = [];
  if (format.degraded || (f !== null && f > supported.max)) {
    warnings.push({ code: 'STORE_FORMAT_AHEAD', message: `the store namespace is at format ${String(f)}, newer than this pod reads (up to ${supported.max}); no job is claimed and no schedule fires` });
  }
  if (paused) warnings.push({ code: 'QUEUE_PAUSED', message: 'the queue is paused globally; no job is claimed until resume()' });
  const lateJobs = workers.reduce((n, w) => n + w.renewals.lateJobs, 0);
  if (lateJobs > 0) warnings.push({ code: 'RENEWALS_LATE', message: `${lateJobs} running job(s) have not renewed their lease on time` });
  if (store.state === 'reconnecting') warnings.push({ code: 'STORE_RECONNECTING', message: 'the store is not connected; reconnecting' });
  const s = host.scheduler();
  if (s?.running && store.state !== 'reconnecting' && platform.monotonicMs() - (s.lastTurnAt ?? s.startedAt) > 5 * s.tickMs) {
    warnings.push({ code: 'SCHEDULER_STALE', message: 'the scheduler has not finished a loop turn in 5 x tickMs' });
  }
  if (host.noSchedulerRunning()) {
    warnings.push({
      code: 'NO_SCHEDULER_RUNNING',
      message: 'the queue has unpaused schedules but no live worker reports a running scheduler; a scheduler started by startScheduler() on a pod without a worker is not seen',
    });
  }
  const sw = host.sweeper();
  // a degraded pod's sweeper skips its ticks on purpose; STORE_FORMAT_AHEAD already says why
  if (sw && store.state !== 'reconnecting' && !format.degraded && platform.monotonicMs() - (sw.lastTickAt ?? sw.startedAt) > 5 * sw.intervalMs) {
    warnings.push({ code: 'SWEEP_STALLED', message: 'the sweeper has not finished a tick in 5 x sweepInterval' });
  }
  const dl = host.deadLetters();
  if (dl && dl.count > dl.warnAbove) {
    warnings.push({ code: 'DEAD_LETTERS_HIGH', message: `${dl.count} dead letters, above deadLetter.warnAbove (${dl.warnAbove})` });
  }
  const alerts = host.alerts();
  const status = !live ? 'down' : !ready || lateJobs > 0 || paused || warnings.length > 0 || alerts.length > 0 ? 'degraded' : 'ok';
  return { live, ready, status, checkedAt: now, store, workers, queue: { paused }, format, warnings, alerts };
}
