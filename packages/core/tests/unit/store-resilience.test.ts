import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { StoreError } from '../../src/errors/catalog.js';
import type { StoreOp } from '../../src/store/types.js';
import { failing } from '../helpers/faults.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A queue on a MemoryStore whose calls fail per `rule`; `down` flips a whole-store outage for `ops`. */
const setup = (rule: (op: StoreOp, call: number) => unknown, queueOpts: Record<string, unknown> = {}) => {
  const store = new MemoryStore({ faults: failing(rule) });
  const q = new Queue('res', { store, logger: silent, ...queueOpts });
  return { store, q, scope: q.internals.scope };
};
const down = (msg = 'down') => new TypeError(msg);
const refused = () => new StoreError('refused', { operation: 'claim', retryable: false, outcomeUnknown: false });

describe('store resilience in the worker', () => {
  it('storeerr: claim failure emits error event and the loop recovers', async () => {
    let outage = false;
    // Notifications, the schedule loop and the worker registry stay up: this test is about the claim loop.
    const up = ['add', 'subscribe', 'listDueSchedules', 'registerWorker', 'heartbeatWorker', 'purgeWorkers'];
    const { q } = setup((op) => (outage && !up.includes(op) ? down() : undefined));
    const errors: Array<{ source: string; context: { operation?: string } }> = [];
    q.on('error', (e) => void errors.push(e as never));
    const connection = vi.fn();
    q.on('storeDisconnected', () => connection('down'));
    q.on('storeReconnected', () => connection('up'));
    const completed = vi.fn();
    q.on('completed', completed);
    await q.add(1);
    outage = true;
    q.process(() => 'ok', { ...poll(10) });
    await vi.advanceTimersByTimeAsync(1000);
    outage = false;
    await vi.advanceTimersByTimeAsync(2000);
    // One outage: one error, one disconnect and one reconnect, however many claims it would have taken.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ source: 'store', context: { operation: 'claim' } });
    expect(connection.mock.calls.map((c) => c[0])).toEqual(['down', 'up']);
    expect(completed).toHaveBeenCalledOnce();
    await q.close();
  });

  it('storeerr: claim retry backoff grows to the cap and resets on success', async () => {
    const times: number[] = [];
    const t0 = Date.now();
    const { q } = setup((op, n) => {
      if (op !== 'claim') return undefined;
      times.push(Date.now() - t0);
      // Not a connection error: the state stays connected and the claim backoff alone applies.
      return n <= 10 || n === 12 ? refused() : undefined;
    });
    q.on('error', () => {});
    q.process(() => 'ok', { ...poll(10) });
    await vi.advanceTimersByTimeAsync(40_000);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps.slice(0, 9)).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000]);
    // call 11 succeeds (empty), then a poll of 10 ms, call 12 fails, and the wait is back to 100 ms
    expect(gaps[9]).toBe(5000);
    expect(gaps[10]).toBe(10);
    expect(gaps[11]).toBe(100);
    await q.close();
  });

  it('concurrency: slot is held while a finalising write is retried and freed once it lands', async () => {
    let outage = true;
    const { q } = setup((op) => (outage && op === 'complete' ? down() : undefined));
    q.on('error', () => {});
    const started: unknown[] = [];
    const w = q.process((job) => void started.push(job.data), { concurrency: 1, ...poll(10) });
    await q.addBulk([{ data: 'a' }, { data: 'b' }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toEqual(['a']);
    expect(w.inFlight).toBe(1);
    outage = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).toEqual(['a', 'b']);
    expect(w.inFlight).toBe(0);
    await q.close({ timeoutMs: 1000 });
  });

  it('storeerr: a complete write that fails during an outage lands when the store recovers and completed fires exactly once', async () => {
    let outage = true;
    const { q, store, scope } = setup((op) => (outage && op === 'complete' ? down() : undefined));
    q.on('error', () => {});
    const completed = vi.fn();
    const w = q.process(() => 'done', { concurrency: 1, ...poll(10) });
    w.on('completed', completed);
    const { job } = await q.add(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(completed).not.toHaveBeenCalled();
    expect(w.inFlight).toBe(1);
    expect((await stored(store, scope, job.id))!.state).toBe('active');
    outage = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(completed).toHaveBeenCalledOnce();
    expect(w.inFlight).toBe(0);
    expect((await stored(store, scope, job.id))!.state).toBe('completed');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(completed).toHaveBeenCalledOnce();
    await q.close();
  });

  it('attempts: failing fail write is retried, then parked, and the job reaches its terminal or delayed state once the store recovers', async () => {
    let failCalls = 0;
    const { q, store, scope } = setup((op) => (op === 'fail' && ++failCalls <= 6 ? down() : undefined), { defaultJobOptions: { backoff: 1000 } });
    q.on('error', () => {});
    const retrying = vi.fn();
    const w = q.process(() => Promise.reject(new RangeError('handler')), { ...poll(10) });
    w.on('retrying', retrying);
    const { job } = await q.add(1, { maxAttempts: 3 });
    // Six failing tries use up the ladder (0 to 1550 ms); the seventh, a second later, lands within the lease.
    await vi.advanceTimersByTimeAsync(2500);
    expect(retrying).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(retrying).toHaveBeenCalledOnce();
    expect((await stored(store, scope, job.id))!).toMatchObject({ attempt: 1, state: 'delayed' });
    await q.close({ timeoutMs: 1000 });
  });

  it('storeerr: no unhandledRejection or uncaughtException across a full fault-injection run', async () => {
    const unhandled = vi.fn();
    const uncaught = vi.fn();
    const before = [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')];
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    process.on('unhandledRejection', unhandled);
    process.on('uncaughtException', uncaught);
    try {
      let k = 0;
      const { q, store, scope } = setup((op) => (op !== 'add' && op !== 'now' && op !== 'counts' && ++k % 5 === 0 ? down(`fault ${op}`) : undefined), {
        defaultJobOptions: { backoff: 0 },
      });
      q.on('error', () => {});
      // added first: the worker's and the scheduler's first calls may fault, and a reconnecting store rejects adds
      await q.addBulk(Array.from({ length: 200 }, (_, i) => ({ data: i })));
      const w = q.process((job) => ((job.data as number) % 7 === 0 ? Promise.reject(new TypeError('h')) : 'ok'), { concurrency: 4, ...poll(10) });
      for (let i = 0; i < 60; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        const c = await store.counts(scope);
        if (c.completed + c.failed === 200) break;
      }
      const c = await store.counts(scope);
      expect(c.completed + c.failed).toBe(200);
      await q.close({ timeoutMs: 5000 });
      expect(w.inFlight).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      process.off('uncaughtException', uncaught);
    }
    expect([process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')]).toEqual(before);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  }, 30_000);

  it('storeerr: an outage of many claim failures logs a bounded number of lines', async () => {
    const error = vi.fn();
    const store = new MemoryStore({ faults: failing((op) => (op === 'claim' ? down() : undefined)) });
    const q = new Queue('res', { store, logger: { ...silent, error } });
    q.process(() => 'ok', { ...poll(10) });
    await vi.advanceTimersByTimeAsync(60_000);
    // ~15 claim failures at the 5 s cap; one log per 10 s per message
    expect(error.mock.calls.length).toBeLessThanOrEqual(7);
    expect(error.mock.calls.length).toBeGreaterThan(0);
    await q.close();
  });
});
