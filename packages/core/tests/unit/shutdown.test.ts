import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError, JobCancelledError, StoreError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { StoreOp } from '../../src/store/types.js';
import type { QueueOptions } from '../../src/queue/options.js';
import type { JobRecord, ReleaseRequest } from '../../src/store/contract.js';
import { next, silent } from '../helpers/harness.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { spyStore } from '../helpers/spy-store.js';

type Hook = (op: StoreOp) => void | Promise<void>;
const queues: Queue[] = [];

/** A queue on a MemoryStore whose `before`/`after` fault hooks can be swapped per test. */
function setup(opts: QueueOptions = {}) {
  const hooks: { before?: Hook | undefined; after?: Hook | undefined } = {};
  const raw = new MemoryStore({ faults: { before: (op) => hooks.before?.(op), after: (op) => hooks.after?.(op) } });
  const releases: ReleaseRequest[] = [];
  const release = raw.release.bind(raw);
  raw.release = (scope, req) => (releases.push(req), release(scope, req));
  const q = new Queue('s', { store: raw, logger: silent, ...opts });
  queues.push(q);
  const rec = async (id: string) => (await raw.get(q.internals.scope, id))!;
  const active = () => raw.dump().jobs.filter((j) => j.state === 'active');
  return { raw, q, hooks, releases, rec, active };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Hold the next claim's response (its write is applied) until `release()`. */
function holdClaim(hooks: { after?: Hook | undefined }) {
  const reached = deferred();
  const gate = deferred();
  hooks.after = async (op) => {
    if (op !== 'claim') return;
    hooks.after = undefined;
    reached.resolve();
    await gate.promise;
  };
  return { reached: reached.promise, release: () => gate.resolve() };
}

const never = () => new Promise<never>(() => {});
const untilAborted = (signal: AbortSignal) => new Promise<void>((r) => signal.addEventListener('abort', () => r()));

afterEach(async () => {
  await Promise.allSettled(queues.splice(0).map((q) => q.close({ timeoutMs: 0 })));
  vi.restoreAllMocks();
});

describe('shutdown: close', () => {
  it('shutdown: close stops claiming and resolves with no active jobs', async () => {
    const { q, rec } = setup();
    const handler = vi.fn();
    const w = q.process(handler);
    const t0 = performance.now();
    await w.close();
    expect(performance.now() - t0).toBeLessThan(50);
    expect(w.state).toBe('stopped');
    const { job } = await q.add(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();
    expect((await rec(job.id)).state).toBe('waiting');
  });

  it('shutdown: active jobs that finish within shutdownTimeout complete normally', async () => {
    const { q, rec } = setup();
    const gate = deferred<string>();
    const w = q.process(() => gate.promise);
    const completed = vi.fn();
    w.on('completed', completed);
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const closing = w.close();
    gate.resolve('done');
    await closing;
    expect(completed).toHaveBeenCalledTimes(1);
    expect((await rec(job.id)).state).toBe('completed');
  });

  it('shutdown: still running jobs are aborted with ShutdownError after the timeout', async () => {
    for (const shutdownTimeout of [100, 0]) {
      const { q } = setup({ shutdownTimeout, shutdownAbortGrace: 50 });
      let abortedAfter = -1;
      let reason: unknown;
      const w = q.process(async (_job, ctx) => {
        const t0 = performance.now();
        await untilAborted(ctx.signal);
        abortedAfter = performance.now() - t0;
        reason = ctx.signal.reason;
      });
      const started = next(w, 'active');
      await q.add(1);
      await started;
      await w.close();
      expect(reason, String(shutdownTimeout)).toMatchObject({ name: 'ShutdownError', code: 'SHUTDOWN' });
      if (shutdownTimeout > 0) expect(abortedAfter).toBeGreaterThanOrEqual(90);
      else expect(abortedAfter).toBeLessThan(50);
    }
  });

  it('shutdown: aborted job is released to waiting with attempt decremented and crashCount unchanged', async () => {
    const { q, rec, releases } = setup({ shutdownTimeout: 0, shutdownAbortGrace: 0 });
    const w = q.process((_job, ctx) => untilAborted(ctx.signal));
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const before = await rec(job.id);
    expect(before).toMatchObject({ state: 'active', attempt: 1 });
    await w.close();
    expect(await rec(job.id)).toMatchObject({ state: 'waiting', attempt: 0, crashCount: 0, lease: null, token: before.token });
    expect(releases).toEqual([{ id: job.id, token: before.token, refundAttempt: true, handlerStarted: true, reason: 'shutdown', history: { max: 50 } }]);
    // Claimable again at once, without waiting for the lease to run out.
    const again = next(q.process(() => 'ok'), 'completed');
    await again;
    expect((await rec(job.id)).state).toBe('completed');
  });

  it('shutdown: handler result after shutdown abort is discarded', async () => {
    const { q, rec } = setup({ shutdownTimeout: 0, shutdownAbortGrace: 1000 });
    const w = q.process(async (_job, ctx) => {
      await untilAborted(ctx.signal);
      return 'late';
    });
    const events = vi.fn();
    for (const e of ['completed', 'failed', 'retrying'] as const) w.on(e, events);
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    await w.close();
    expect(events).not.toHaveBeenCalled();
    expect(await rec(job.id)).toMatchObject({ state: 'waiting', attempt: 0 });
  });

  it('shutdown: job returned by an in-flight claim is released without running', async () => {
    const { q, hooks, releases, rec } = setup();
    const handler = vi.fn();
    const w = q.process(handler, { autorun: false });
    const { job } = await q.add(1);
    const held = holdClaim(hooks);
    void w.run();
    await held.reached;
    const closing = w.close();
    held.release();
    await closing;
    expect(handler).not.toHaveBeenCalled();
    expect(await rec(job.id)).toMatchObject({ state: 'waiting', attempt: 0 });
    expect(releases).toEqual([expect.objectContaining({ id: job.id, handlerStarted: false, refundAttempt: true, reason: 'shutdown' })]);
  });

  it('shutdown: jobs returned by a claim in flight during close are released with the attempt refunded', async () => {
    const { q, hooks, active, rec } = setup();
    const handler = vi.fn();
    const w = q.process(handler, { autorun: false, concurrency: 3 });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await q.add(i)).job.id);
    const held = holdClaim(hooks);
    void w.run();
    await held.reached;
    expect(active()).toHaveLength(3);
    const closing = w.close();
    held.release();
    await closing;
    expect(active()).toHaveLength(0);
    for (const id of ids) expect(await rec(id)).toMatchObject({ state: 'waiting', attempt: 0, crashCount: 0 });
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it('shutdown: handler that ignores the abort is released after the grace and close resolves', async () => {
    const { q, rec } = setup({ shutdownTimeout: 50, shutdownAbortGrace: 50 });
    const w = q.process(never);
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const t0 = performance.now();
    await w.close();
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(90);
    expect(took).toBeLessThan(500);
    expect(await rec(job.id)).toMatchObject({ state: 'waiting', attempt: 0 });
    expect(w.inFlight).toBe(0);
  });

  it('shutdown: a handler that ignores the abort keeps its lease renewed until it is released', async () => {
    const { q, raw, rec } = setup({ shutdownTimeout: 0, shutdownAbortGrace: 2500, leaseDuration: 1000 });
    const renew = vi.spyOn(raw, 'renew');
    const w = q.process(never);
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    await w.close();
    // a third of the lease: renewed during the grace, so the lease never lapsed
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(await rec(job.id)).toMatchObject({ state: 'waiting', attempt: 0, crashCount: 0 });
    const calls = renew.mock.calls.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(renew.mock.calls.length).toBe(calls);
  });

  it('shutdown: close called from inside a handler resolves after abort and grace', async () => {
    const { q } = setup({ shutdownTimeout: 50, shutdownAbortGrace: 50 });
    let inner: Promise<void> | undefined;
    const w = q.process(async () => {
      inner = q.close();
      await inner;
    });
    const started = next(w, 'active');
    await q.add(1);
    await started;
    await vi.waitFor(() => expect(inner).toBeDefined());
    await expect(q.close()).resolves.toBeUndefined();
    await expect(inner).resolves.toBeUndefined();
    expect(w.state).toBe('stopped');
  });

  it('shutdown: close is idempotent and concurrent calls share one promise', async () => {
    const { q } = setup();
    const w = q.process(() => 1);
    const seen: string[] = [];
    for (const e of ['closing', 'closed'] as const) {
      w.on(e, () => void seen.push(`w:${e}`));
      q.on(e, () => void seen.push(`q:${e}`));
    }
    const a = w.close();
    expect(w.close()).toBe(a);
    const qa = q.close();
    expect(q.close()).toBe(qa);
    await Promise.all([a, qa]);
    await expect(w.close()).resolves.toBeUndefined();
    await expect(q.close()).resolves.toBeUndefined();
    expect(seen.sort()).toEqual(['q:closed', 'q:closing', 'w:closed', 'w:closing']);
  });

  it('shutdown: close on a worker that never ran goes straight to stopped', async () => {
    const { q } = setup();
    const w = q.process(() => 1, { autorun: false });
    expect(w.state).toBe('created');
    await w.close();
    expect(w.state).toBe('stopped');
    await expect(w.run()).rejects.toMatchObject({ code: 'WORKER_CLOSED' });
  });

  it('shutdown: add after close throws QueueClosedError', async () => {
    const { q } = setup();
    await q.close();
    await expect(q.add(1)).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
  });

  it('shutdown: process after close throws QueueClosedError', async () => {
    const { q } = setup();
    await q.close();
    expect(() => q.process(() => 1)).toThrow(expect.objectContaining({ code: 'QUEUE_CLOSED' }));
  });

  it('shutdown: reads keep working while the queue is stopping', async () => {
    const { q } = setup();
    const gate = deferred();
    const w = q.process(() => gate.promise);
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const closing = q.close();
    await expect(q.add(2)).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    expect(w.state).toBe('stopping');
    expect((await q.getJob(job.id))?.state).toBe('active');
    expect((await q.getCounts()).active).toBe(1);
    gate.resolve();
    await closing;
    await expect(q.getCounts()).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
  });

  it('process: close stops claiming at stopping, not stopped', async () => {
    const { q } = setup();
    const gate = deferred();
    const w = q.process(() => gate.promise);
    const started = next(w, 'active');
    await q.add(1);
    await started;
    expect(w.state).toBe('running');
    const closing = w.close();
    expect(w.state).toBe('stopping');
    expect(w.isRunning()).toBe(false);
    gate.resolve();
    await closing;
    expect(w.state).toBe('stopped');
  });

  it('shutdown: no lease is left held after close', async () => {
    const { q, active } = setup({ shutdownTimeout: 20, shutdownAbortGrace: 20 });
    const w = q.process((job: { data: unknown }, ctx) => (job.data === 'stubborn' ? never() : untilAborted(ctx.signal)), { concurrency: 3 });
    const started = new Promise<void>((r) => {
      let n = 0;
      w.on('active', () => void (++n === 3 && r()));
    });
    for (const data of ['stubborn', 'cooperative', 'cooperative', 'idle']) await q.add(data);
    await started;
    await w.close();
    expect(active().filter((j: JobRecord) => j.lease?.owner === w.id)).toHaveLength(0);
  });
});

describe('shutdown: release failures', () => {
  it('shutdown: store outage during release does not hang past the timeout', async () => {
    const { q, hooks, rec } = setup({ shutdownTimeout: 50, shutdownAbortGrace: 50 });
    const errors: unknown[] = [];
    const w = q.process((_job, ctx) => untilAborted(ctx.signal));
    w.on('error', (e) => void errors.push(e.error));
    const closed = vi.fn();
    w.on('closed', closed);
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    hooks.before = (op) => {
      if (op === 'release') throw new StoreUnavailableError('down', { operation: 'release', retryable: true, outcomeUnknown: true });
    };
    const t0 = performance.now();
    const e = await w.close().then(() => expect.unreachable(), (x: unknown) => x);
    // timeout + grace, plus the one second the last releases get to answer
    expect(performance.now() - t0).toBeLessThan(50 + 50 + 1000 + 500);
    expect(e).toBeInstanceOf(AggregateError);
    expect((e as AggregateError).errors).toEqual([expect.objectContaining({ code: 'STORE_UNAVAILABLE', operation: 'release', jobId: job.id, outcomeUnknown: true })]);
    expect(w.state).toBe('stopped');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'STORE_UNAVAILABLE', operation: 'release', jobId: job.id, outcomeUnknown: true }));
    hooks.before = undefined;
    expect((await rec(job.id)).state).toBe('active');
  });

  it('shutdown: a release whose store write never answers ends at the close deadline', async () => {
    const { q, hooks } = setup({ shutdownTimeout: 0, shutdownAbortGrace: 50 });
    const w = q.process((_job, ctx) => untilAborted(ctx.signal));
    const started = next(w, 'active');
    await q.add(1);
    await started;
    hooks.before = (op) => (op === 'release' ? never() : undefined);
    const t0 = performance.now();
    await expect(w.close()).rejects.toBeInstanceOf(AggregateError);
    expect(performance.now() - t0).toBeLessThan(50 + 1000 + 500);
    expect(w.state).toBe('stopped');
  });

  it('shutdown: close rejects once with AggregateError when the store raises during release', async () => {
    const { q, hooks } = setup({ shutdownTimeout: 0, shutdownAbortGrace: 0 });
    const w = q.process((_job, ctx) => untilAborted(ctx.signal), { concurrency: 2 });
    const started = new Promise<void>((r) => {
      let n = 0;
      w.on('active', () => void (++n === 2 && r()));
    });
    await q.add(1);
    await q.add(2);
    await started;
    hooks.before = (op) => {
      if (op === 'release') throw new StoreError('refused', { operation: 'release', retryable: false, outcomeUnknown: false });
    };
    const closed = vi.fn();
    q.on('closed', closed);
    const e = await q.close().then(() => expect.unreachable(), (x: unknown) => x);
    expect(e).toBeInstanceOf(AggregateError);
    expect((e as AggregateError).message).toBe('shutdown: some leases could not be released');
    expect((e as AggregateError).errors).toHaveLength(2);
    expect((e as AggregateError).errors[0]).toMatchObject({ code: 'STORE_ERROR', operation: 'release' });
    expect(w.state).toBe('stopped');
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(w.close()).rejects.toBeInstanceOf(AggregateError);
  });

  it('shutdown: release with unknown outcome is repeated with the same token and counted once', async () => {
    const { q, hooks, releases, rec } = setup({ shutdownTimeout: 0, shutdownAbortGrace: 0 });
    const w = q.process((_job, ctx) => untilAborted(ctx.signal));
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    hooks.after = (op) => {
      if (op !== 'release') return;
      hooks.after = undefined;
      throw new Error('response lost');
    };
    await w.close();
    expect(releases).toHaveLength(2);
    expect(releases[1]).toEqual(releases[0]);
    expect(await rec(job.id)).toMatchObject({ state: 'waiting', attempt: 0 });
  });
  it('shutdown: a release that runs out of lease before the close deadline is in the AggregateError', async () => {
    const { q, hooks } = setup({ shutdownTimeout: 0, shutdownAbortGrace: 0, leaseDuration: '1s' });
    const errors: unknown[] = [];
    const w = q.process((_job, ctx) => untilAborted(ctx.signal));
    w.on('error', (e) => void errors.push(e.error));
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    // the close deadline (one second for the release) now lies past the lease deadline
    await new Promise((r) => setTimeout(r, 200));
    hooks.before = (op) => {
      if (op === 'release') throw new StoreUnavailableError('down', { operation: 'release', retryable: true, outcomeUnknown: false });
    };
    const e = await w.close().then(() => expect.unreachable(), (x: unknown) => x);
    expect(e).toBeInstanceOf(AggregateError);
    const unconfirmed = expect.objectContaining({ code: 'STORE_UNAVAILABLE', operation: 'release', jobId: job.id, outcomeUnknown: true });
    expect((e as AggregateError).errors).toEqual([unconfirmed]);
    expect(errors).toContainEqual(unconfirmed);
  });
});

describe('shutdown: close is bounded by its deadline', () => {
  const within = async (close: () => Promise<void>, ms: number) => {
    const t0 = performance.now();
    await close();
    expect(performance.now() - t0).toBeLessThan(ms);
  };

  it('shutdown: a claim that never answers does not hold close past the deadline', async () => {
    const { q, hooks } = setup({ shutdownTimeout: 50, shutdownAbortGrace: 50 });
    const reached = deferred();
    hooks.before = (op) => (op === 'claim' ? (reached.resolve(), never()) : undefined);
    const w = q.process(() => 1);
    await reached.promise;
    // the claim may still answer: it gets the second the last releases get
    await within(() => w.close(), 100 + 1000 + 500);
    expect(w.state).toBe('stopped');
  });

  it('shutdown: a hung claim neither delays the abort nor takes the grace from a running handler', async () => {
    const warn = vi.fn();
    const { q, hooks, rec } = setup({ shutdownTimeout: 100, shutdownAbortGrace: 500, logger: { ...silent, warn } });
    let abortedAt = 0;
    const w = q.process(async (_job, ctx) => {
      await untilAborted(ctx.signal);
      abortedAt = performance.now();
      await new Promise((r) => setTimeout(r, 50)); // unwinding takes a while
    }, { concurrency: 2, acknowledgeVolatileStore: true });
    const reached = deferred();
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    hooks.before = (op) => (op === 'claim' ? (reached.resolve(), never()) : undefined);
    w.wake();
    await reached.promise;
    const t0 = performance.now();
    await w.close();
    expect(abortedAt - t0).toBeGreaterThanOrEqual(90);
    expect(abortedAt - t0).toBeLessThan(300);
    expect(warn).not.toHaveBeenCalled();
    expect(await rec(job.id)).toMatchObject({ state: 'waiting', attempt: 0 });
  });

  it('shutdown: a complete write that never answers frees its slot when close gives up', async () => {
    const { q, hooks } = setup({ shutdownTimeout: 50, shutdownAbortGrace: 50 });
    const gate = deferred();
    const w = q.process(() => gate.promise);
    const started = next(w, 'active');
    await q.add(1);
    await started;
    hooks.before = (op) => (op === 'complete' ? never() : undefined);
    gate.resolve();
    await within(() => w.close(), 100 + 1000 + 500);
    expect(w.state).toBe('stopped');
    expect(w.inFlight).toBe(0);
  });

  it('shutdown: a sweep that never answers does not hold close past the deadline', async () => {
    const { q, hooks } = setup({ shutdownTimeout: 50, shutdownAbortGrace: 50 });
    const reached = deferred();
    hooks.before = (op) => (op === 'sweep' ? (reached.resolve(), never()) : undefined);
    const w = q.process(() => 1, { sweepInterval: 500 });
    await reached.promise;
    await within(() => w.close(), 100 + 500);
    expect(w.state).toBe('stopped');
  });

  it('shutdown: a complete retried during an outage ends at the close deadline', async () => {
    const { q, hooks } = setup({ shutdownTimeout: 50, shutdownAbortGrace: 50 });
    const gate = deferred();
    const w = q.process(() => gate.promise);
    const completed = vi.fn();
    w.on('completed', completed);
    const started = next(w, 'active');
    await q.add(1);
    await started;
    hooks.before = (op) => {
      if (op === 'complete') throw new StoreUnavailableError('down', { operation: 'complete', retryable: true, outcomeUnknown: true });
    };
    gate.resolve();
    await within(() => w.close(), 100 + 1000 + 500);
    expect(w.state).toBe('stopped');
    expect(completed).not.toHaveBeenCalled();
  });
});

describe('shutdown: queue', () => {
  it('shutdown: queue close waits for a worker that is already closing', async () => {
    const { q, rec } = setup({ shutdownTimeout: 5000 });
    const gate = deferred();
    const w = q.process(() => gate.promise);
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const order: string[] = [];
    const workerClosed = w.close().then(() => void order.push('worker'));
    const queueClosed = q.close().then(() => void order.push('queue'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([workerClosed, queueClosed]);
    expect(order).toEqual(['worker', 'queue']);
    expect((await rec(job.id)).state).toBe('completed');
  });

  it('shutdown: cancel aborts a handler on a worker that is closing', async () => {
    const { q } = setup({ shutdownTimeout: 1000 });
    let reason: unknown;
    const w = q.process(async (_job, ctx) => {
      await untilAborted(ctx.signal);
      reason = ctx.signal.reason;
    });
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const closed = w.close();
    await q.cancel(job.id);
    await closed;
    expect(reason).toBeInstanceOf(JobCancelledError);
    expect(w.inFlight).toBe(0);
  });

  it('shutdown: a claim that fails after close gave up on it is dropped quietly', async () => {
    const { q, hooks } = setup({ shutdownTimeout: 20, shutdownAbortGrace: 20 });
    const reached = deferred();
    let fail!: (e: Error) => void;
    hooks.before = (op) => (op === 'claim' ? (reached.resolve(), new Promise<void>((_, reject) => (fail = reject))) : undefined);
    const w = q.process(() => 1, { acknowledgeVolatileStore: true });
    const errors = vi.fn();
    w.on('error', errors);
    await reached.promise;
    await w.close();
    fail(new StoreError('late claim failure', { operation: 'claim', retryable: true, outcomeUnknown: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).not.toHaveBeenCalled();
  });

  it('shutdown: a cancelled handler still running at close is logged at debug', async () => {
    const debug = vi.fn();
    const { q } = setup({ shutdownTimeout: 20, shutdownAbortGrace: 20, logger: { ...silent, debug } });
    const w = q.process(never, { acknowledgeVolatileStore: true });
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    await q.cancel(job.id);
    await w.close();
    expect(w.inFlight).toBe(0);
    expect(debug.mock.calls.filter(([m]) => String(m).includes('still ran at close'))).toEqual([[expect.any(String), expect.objectContaining({ jobIds: job.id })]]);
  });

  it('shutdown: a subscribe that never answers does not hold queue close past the deadline', async () => {
    const { q, raw } = setup({ shutdownTimeout: 100, shutdownAbortGrace: 100 });
    const reached = deferred();
    raw.subscribe = () => (reached.resolve(), never());
    q.process(() => 1);
    await reached.promise;
    const t0 = performance.now();
    await q.close();
    expect(performance.now() - t0).toBeLessThan(100 + 100 + 1000 + 500);
    expect(q.connectionState).toBe('closed');
  });

  it('shutdown: a store close that never answers does not hold queue close past the deadline', async () => {
    vi.spyOn(MemoryStore.prototype, 'close').mockImplementation(never);
    const q = new Queue('own', { logger: silent, shutdownTimeout: 100, shutdownAbortGrace: 100 });
    const closed = vi.fn();
    q.on('closed', closed);
    const t0 = performance.now();
    await q.close();
    expect(performance.now() - t0).toBeLessThan(100 + 100 + 1000 + 500);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('shutdown: a store close failure joins the release errors in one AggregateError', async () => {
    vi.spyOn(MemoryStore.prototype, 'close').mockRejectedValue(new Error('close failed'));
    vi.spyOn(MemoryStore.prototype, 'release').mockRejectedValue(new StoreError('refused', { operation: 'release', retryable: false, outcomeUnknown: false }));
    const q = new Queue('own', { logger: silent, shutdownTimeout: 0, shutdownAbortGrace: 0 });
    const w = q.process((_job, ctx) => untilAborted(ctx.signal), { acknowledgeVolatileStore: true });
    const started = next(w, 'active');
    await q.add(1);
    await started;
    const e = await q.close().then(() => expect.unreachable(), (x: unknown) => x);
    expect(e).toBeInstanceOf(AggregateError);
    expect((e as AggregateError).errors).toEqual([
      expect.objectContaining({ code: 'STORE_ERROR', operation: 'release' }),
      expect.objectContaining({ operation: 'close' }),
    ]);
  });

  it('shutdown: external store is not closed, owned store is', async () => {
    const close = vi.spyOn(MemoryStore.prototype, 'close');
    const store = new MemoryStore();
    await new Queue('ext', { store, logger: silent }).close();
    expect(close).not.toHaveBeenCalled();
    await new Queue('own', { logger: silent }).close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('shutdown: events closing and closed fire once in order', async () => {
    const { q, raw } = setup({ shutdownTimeout: 0, shutdownAbortGrace: 0 });
    const seen: string[] = [];
    const w = q.process((_job, ctx) => untilAborted(ctx.signal));
    const release = raw.release.bind(raw);
    raw.release = (scope, req) => (seen.push('release'), release(scope, req));
    q.on('closing', (p) => void seen.push(`q:closing:${JSON.stringify(p)}`));
    q.on('closed', (p) => void seen.push(`q:closed:${JSON.stringify(p)}`));
    w.on('closing', (p) => void seen.push(`w:closing:${p.workerId === w.id}`));
    w.on('closed', (p) => void seen.push(`w:closed:${p.workerId === w.id}`));
    const started = next(w, 'active');
    await q.add(1);
    await started;
    await q.close();
    expect(seen).toEqual(['q:closing:{"queue":"s"}', 'w:closing:true', 'release', 'w:closed:true', 'q:closed:{"queue":"s"}']);
  });

  it('shutdown: a producer-only queue just closes its store', async () => {
    const { q } = setup();
    const closed = next(q, 'closed');
    await q.close();
    await closed;
    expect(q.connectionState).toBe('closed');
  });
});

/** Deliver `signal` to the listeners added since `before` only: the test runner has its own. */
function deliver(signal: NodeJS.Signals, before: readonly unknown[]) {
  for (const fn of process.listeners(signal)) if (!before.includes(fn)) (fn as (s: NodeJS.Signals) => void)(signal);
}

describe('shutdown: signals', () => {
  it('shutdown: signals option calls close on SIGTERM', async () => {
    const before = process.listeners('SIGTERM');
    const { q } = setup({ signals: ['SIGTERM'] });
    expect(process.listenerCount('SIGTERM')).toBe(before.length);
    q.process(() => 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.length + 1);
    const closed = next(q, 'closed');
    deliver('SIGTERM', before);
    await closed;
    expect(q.closed).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(before.length);
  });

  it('shutdown: second signal exits without waiting for release', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
    const { q, rec } = setup({ signals: ['SIGTERM', 'SIGINT'], shutdownTimeout: 1000, shutdownAbortGrace: 0 });
    const w = q.process(never);
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const closed = vi.fn();
    q.on('closed', closed);
    deliver('SIGTERM', before.SIGTERM);
    expect(exit).not.toHaveBeenCalled();
    deliver('SIGINT', before.SIGINT);
    expect(exit).toHaveBeenCalledWith(1);
    expect(closed).not.toHaveBeenCalled();
    expect((await rec(job.id)).state).toBe('active');
  });

  it('shutdown: signals refuses SIGKILL and SIGSTOP, which cannot be listened for', () => {
    for (const signal of ['SIGKILL', 'SIGSTOP'] as const) {
      expect(() => new Queue('q', { logger: silent, signals: ['SIGTERM', signal] }), signal).toThrow(InvalidOptionError);
    }
  });

  it('shutdown: a signal that cannot be installed leaves no listener and no worker behind', async () => {
    const before = process.listenerCount('SIGTERM');
    const { q } = setup({ signals: ['SIGTERM', 'SIGINT'] });
    const on = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => {
      if (event === 'SIGINT') throw new Error('uv_signal_start EINVAL');
      return on(event, fn);
    }) as never);
    expect(() => q.process(() => 1, { workerId: 'first' })).toThrow('EINVAL');
    expect(process.listenerCount('SIGTERM')).toBe(before);
    vi.mocked(process.on).mockRestore();
    // nothing registered: the same job names can be handled again, and the queue closes cleanly
    const w = q.process(() => 1);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await q.close();
    expect(w.state).toBe('stopped');
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('shutdown: default installs no signal handlers', async () => {
    const counts = () => [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const before = counts();
    const { q } = setup();
    q.process(() => 1);
    expect(counts()).toEqual(before);
    await q.close();
    expect(counts()).toEqual(before);
  });
});

describe('shutdown: late store failures', () => {
  it('shutdown: a scheduler failure while close waits for the pause check is still reported', async () => {
    useFakeTime();
    const clock = { t: 5_000_000 };
    const raw = new MemoryStore({ clock: () => clock.t });
    const pauseRead = deferred<boolean>();
    let failFire: (e: Error) => void = () => {};
    const spy = spyStore(raw, {
      isPaused: () => pauseRead.promise,
      fireSchedule: () => new Promise((_, reject) => (failFire = reject)),
    });
    const q = new Queue('late', { store: spy.store, logger: silent, scheduler: { tickMs: 100 }, random: () => 0.5 });
    const errors: string[] = [];
    q.on('error', (e) => void errors.push(e.context.operation ?? ''));
    await q.upsertSchedule('k', { every: '1s', template: { data: 1 } });
    clock.t += 1000;
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(spy.calls.some((c) => c.op === 'fireSchedule')).toBe(true);
    // a pause-flag read is in flight while the queue closes
    q.internals.checkPaused();
    const start = performance.now();
    const closed = q.close({ timeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    // close gives up on the hung fire at its store deadline, then waits for the pause read; the fire fails in that wait
    const storeDeadline = start + q.internals.shutdownAbortGrace + 1000;
    setTimeout(() => failFire(new StoreError('fire failed', { operation: 'fireSchedule', retryable: false, outcomeUnknown: false })), storeDeadline - performance.now());
    await vi.advanceTimersByTimeAsync(storeDeadline - performance.now() + 10);
    expect(errors).toContain('fireSchedule');
    pauseRead.resolve(false);
    await closed;
    vi.useRealTimers();
  });
});
