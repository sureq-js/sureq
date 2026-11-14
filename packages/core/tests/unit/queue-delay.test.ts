import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs, stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { addVia } from '../helpers/add-via.js';
import { poll } from '../helpers/poll.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const setup = (start = 1_000_000) => {
  const c = { t: start };
  const store = new MemoryStore({ clock: () => c.t });
  const queue = new Queue('delays', { store, logger: silent });
  const scope = queue.internals.scope;
  const claimAll = async () => (await claimJobs(store, scope, { workerId: 'w', limit: 100, order: 'fifo' })).map((r) => r.id);
  return { c, store, queue, scope, claimAll };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('delay (store time through the queue)', () => {
  it('delay: job with delay is delayed and not claimable', async () => {
    const { store, queue, scope, claimAll } = setup();
    const id = await addVia(queue, {}, { delay: 30_000 });
    expect(await stored(store, scope, id)).toMatchObject({ state: 'delayed', runAt: 1_030_000 });
    expect(await claimAll()).toEqual([]);
  });

  it('delay: job becomes waiting and claimable when store time reaches runAt', async () => {
    const { c, queue, claimAll } = setup();
    const id = await addVia(queue, {}, { delay: 30_000 });
    c.t = 1_029_999;
    expect(await claimAll()).toEqual([]);
    c.t = 1_030_000;
    expect(await claimAll()).toEqual([id]);
  });

  it('delay: counts show delayed and waiting separately and consistently at the boundary', async () => {
    const { c, store, queue, scope } = setup();
    await addVia(queue, {}, { delay: '30s' });
    c.t = 1_029_999;
    expect(await store.counts(scope)).toMatchObject({ delayed: 1, waiting: 0 });
    c.t = 1_030_000;
    expect(await store.counts(scope)).toMatchObject({ delayed: 0, waiting: 1 });
  });

  it('delay: delay 0 and past runAt are waiting immediately', async () => {
    const { c, store, queue, scope } = setup();
    const a = await addVia(queue, {}, { delay: 0 });
    const b = await addVia(queue, {}, { runAt: c.t - 86_400_000 * 30 });
    expect((await stored(store, scope, a))!.state).toBe('waiting');
    expect((await stored(store, scope, b))!.state).toBe('waiting');
    expect((await store.counts(scope)).delayed).toBe(0);
  });

  it('delay: delay is computed from store clock, not pod clock', async () => {
    vi.useFakeTimers();
    const { store, queue, scope } = setup(5_000_000);
    vi.setSystemTime(Date.now() + 3_600_000);
    const a = await addVia(queue, {}, { delay: 30_000 });
    vi.setSystemTime(Date.now() - 7_200_000);
    const b = await addVia(queue, {}, { delay: 30_000 });
    expect((await stored(store, scope, a))!.runAt).toBe(5_030_000);
    expect((await stored(store, scope, b))!.runAt).toBe(5_030_000);
  });

  it('delay: promoted job enters by priority and seq, not at the back', async () => {
    for (const [aPrio, bPrio, expected] of [
      [0, 0, ['A', 'B', 'C']],
      [5, 0, ['A', 'B', 'C']],
      [0, 9, ['B', 'A', 'C']],
    ] as const) {
      const { c, queue, claimAll } = setup();
      const ids: Record<string, string> = {};
      ids['A'] = await addVia(queue, 'A', { priority: aPrio, delay: 10_000 });
      ids['B'] = await addVia(queue, 'B', { priority: bPrio });
      ids['C'] = await addVia(queue, 'C', { priority: 0 });
      c.t += 10_000;
      const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
      expect((await claimAll()).map((id) => byId[id])).toEqual(expected);
    }
  });
});

describe('delay with workers, remove and drained', () => {
  const opened: Queue[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  });
  const withWorker = (opts: Record<string, unknown> = {}) => {
    const s = setup();
    opened.push(s.queue);
    const drained = vi.fn();
    s.queue.on('drained', drained);
    return { ...s, drained, ...opts };
  };

  it('delay: drained does not fire while a delayed job exists, due or not due', async () => {
    const { c, queue, drained } = withWorker();
    const ran = vi.fn();
    queue.process(() => void ran(), { ...poll(60_000) });
    const completed = new Promise<void>((r) => queue.on('completed', () => r()));
    await queue.add('later', { delay: 30_000 });
    await queue.add('now');
    await completed;
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).not.toHaveBeenCalled();
    c.t += 30_000; // due, not yet claimed: counts as waiting
    expect((await queue.getCounts()).waiting).toBe(1);
    expect(drained).not.toHaveBeenCalled();
    const done = new Promise<void>((r) => queue.on('drained', () => r()));
    await queue.add('nudge'); // wakes the worker; it claims both
    await done;
    expect(drained).toHaveBeenCalledOnce();
  });

  it('delay: drained fires after the last delayed job runs or is removed', async () => {
    const { queue, drained } = withWorker();
    const { job } = await queue.add('later', { delay: 60_000 });
    expect(drained).not.toHaveBeenCalled();
    expect(await job.remove()).toBe(true);
    expect(drained).toHaveBeenCalledOnce();
  });

  it('delay: delayed job can be removed', async () => {
    const { queue } = withWorker();
    const { job } = await queue.add(1, { delay: '1h' });
    expect(await job.remove()).toBe(true);
    expect(await queue.getJob(job.id)).toBeNull();
  });

  it('delay: worker wakes by runAt within pollInterval for a locally added job', async () => {
    const { c, queue } = withWorker();
    let ranAt: number | undefined;
    queue.process(() => void (ranAt = c.t), { ...poll(20) });
    await queue.add(1, { delay: 1000 });
    await new Promise((r) => setTimeout(r, 60));
    expect(ranAt).toBeUndefined(); // store clock has not reached runAt
    c.t += 1000;
    const t0 = Date.now();
    await vi.waitFor(() => expect(ranAt).toBeDefined(), { timeout: 1000, interval: 5 });
    expect(Date.now() - t0).toBeLessThan(200); // within a few poll intervals of 20 ms
    expect(ranAt).toBe(1_001_000);
  });

  it('delay: retry wait is a delayed job with attempt >= 1', async () => {
    const { c, queue } = withWorker();
    queue.process(() => Promise.reject(new TypeError('once')), { ...poll(60_000) });
    const retrying = new Promise<void>((r) => queue.once('retrying', () => r()));
    const { job } = await queue.add(1, { backoff: { type: 'fixed', delay: 5000 }, maxAttempts: 3 });
    const failTime = c.t;
    await retrying;
    expect(await queue.getJob(job.id)).toMatchObject({ state: 'delayed', attempt: 1, runAt: failTime + 5000 });
  });
});
