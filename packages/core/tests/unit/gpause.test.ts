import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueClosedError } from '../../src/errors/catalog.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import type { Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { killClaim } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.allSettled(queues.splice(0).map((q) => q.close({ timeoutMs: 0 })));
  vi.useRealTimers();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL = 20;

/** `pod()` is one more Queue object over the same store, standing for another pod. */
function setup(storeOpts: ConstructorParameters<typeof MemoryStore>[0] = {}) {
  const store = new MemoryStore(storeOpts);
  const pod = (opts: QueueOptions = {}, s: Store = store) => {
    const q = new Queue('g', { store: s, logger: silent, notify: false, ...poll(POLL), ...opts });
    queues.push(q);
    return q;
  };
  return { store, pod };
}

describe('gpause: global pause', () => {
  it("gpause: pause stops all pods' workers from claiming", async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    const ran = vi.fn();
    a.process(ran);
    b.process(ran);
    expect(await a.pause()).toEqual({ changed: true });
    await a.add(1);
    await b.add(2);
    await sleep(POLL * 4);
    expect(ran).not.toHaveBeenCalled();
    expect((await a.getCounts()).waiting).toBe(2);
  });

  it('gpause: running jobs finish after pause', async () => {
    const { pod } = setup();
    const a = pod();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = a.process(() => gate);
    const started = new Promise((r) => w.once('active', r));
    await a.add(1);
    await started;
    await a.pause();
    const completed = new Promise((r) => w.once('completed', r));
    open();
    await completed;
    expect((await a.getCounts()).completed).toBe(1);
  });

  it('gpause: resume wakes idle workers in another pod within pollMax', async () => {
    vi.useFakeTimers();
    const { pod } = setup();
    const a = pod();
    const b = pod({ pollMin: 100, pollMax: 1000 });
    const ran = vi.fn();
    b.process(ran);
    await a.pause();
    await a.add(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).not.toHaveBeenCalled();
    await a.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('gpause: resume wakes with notify via subscription', async () => {
    vi.useFakeTimers();
    const { pod } = setup();
    const a = pod();
    const b = pod({ notify: true, ...poll(60_000) });
    const ran = vi.fn();
    b.process(ran);
    await a.pause();
    await a.add(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(ran).not.toHaveBeenCalled();
    await a.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('gpause: new pod started while paused claims nothing', async () => {
    const { pod } = setup();
    const a = pod();
    await a.pause();
    await a.add(1);
    const b = pod();
    const ran = vi.fn();
    const w = b.process(ran);
    expect(b.isPaused()).toBe(false);
    await vi.waitFor(() => expect(b.isPaused()).toBe(true));
    expect(w.isPaused('global')).toBe(true);
    await sleep(POLL * 3);
    expect(ran).not.toHaveBeenCalled();
  });

  it('gpause: producer-only queue can pause and resume', async () => {
    const { pod } = setup();
    const a = pod();
    expect(await a.pause()).toEqual({ changed: true });
    expect(await a.pause()).toEqual({ changed: false });
    expect(a.isPaused()).toBe(true);
    expect(await a.resume()).toEqual({ changed: true });
    expect(await a.resume()).toEqual({ changed: false });
    expect(a.isPaused()).toBe(false);
  });

  it('gpause: pause is idempotent and reports changed', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    const results = await Promise.all([a.pause(), b.pause()]);
    expect(results.map((r) => r.changed).sort()).toEqual([false, true]);
    expect([a.isPaused(), b.isPaused()]).toEqual([true, true]);
  });

  it('gpause: sweeper requeues expired jobs while paused and they wait for resume', async () => {
    const clock = { now: 1_000_000 };
    const { store, pod } = setup({ clock: () => clock.now });
    const a = pod();
    const { job } = await a.add(1);
    await killClaim(store, 'g', { leaseMs: 1000 });
    await a.pause();
    const ran = vi.fn();
    const w = a.process(ran, { sweepInterval: '500ms' });
    const stalled = new Promise((r) => a.once('stalled', r));
    clock.now += 2000;
    await stalled;
    expect(await store.get(a.internals.scope, job.id)).toMatchObject({ state: 'waiting', crashCount: 1 });
    await sleep(POLL * 3);
    expect(ran).not.toHaveBeenCalled();
    await a.resume();
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
    expect(w.isPaused()).toBe(false);
  });

  it('gpause: local and global pause combine', async () => {
    const { pod } = setup();
    const a = pod();
    const ran = vi.fn();
    const w = a.process(ran);
    await w.pause();
    await a.pause();
    expect([w.isPaused('local'), w.isPaused('global'), w.isPaused()]).toEqual([true, true, true]);
    await a.add(1);
    await a.resume();
    expect([w.isPaused('local'), w.isPaused('global'), w.isPaused()]).toEqual([true, false, true]);
    await sleep(POLL * 3);
    expect(ran).not.toHaveBeenCalled();
    await a.pause();
    w.resume();
    expect([w.isPaused('local'), w.isPaused('global'), w.isPaused()]).toEqual([false, true, true]);
    await sleep(POLL * 3);
    expect(ran).not.toHaveBeenCalled();
    await a.resume();
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
  });

  it('gpause: pause on closed queue throws QueueClosedError', async () => {
    const { pod } = setup();
    const a = pod();
    await a.close();
    await expect(a.pause()).rejects.toBeInstanceOf(QueueClosedError);
    await expect(a.resume()).rejects.toBeInstanceOf(QueueClosedError);
    await expect(a.pauseState()).rejects.toBeInstanceOf(QueueClosedError);
  });

  it('gpause: pauseState reads the store', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    await a.pause();
    expect(b.isPaused()).toBe(false);
    expect(await b.pauseState()).toEqual({ paused: true });
    expect(b.isPaused()).toBe(true);
  });

  it('gpause: a store error from pause propagates and changes nothing', async () => {
    const store = new MemoryStore({ faults: { before: (op) => {
      if (op === 'setPaused') throw new TypeError('down');
    } } });
    const a = new Queue('g', { store, logger: silent });
    queues.push(a);
    a.on('error', () => {});
    a.on('storeDisconnected', () => {});
    await expect(a.pause()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(a.isPaused()).toBe(false);
  });

  it('gpause: the pause check is one store read per queue and close waits for it quietly', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const spy = spyStore(new MemoryStore(), {
      isPaused: async () => {
        await gate;
        throw new TypeError('late');
      },
    });
    const b = new Queue('g', { store: spy.store, logger: silent, notify: false, ...poll(POLL) });
    const errors = vi.fn();
    b.on('error', errors);
    b.process({ x: () => {} });
    b.process({ y: () => {} });
    await b.pause();
    await sleep(POLL * 5);
    expect(spy.calls.filter((c) => c.op === 'isPaused')).toHaveLength(1);
    let closed = false;
    const closing = b.close().then(() => (closed = true));
    await sleep(POLL);
    expect(closed).toBe(false);
    open();
    await closing;
    expect(errors).not.toHaveBeenCalled();
  });

  it('gpause: a pause check that never answers is dropped quietly at the close deadline', async () => {
    const spy = spyStore(new MemoryStore(), { isPaused: () => new Promise<boolean>(() => {}) });
    const b = new Queue('g', { store: spy.store, logger: silent, notify: false, shutdownAbortGrace: 0, ...poll(POLL) });
    const errors = vi.fn();
    b.on('error', errors);
    b.process(() => {});
    await b.pause();
    await vi.waitFor(() => expect(spy.calls.filter((c) => c.op === 'isPaused')).toHaveLength(1));
    const t0 = performance.now();
    await b.close({ timeoutMs: 50 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(errors).not.toHaveBeenCalled();
  });

  it('gpause: getCounts blocked equals waiting while paused', async () => {
    const { pod } = setup();
    const a = pod();
    await a.add(1);
    await a.add(2);
    await a.pause();
    expect(await a.getCounts()).toMatchObject({ waiting: 2, blocked: 2 });
    await a.resume();
    expect(await a.getCounts()).toMatchObject({ waiting: 2, blocked: 0 });
  });

  it('gpause: add, remove and counts work while paused', async () => {
    const { pod } = setup();
    const a = pod();
    const drained = vi.fn();
    a.on('drained', drained);
    a.process(() => {});
    await a.pause();
    const one = (await a.add(1)).job;
    await a.add(2);
    expect((await a.getJob(one.id))!.state).toBe('waiting');
    expect(await a.remove(one.id)).toBe(true);
    expect(await a.getCounts()).toMatchObject({ waiting: 1, blocked: 1 });
    await sleep(POLL * 3);
    expect(drained).not.toHaveBeenCalled();
  });
  it('polling: paused queue polls at pollMax and wakes on resume', async () => {
    useFakeTime();
    const inner = new MemoryStore({ clock: () => Date.now() });
    const spy = spyStore(inner);
    const q = new Queue('g', { store: spy.store, logger: silent, notify: false, pollMin: 100, pollMax: 5000, pollJitter: 0 });
    queues.push(q);
    await q.pause();
    await q.add({});
    const done = vi.fn();
    q.process(done);
    await vi.advanceTimersByTimeAsync(12_000);
    const claims = spy.calls.filter((c) => c.op === 'claim').map((c) => c.at);
    expect(claims.slice(1).map((t, i) => t - claims[i]!)).toEqual([5000, 5000]);
    await q.resume();
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
  });

  it('polling: local adds do not wake a worker while the queue is known paused', async () => {
    useFakeTime();
    const inner = new MemoryStore({ clock: () => Date.now() });
    const spy = spyStore(inner);
    const q = new Queue('g', { store: spy.store, logger: silent, notify: false, pollMin: 100, pollMax: 5000, pollJitter: 0 });
    queues.push(q);
    await q.pause();
    await q.add({});
    q.process(() => {});
    await vi.advanceTimersByTimeAsync(10);
    const before = spy.calls.filter((c) => c.op === 'claim').length;
    for (let i = 0; i < 10; i++) {
      await q.add({ i });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(spy.calls.filter((c) => c.op === 'claim').length - before).toBe(0);
    vi.useRealTimers();
  });

  it('gpause: pause and resume called together leave this pod agreeing with the store, whatever order the answers come in', async () => {
    const inner = new MemoryStore();
    let calls = 0;
    // each setPaused applies at once; the first answer is slower than the second
    const { store } = spyStore(inner, {
      setPaused: async (scope, paused) => {
        const res = await inner.setPaused(scope, paused);
        await sleep(calls++ === 0 ? 40 : 0);
        return res;
      },
    });
    const q = new Queue('p', { store, logger: silent });
    queues.push(q);
    await q.ready();
    await Promise.all([q.pause(), q.resume()]);
    const stored = await inner.isPaused({ namespace: 'default', queue: 'p' });
    expect(stored).toBe(false);
    expect(q.isPaused()).toBe(stored);
  });
});
