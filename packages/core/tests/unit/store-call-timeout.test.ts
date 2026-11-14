import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, StoreUnavailableError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { RECONNECT_DEFAULTS, StoreClient, type ConnectionEvent } from '../../src/store/client.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { StoreOp } from '../../src/store/types.js';
import { useFakeTime } from '../helpers/fake-time.js';

const scope = { namespace: 'default', queue: 'q' };

/** A client on a memory store whose `hung` operation waits on `gate` (never settles unless the test settles it). */
function hungClient(hung: StoreOp, gate: Promise<void> = new Promise(() => {})) {
  const store = new MemoryStore({ faults: { before: (op) => (op === hung ? gate : undefined) } });
  const client = new StoreClient(store);
  client.attach(true);
  client.configure(RECONNECT_DEFAULTS, 1000);
  const events: ConnectionEvent[] = [];
  client.onConnection((e) => events.push(e));
  return { client, events };
}

afterEach(() => vi.useRealTimers());

describe('store call deadline', () => {
  it('store: a hung call rejects with a retryable unavailable error after the deadline', async () => {
    useFakeTime();
    const { client, events } = hungClient('get');
    const call = client.call('get', scope, 'j1');
    const settled = vi.fn();
    call.catch(() => {}).finally(settled);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect(err).toMatchObject({ operation: 'get', retryable: true, jobId: 'j1' });
    // The timeout starts an outage; the store still answers now(), so the probe ends it.
    expect(events.map((e) => e.type)).toEqual(['disconnected']);
    expect(client.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(200);
    expect(client.state).toBe('connected');
    expect(events.map((e) => e.type)).toEqual(['disconnected', 'reconnected']);
    await client.close();
  });

  it('store: a timed-out write marks the outcome unknown', async () => {
    useFakeTime();
    const { client } = hungClient('setPaused');
    const call = client.call('setPaused', scope, true).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await call).toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'setPaused', outcomeUnknown: true });
    await client.close();
  });

  it('store: a write whose open outlasts the deadline is never sent', async () => {
    useFakeTime();
    const store = new MemoryStore();
    const open = store.open.bind(store);
    vi.spyOn(store, 'open').mockImplementation(() => new Promise((r) => setTimeout(r, 1500)).then(open));
    const write = vi.spyOn(store, 'setPaused');
    const client = new StoreClient(store);
    client.attach(true);
    client.configure(RECONNECT_DEFAULTS, 1000);
    const call = client.call('setPaused', scope, true).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await call).toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'setPaused' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.open).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await client.close();
  });

  it('store: a timed-out read does not mark the outcome unknown', async () => {
    useFakeTime();
    const { client } = hungClient('isPaused');
    const call = client.call('isPaused', scope).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await call).toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'isPaused', outcomeUnknown: false });
    await client.close();
  });

  it('store: a result arriving after the deadline is ignored', async () => {
    useFakeTime();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let release!: () => void;
      let fail!: (e: unknown) => void;
      const late = new Promise<void>((resolve) => (release = resolve));
      const lateFailure = new Promise<void>((_, reject) => (fail = reject));
      const store = new MemoryStore({ faults: { before: (op) => (op === 'get' ? late : op === 'isPaused' ? lateFailure : undefined) } });
      const client = new StoreClient(store);
      client.attach(true);
      client.configure(RECONNECT_DEFAULTS, 1000);
      const events: string[] = [];
      client.onConnection((e) => events.push(e.type));
      const read = client.call('get', scope, 'j1').then(
        (v) => ({ v }),
        (e: unknown) => ({ e }),
      );
      const paused = client.call('isPaused', scope).then(
        (v) => ({ v }),
        (e: unknown) => ({ e }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(200);
      expect(events).toEqual(['disconnected', 'reconnected']);
      release();
      fail(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await read).toMatchObject({ e: { code: 'STORE_UNAVAILABLE' } });
      expect(await paused).toMatchObject({ e: { code: 'STORE_UNAVAILABLE' } });
      expect(events).toEqual(['disconnected', 'reconnected']);
      expect(client.state).toBe('connected');
      expect(unhandled).not.toHaveBeenCalled();
      await client.close();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('store: the call timer is cleared when the call settles in time', async () => {
    useFakeTime();
    const store = new MemoryStore();
    const client = new StoreClient(store);
    client.attach(true);
    client.configure(RECONNECT_DEFAULTS, 1000);
    expect(await client.call('isPaused', scope)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await client.close();
  });

  it('store: the deadline defaults to 30 s and comes from the first queue on the store', async () => {
    useFakeTime();
    const store = new MemoryStore({ faults: { before: (op) => (op === 'get' ? new Promise(() => {}) : undefined) } });
    const first = new Queue('a', { store, storeCallTimeout: '2s' });
    const second = new Queue('b', { store, storeCallTimeout: '1h' });
    const read = second.getJob('j1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await read).toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'get' });
    await Promise.all([first.close(), second.close()]);

    const alone = new Queue('c', { store });
    const slow = alone.getJob('j1').catch((e: unknown) => e);
    const settled = vi.fn();
    void slow.finally(settled);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await slow).toMatchObject({ code: 'STORE_UNAVAILABLE' });
    await alone.close();
  });

  it('options: storeCallTimeout rejects 0 and a misspelling names storeCallTimeout', () => {
    expect(() => new Queue('q', { storeCallTimeout: 0 })).toThrow(InvalidOptionError);
    expect(() => new Queue('q', { storeCallTimeout: 0 })).toThrow(/storeCallTimeout/);
    expect(() => new Queue('q', { storeCallTimout: '5s' } as never)).toThrow(/did you mean "storeCallTimeout"/);
    expect(() => void new Queue('q', { storeCallTimeout: '5s' }).close()).not.toThrow();
  });
});
