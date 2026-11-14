import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '../../src/events/types.js';
import { Queue } from '../../src/queue/queue.js';
import type { Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  vi.useRealTimers();
});

type Over = Parameters<typeof spyStore>[1];
/** Two Queue objects on one store: A (spied) runs the worker, B adds from "another pod". */
function pods(over: (inner: MemoryStore) => Over = () => ({})) {
  const inner = new MemoryStore();
  const spy = spyStore(inner, over(inner));
  const qa = new Queue('n', { store: spy.store, logger: silent });
  const qb = new Queue('n', { store: inner, logger: silent });
  queues.push(qa, qb);
  const count = (op: string) => spy.calls.filter((c) => c.op === op).length;
  return { inner, spy, qa, qb, count };
}

describe('push wake-ups', () => {
  it('polling: push notification wakes a worker in another queue instance', async () => {
    vi.useFakeTimers();
    const { spy, qa, qb, count } = pods();
    const ran = vi.fn();
    qa.process(ran, poll(60_000));
    await vi.advanceTimersByTimeAsync(10);
    await qb.add(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(ran).toHaveBeenCalledOnce();
    expect(count('subscribe')).toBe(1);
    expect(spy.calls.find((c) => c.op === 'subscribe')!.args[0]).toEqual(qa.internals.scope);
  });

  it('polling: lost notification is still found by the poll within pollMax', async () => {
    vi.useFakeTimers();
    const { qa, qb } = pods(() => ({ subscribe: () => Promise.resolve(async () => {}) }));
    const ran = vi.fn();
    qa.process(ran, { random: () => 0.5 }); // no jitter: claims at 0, 100, 300 ... 16 300, 21 300 ms
    await vi.advanceTimersByTimeAsync(20_000); // idle: the wait has grown to pollMax
    await qb.add(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('polling: subscription failure falls back to polling and re-subscribes', async () => {
    vi.useFakeTimers();
    let fail = true;
    const { qa, qb, count } = pods((inner) => ({
      subscribe: (s: Scope, onWake: () => void) => (fail ? ((fail = false), Promise.reject(new TypeError('no channel'))) : inner.subscribe(s, onWake)),
    }));
    const errors: ErrorEvent[] = [];
    qa.on('error', (e) => void errors.push(e));
    const ran = vi.fn();
    qa.process(ran, poll(60_000));
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ source: 'store', context: { operation: 'subscribe' } });
    // The worker's own pollMax (60 s), not the queue's (default 5 s).
    await vi.advanceTimersByTimeAsync(5000);
    expect(count('subscribe')).toBe(1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(count('subscribe')).toBe(2);
    await qb.add(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(ran).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
  });

  it('polling: closing the last worker unsubscribes and later adds wake nothing', async () => {
    vi.useFakeTimers();
    const unsubscribed = vi.fn();
    const wakes = vi.fn();
    const { qa, qb, count } = pods((inner) => ({
      subscribe: async (s: Scope, onWake: () => void) => {
        const un = await inner.subscribe(s, () => {
          wakes();
          onWake();
        });
        return async () => {
          unsubscribed();
          await un();
        };
      },
    }));
    const w1 = qa.process({ a: () => {} }, poll(60_000));
    const w2 = qa.process({ b: () => {} }, poll(60_000));
    await vi.advanceTimersByTimeAsync(10);
    await w1.close();
    expect(unsubscribed).not.toHaveBeenCalled();
    await w2.close();
    expect(unsubscribed).toHaveBeenCalledOnce();
    const claims = count('claim');
    await qb.add(1, { name: 'a' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(count('claim')).toBe(claims);
    expect(count('subscribe')).toBe(1);
    expect(wakes).not.toHaveBeenCalled();
  });

  it('polling: notify false never subscribes', async () => {
    vi.useFakeTimers();
    const { qa, qb, count } = pods();
    const ran = vi.fn();
    qa.process(ran, { ...poll(60_000), notify: false });
    await vi.advanceTimersByTimeAsync(10);
    await qb.add(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(count('subscribe')).toBe(0);
    expect(ran).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('polling: two workers on one queue share one subscription and both wake', async () => {
    vi.useFakeTimers();
    const { qa, qb, count } = pods();
    const a = vi.fn();
    const b = vi.fn();
    qa.process({ a }, poll(60_000));
    qa.process({ b }, poll(60_000));
    await vi.advanceTimersByTimeAsync(10);
    await qb.addBulk([{ data: 1, opts: { name: 'a' } }, { data: 2, opts: { name: 'b' } }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(count('subscribe')).toBe(1);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('polling: subscription callback that throws is reported and polling continues', async () => {
    vi.useFakeTimers();
    const { spy, qa, qb } = pods();
    const errors: ErrorEvent[] = [];
    qa.on('error', (e) => void errors.push(e));
    const ran = vi.fn();
    const w = qa.process(ran, poll(60_000));
    await vi.advanceTimersByTimeAsync(10);
    const onWake = spy.calls.find((c) => c.op === 'subscribe')!.args[1] as () => void;
    const wake = w.wake.bind(w);
    w.wake = () => {
      throw new TypeError('broken worker');
    };
    expect(() => onWake()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ source: 'store', context: { operation: 'subscribe' } });
    w.wake = wake;
    await qb.add(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('polling: close waits for a subscribe still in flight and releases it first', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let resolveSub!: () => void;
    const inner = new MemoryStore();
    const spy = spyStore(inner, {
      subscribe: async (s: Scope, onWake: () => void) => {
        await new Promise<void>((r) => (resolveSub = r));
        const un = await inner.subscribe(s, onWake);
        return async () => {
          order.push('unsubscribe');
          await un();
        };
      },
    });
    const q = new Queue('late', { store: spy.store, logger: silent });
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    q.process(() => {}, poll(60_000));
    await vi.advanceTimersByTimeAsync(10);
    let closed = false;
    const closing = q.close().then(() => void (closed = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(closed).toBe(false);
    resolveSub();
    await closing;
    expect(order).toEqual(['unsubscribe']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors).toEqual([]);
  });
});
