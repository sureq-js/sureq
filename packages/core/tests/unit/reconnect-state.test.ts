import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, StoreError, StoreRequestError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { clientFor } from '../../src/store/client.js';
import type { Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { gaps, outageStore } from '../helpers/outage.js';
import { spyStore } from '../helpers/spy-store.js';

beforeEach(() => useFakeTime());
afterEach(() => {
  vi.useRealTimers();
});

/** Fix the backoff schedule of `store` before any queue configures it. */
const schedule = (store: Store, random: () => number, maxDelayMs = 30_000) =>
  clientFor(store).configure({ initialDelayMs: 100, maxDelayMs, factor: 2, jitter: 0.2, random });

/** An open queue on an outage store, and a way to start an outage now. */
async function setup(random: () => number = () => 0.5, maxDelayMs?: number) {
  const { store, ctl } = outageStore();
  schedule(store, random, maxDelayMs);
  const q = new Queue('r', { store, logger: silent });
  await q.ready();
  const breakNow = async () => {
    ctl.down = true;
    const at = performance.now();
    await q.getCounts().catch(() => {});
    return at;
  };
  return { store, ctl, q, breakNow };
}

describe('reconnect: connection state', () => {
  it('reconnect: connection error moves to reconnecting and emits storeDisconnected once', async () => {
    const { q, ctl } = await setup();
    const disconnected = vi.fn();
    q.on('storeDisconnected', disconnected);
    expect(q.connectionState).toBe('connected');
    ctl.down = true;
    for (let i = 0; i < 3; i++) await expect(q.getCounts()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(disconnected).toHaveBeenCalledOnce();
    expect(disconnected.mock.calls[0]![0].error).toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'counts' });
    expect(q.connectionState).toBe('reconnecting');
    await q.close();
    expect(q.connectionState).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconnect: backoff grows by factor, is capped at maxDelay and is jittered', async () => {
    const run = async (random: () => number) => {
      const { ctl, q, breakNow } = await setup(random, 1000);
      const from = await breakNow();
      await vi.advanceTimersByTimeAsync(6000);
      await q.close();
      return gaps(ctl, 'now', from).slice(0, 7);
    };
    expect(await run(() => 0.5)).toEqual([100, 200, 400, 800, 1000, 1000, 1000]);
    const high = await run(() => 1);
    [120, 240, 480, 960, 1200, 1200].forEach((ms, i) => expect(high[i]).toBeCloseTo(ms, 6));
    const low = await run(() => 0);
    [80, 160, 320, 640, 800, 800].forEach((ms, i) => expect(low[i]).toBeCloseTo(ms, 6));
  });

  it('reconnect: backoff jitter comes from the queue random source', async () => {
    const run = async (random: () => number) => {
      const { store, ctl } = outageStore();
      const q = new Queue('r', { store, logger: silent, reconnect: { maxDelay: 1000 }, random });
      await q.ready();
      ctl.down = true;
      const from = performance.now();
      await q.getCounts().catch(() => {});
      await vi.advanceTimersByTimeAsync(3000);
      await q.close();
      return gaps(ctl, 'now', from).slice(0, 4);
    };
    const high = await run(() => 1);
    [120, 240, 480, 960].forEach((ms, i) => expect(high[i]).toBeCloseTo(ms, 6));
    expect(await run(() => 1)).toEqual(high);
  });

  it('reconnect: successful probe emits storeReconnected with downForMs and resets backoff', async () => {
    const { ctl, q, breakNow } = await setup();
    const reconnected = vi.fn();
    q.on('storeReconnected', reconnected);
    const from = await breakNow();
    await vi.advanceTimersByTimeAsync(500); // probes at 100 and 300 fail
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(200); // the probe at 700 succeeds
    expect(reconnected).toHaveBeenCalledOnce();
    expect(reconnected.mock.calls[0]![0]).toEqual({ attempts: 3, downForMs: 700 });
    expect(q.connectionState).toBe('connected');
    const again = await breakNow();
    expect(again - from).toBe(700);
    await vi.advanceTimersByTimeAsync(150);
    expect(gaps(ctl, 'now', again)).toEqual([100]);
    await q.close();
  });

  it('reconnect: store flaps without resetting backoff on ordinary success', async () => {
    const { ctl, q, breakNow } = await setup();
    const reconnected = vi.fn();
    q.on('storeReconnected', reconnected);
    const from = await breakNow();
    // The probe (now) keeps failing while other calls work again.
    ctl.failing = (op) => op === 'now';
    await expect(q.getCounts()).resolves.toBeDefined();
    expect(q.connectionState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(800);
    expect(gaps(ctl, 'now', from)).toEqual([100, 200, 400]);
    expect(reconnected).not.toHaveBeenCalled();
    ctl.failing = () => false;
    await vi.advanceTimersByTimeAsync(800);
    expect(reconnected).toHaveBeenCalledOnce();
    await q.close();
  });

  it('reconnect: non-connection error does not change state', async () => {
    const raw = new MemoryStore();
    let n = 0;
    const { store } = spyStore(raw, {
      counts: () => {
        throw ++n === 1
          ? new StoreRequestError('bad request', { operation: 'counts' })
          : new StoreError('refused', { operation: 'counts', retryable: false, outcomeUnknown: false });
      },
    });
    const q = new Queue('r', { store, logger: silent });
    const events = vi.fn();
    q.on('storeDisconnected', events);
    await expect(q.getCounts()).rejects.toMatchObject({ code: 'STORE_BAD_REQUEST' });
    await expect(q.getCounts()).rejects.toMatchObject({ code: 'STORE_ERROR' });
    expect(q.connectionState).toBe('connected');
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await q.close();
  });

  it('reconnect: no unhandled emit when no error listener is attached', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { ctl, q, breakNow } = await setup();
      await breakNow();
      await vi.advanceTimersByTimeAsync(1000);
      ctl.down = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(q.connectionState).toBe('connected');

      const errors: Array<{ source: string; context: { event?: string } }> = [];
      q.on('error', (e) => void errors.push(e));
      q.on('storeDisconnected', () => {
        throw new RangeError('listener');
      });
      const reconnected = vi.fn();
      q.on('storeReconnected', reconnected);
      await breakNow();
      ctl.down = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ source: 'listener', context: { event: 'storeDisconnected' } });
      expect(reconnected).toHaveBeenCalledOnce();
      await q.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reconnect: two queues on one store share the state and both emit the events', async () => {
    const { store, ctl } = outageStore();
    schedule(store, () => 0.5);
    const a = new Queue('a', { store, logger: silent });
    const b = new Queue('b', { store, logger: silent });
    await Promise.all([a.ready(), b.ready()]);
    const seen: string[] = [];
    for (const [name, q] of [['a', a], ['b', b]] as const) {
      q.on('storeDisconnected', () => void seen.push(`${name}:down`));
      q.on('storeReconnected', () => void seen.push(`${name}:up`));
    }
    ctl.down = true;
    const from = performance.now();
    await a.getCounts().catch(() => {});
    await b.getCounts().catch(() => {});
    expect(b.connectionState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(200);
    // One probe per step, not one per queue.
    expect(gaps(ctl, 'now', from)).toEqual([100, 200, 400]);
    expect(seen.sort()).toEqual(['a:down', 'a:up', 'b:down', 'b:up']);
    await a.close();
    expect(a.connectionState).toBe('closed');
    expect(b.connectionState).toBe('connected');
    await b.close();
  });

  it('reconnect: first open that fails retries with open as the probe', async () => {
    const raw = new MemoryStore();
    let opens = 0;
    const { store, calls } = spyStore(raw, { open: () => (++opens <= 2 ? Promise.reject(new TypeError('no route')) : raw.open()) });
    schedule(store, () => 0.5);
    const q = new Queue('r', { store, logger: silent });
    const reconnected = vi.fn();
    q.on('storeReconnected', reconnected);
    await expect(q.getCounts()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'open' });
    expect(q.connectionState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(300);
    expect(q.connectionState).toBe('connected');
    expect(reconnected).toHaveBeenCalledOnce();
    expect(reconnected.mock.calls[0]![0]).toMatchObject({ attempts: 2 });
    expect(calls.map((c) => c.op)).toEqual(['open', 'open', 'open']);
    await q.close();
  });

  it('reconnect: a probe that never answers counts as failed and the next one is scheduled', async () => {
    const raw = new MemoryStore();
    let down = false;
    const { store, calls } = spyStore(raw, {
      // While down, counts fails at once and now never answers.
      counts: (sc) => (down ? Promise.reject(new TypeError('down')) : raw.counts(sc)),
      now: () => (down ? new Promise<number>(() => {}) : raw.now()),
    });
    schedule(store, () => 0.5);
    const q = new Queue('r', { store, logger: silent });
    await q.ready();
    const reconnected = vi.fn();
    q.on('storeReconnected', reconnected);
    down = true;
    await q.getCounts().catch(() => {});
    // Probe 1 at 100 ms hangs; it times out at 1100 ms and probe 2 follows 200 ms later.
    await vi.advanceTimersByTimeAsync(1299);
    expect(calls.filter((c) => c.op === 'now')).toHaveLength(2); // ready's now, probe 1
    down = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(reconnected).toHaveBeenCalledOnce();
    expect(reconnected.mock.calls[0]![0]).toEqual({ attempts: 2, downForMs: 1300 });
    await q.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconnect: invalid reconnect options throw InvalidOptionError', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ reconnect: { factor: 0.5 } }, 'reconnect.factor'],
      [{ reconnect: { jitter: 2 } }, 'reconnect.jitter'],
      [{ reconnect: { initialDelay: 0 } }, 'reconnect.initialDelay'],
      [{ reconnect: { initialDelay: 100, maxDelay: 10 } }, 'reconnect.maxDelay'],
      [{ reconnect: { delay: 10 } }, 'reconnect.delay'],
      [{ onDisconnected: 'drop' }, 'onDisconnected'],
      [{ maxWait: 0 }, 'maxWait'],
      [{ maxBufferedAdds: 0 }, 'maxBufferedAdds'],
    ];
    for (const [opts, path] of cases) {
      let e: unknown;
      try {
        new Queue('r', { logger: silent, ...opts });
      } catch (x) {
        e = x;
      }
      expect(e, path).toBeInstanceOf(InvalidOptionError);
      expect((e as InvalidOptionError).issues.map((i) => i.path), path).toContain(path);
    }
    expect(() => new Queue('r', { logger: silent, reconnect: { initialDelay: '1s', maxDelay: '1m', factor: 1, jitter: 0 }, onDisconnected: 'wait', maxWait: '2s', maxBufferedAdds: 1 })).not.toThrow();
  });

  it('reconnect: a queue attaching after every queue on the store closed sets the probe schedule afresh', async () => {
    const { store, ctl } = outageStore();
    const first = new Queue('r', { store, logger: silent, reconnect: { initialDelay: 100, jitter: 0 } });
    await first.ready();
    await first.close();
    const second = new Queue('r', { store, logger: silent, reconnect: { initialDelay: 700, jitter: 0 } });
    await second.ready();
    ctl.down = true;
    const from = performance.now();
    await second.getCounts().catch(() => {});
    await vi.advanceTimersByTimeAsync(800);
    await second.close();
    expect(gaps(ctl, 'now', from)[0]).toBe(700);
  });
});
