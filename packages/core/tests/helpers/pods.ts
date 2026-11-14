import { vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import type { BatchWorkerOptions, QueueOptions, WorkerOptions } from '../../src/queue/options.js';
import type { BatchHandler } from '../../src/worker/batch.js';
import type { JobHandler, Worker } from '../../src/worker/worker.js';
import type { JobRecord, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from './fake-time.js';
import { silent } from './harness.js';
import { poll } from './poll.js';

let dead = 0;

/** Claim one job as a worker `dead-N` straight through the store and never renew: a killed worker. */
export async function killClaim(store: Store, queueName: string, opts: { namespace?: string; leaseMs?: number; names?: Array<string | null> } = {}): Promise<JobRecord> {
  const scope = { namespace: opts.namespace ?? 'default', queue: queueName };
  const workerId = `dead-${++dead}`;
  const res = await store.claim(scope, { workerId, limit: 1, leaseMs: opts.leaseMs ?? 30_000, claimId: workerId, ...(opts.names && { names: opts.names }) });
  const rec = res.jobs[0];
  if (!rec) throw new TypeError(`killClaim: nothing to claim in ${queueName}`);
  return rec;
}

/**
 * A view of `inner` that can freeze like a dead or GC-paused pod: while frozen every call waits, and
 * `unfreeze()` lets the waiting calls through. `close` is a no-op, so closing a pod never closes the shared store.
 */
export function freezable(inner: Store): Store & { freeze(): void; unfreeze(): void; readonly frozen: boolean } {
  let thaw: Promise<void> | undefined;
  let release = () => {};
  const controls = {
    freeze() {
      thaw ??= new Promise<void>((r) => (release = r));
    },
    unfreeze() {
      release();
      thaw = undefined;
    },
    get frozen() {
      return thaw !== undefined;
    },
  };
  return new Proxy(inner, {
    get(target, key) {
      if (key in controls) return Reflect.get(controls, key);
      if (key === 'close') return async () => {};
      const v: unknown = Reflect.get(target, key);
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        if (thaw) await thaw;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Store & typeof controls;
}

/** A fast worker: fixed 50 ms poll, sweep every 500 ms exactly, no jitter. */
export const live: WorkerOptions = { ...poll(50), sweepInterval: 500, random: () => 0.5 };

/**
 * Pods sharing one MemoryStore whose clock is `clock.t`, moved by hand apart from the (fake) timers,
 * or the faked wall clock with `wallClock`. `pod()` makes one more Queue, optionally on its own freezable view.
 */
export function twoPods(opts: { name?: string; queue?: QueueOptions; wallClock?: boolean } = {}) {
  useFakeTime();
  const clock = { t: 5_000_000 };
  const store = new MemoryStore({ clock: opts.wallClock ? () => Date.now() : () => clock.t });
  const name = opts.name ?? 'pods';
  const queues: Queue[] = [];
  const views: Array<ReturnType<typeof freezable>> = [];
  const pod = (o: { queue?: QueueOptions; freezable?: boolean } = {}) => {
    const view = o.freezable ? freezable(store) : undefined;
    if (view) views.push(view);
    const queue = new Queue(name, { logger: silent, ...opts.queue, ...o.queue, store: view ?? store });
    queues.push(queue);
    return { queue, view };
  };
  const a = pod().queue;
  const b = pod().queue;
  const scope = a.internals.scope;
  /** Unfreeze every view and close every pod. */
  const teardown = async () => {
    for (const v of views) v.unfreeze();
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await Promise.all(queues.map((q) => q.close({ timeoutMs: 100 })));
  };
  return { store, clock, scope, a, b, pod, teardown };
}

/**
 * A worker blocked past its lease: pod A's handler, as it starts, moves the store clock 31 s on (the
 * time a blocked event loop would lose) and waits for `release`. Pod B, created afterwards, sweeps every
 * 500 ms and returns `'B'`. The heartbeat (10 s of pod time) never fires within the scenario.
 */
export async function blockedWorker() {
  const w = twoPods({ name: 'blocked' });
  const runs: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const events = { leaseLostA: vi.fn(), completedA: vi.fn(), failedA: vi.fn(), completed: vi.fn() };
  const { job } = await w.a.add({ n: 1 });
  const workerA = w.a.process(async () => {
    runs.push('A');
    w.clock.t += 31_000;
    await gate;
    return 'A';
  }, { ...poll(50), random: () => 0.5 });
  workerA.on('leaseLost', events.leaseLostA);
  workerA.on('completed', events.completedA);
  workerA.on('failed', events.failedA);
  w.a.on('completed', events.completed);
  w.b.on('completed', events.completed);
  await vi.advanceTimersByTimeAsync(10);
  const first = (await w.store.get(w.scope, job.id))!;
  w.b.process(() => {
    runs.push('B');
    return 'B';
  }, live);
  for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(600);
  const reclaimed = (await w.store.get(w.scope, job.id))!;
  release();
  await vi.advanceTimersByTimeAsync(10);
  return { ...w, job, runs, events, first, reclaimed };
}

/** A seeded pseudo-random source in [0, 1), so randomised tests repeat exactly. */
export function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
}

/** A view of `inner` whose calls fail at random with a raw connection error, or answer after a random delay. */
export function flaky(inner: Store, o: { random: () => number; errorRate: number; maxDelayMs: number }): Store {
  return new Proxy(inner, {
    get(target, key) {
      const v: unknown = Reflect.get(target, key);
      if (typeof v !== 'function' || key === 'open' || key === 'close') return typeof v === 'function' ? v.bind(target) : v;
      return async (...args: unknown[]) => {
        const delay = Math.floor(o.random() * o.maxDelayMs);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (o.random() < o.errorRate) throw new Error('ECONNRESET');
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * One simulated pod: a Queue over its own freezable view of the shared store, so core keeps one client per
 * pod. `kill()` freezes the view: the pod never answers, heartbeats or commits again, like a SIGKILL.
 */
export class Pod<D = unknown, R = unknown> {
  readonly view: ReturnType<typeof freezable>;
  readonly queue: Queue<D, R>;
  worker: Worker<D, R> | undefined;
  constructor(shared: Store, name: string, opts: QueueOptions<D> = {}) {
    this.view = freezable(shared);
    this.queue = new Queue<D, R>(name, { logger: silent, ...opts, store: this.view });
  }
  process(handler: JobHandler<D, R>, opts?: WorkerOptions): Worker<D, R> {
    this.worker = this.queue.process(handler, opts);
    return this.worker;
  }
  processBatch(opts: BatchWorkerOptions, handler: BatchHandler<D, R>): Worker<D, R> {
    this.worker = this.queue.processBatch(handler, opts);
    return this.worker;
  }
  kill(): void {
    this.view.freeze();
  }
}
