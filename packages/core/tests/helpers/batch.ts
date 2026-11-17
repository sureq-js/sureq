import { vi } from 'vitest';
import type { Logger } from '../../src/logger/logger.js';
import { Queue } from '../../src/queue/queue.js';
import type { BatchWorkerOptions, QueueOptions } from '../../src/queue/options.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { BatchHandler, BatchJob } from '../../src/worker/batch.js';
import { useFakeTime } from './fake-time.js';
import { silent } from './harness.js';
import { poll } from './poll.js';
import { spyStore } from './spy-store.js';

/** Queues made by `batchSetup`; close them in `afterEach` with `closeBatchQueues`. */
const queues: Queue[] = [];
export async function closeBatchQueues(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
}

export const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
export const steady = { ...poll(50), random: () => 0.5, sweepInterval: 3_600_000, acknowledgeVolatileStore: true };
type Over = Parameters<typeof spyStore>[1];

/** A queue on a spied MemoryStore (store clock = faked wall clock unless `inner` is given) and a recording batch worker. */
export function batchSetup(o: { over?: (inner: MemoryStore) => Over; inner?: MemoryStore; queue?: QueueOptions } = {}) {
  useFakeTime();
  const inner = o.inner ?? new MemoryStore({ clock: () => Date.now() });
  const spy = spyStore(inner, o.over?.(inner));
  // Typed mocks: TypeScript 7 refuses to write vi.fn()'s default type (a Vitest internal) into a declaration.
  const logger = { debug: vi.fn<Logger['debug']>(), info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() };
  const q = new Queue('b', { logger, leaseDuration: '30s', shutdownAbortGrace: 0, ...o.queue, store: spy.store });
  queues.push(q);
  const t0 = performance.now();
  const calls: Array<{ at: number; ids: string[]; jobs: BatchJob[] }> = [];
  const run = (opts: BatchWorkerOptions, body?: BatchHandler) =>
    q.processBatch(async (batch, ctx) => {
      calls.push({ at: performance.now() - t0, ids: batch.jobs.map((j) => j.id), jobs: [...batch.jobs] });
      return body?.(batch, ctx);
    }, { ...steady, ...opts });
  const ops = (op: string) => spy.calls.filter((c) => c.op === op);
  /** Another queue object on the same store (another pod). */
  const other = () => {
    const p = new Queue('b', { logger: silent, leaseDuration: '30s', ...o.queue, store: inner });
    queues.push(p);
    return p;
  };
  return { inner, spy, q, scope: q.internals.scope, calls, run, ops, t0, logger, other };
}

export const ids = (n: number, prefix = 'j') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
export async function addAll(q: Queue, list: string[], opts: Record<string, unknown> = {}): Promise<void> {
  for (const id of list) await q.add({ id }, { id, ...opts });
}
