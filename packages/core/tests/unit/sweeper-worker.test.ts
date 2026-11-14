import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { live, twoPods } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';

const queues: Queue[] = [];
afterEach(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

/** One queue on a MemoryStore with a hand-driven clock (`clock.t`) and a spy on `sweep`. */
function world() {
  useFakeTime();
  const clock = { t: 5_000_000 };
  const store = new MemoryStore({ clock: () => clock.t });
  const sweep = vi.spyOn(store, 'sweep');
  const q = new Queue('s', { store, logger: silent });
  queues.push(q);
  return { clock, store, sweep, q };
}

/** Fixed sweep interval and no jitter. */
const fast = { ...poll(50), sweepInterval: 500, random: () => 0.5 };

describe('sweeper per queue', () => {
  it('sweep: sweeper starts with a worker and not in producer-only mode', async () => {
    const w = world();
    const { job } = await w.q.add({ n: 1 });
    await w.q.getJob(job.id);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.sweep).not.toHaveBeenCalled();
    const worker = w.q.process(() => {}, { autorun: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.sweep).not.toHaveBeenCalled();
    await worker.run();
    // Default interval 5 s, at most 20 % later.
    await vi.advanceTimersByTimeAsync(6000);
    expect(w.sweep).toHaveBeenCalled();
    expect(w.sweep.mock.calls[0]![1]).toMatchObject({ limit: 100, maxCrashes: 3 });
  });

  it('sweep: pods in one process share one sweeper per queue', async () => {
    const w = world();
    const a = w.q.process({ a: () => {} }, fast);
    const b = w.q.process({ b: () => {} }, fast);
    await vi.advanceTimersByTimeAsync(500);
    expect(w.sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(w.sweep).toHaveBeenCalledTimes(2);
    await a.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(w.sweep).toHaveBeenCalledTimes(3);
    await b.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.sweep).toHaveBeenCalledTimes(3);
  });

  it('sweep: sweeper stops after worker stops claiming during shutdown', async () => {
    const w = world();
    const g = gate();
    const started = gate();
    await w.q.add({ n: 1 });
    const worker = w.q.process(async () => {
      started.open();
      await g.p;
    }, fast);
    await started.p;
    await vi.advanceTimersByTimeAsync(500);
    const closing = worker.close();
    await vi.advanceTimersByTimeAsync(0);
    const count = w.sweep.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.sweep).toHaveBeenCalledTimes(count);
    expect(worker.inFlight).toBe(1);
    g.open();
    await closing;
  });

  it('events: drained fires when the sweeper fails the last job', async () => {
    const w = world();
    const scope = w.q.internals.scope;
    const drained = vi.fn();
    w.q.on('drained', drained);
    const { job } = await w.q.add({}, { maxAttempts: 1 });
    await w.store.claim(scope, { workerId: 'dead', limit: 1, leaseMs: 30_000, claimId: 'c1' });
    w.q.process({ other: () => {} }, fast);
    w.clock.t += 30_001;
    await vi.advanceTimersByTimeAsync(500);
    expect(await w.q.getJob(job.id)).toMatchObject({ state: 'failed', error: { code: 'JOB_STALLED' } });
    expect(drained).toHaveBeenCalledTimes(1);
    expect(drained).toHaveBeenCalledWith({ queue: 's' });
  });

  it('sweep: sweeps keep running while the queue is paused', async () => {
    const w = world();
    const scope = w.q.internals.scope;
    const { job } = await w.q.add({ n: 1 });
    await w.store.claim(scope, { workerId: 'dead', limit: 1, leaseMs: 30_000, claimId: 'c1' });
    w.q.process({ other: () => {} }, fast);
    await w.store.setPaused(scope, true);
    w.clock.t += 30_001;
    await vi.advanceTimersByTimeAsync(500);
    expect(await w.q.getJob(job.id)).toMatchObject({ state: 'waiting', crashCount: 1 });
  });
  it("lease-config: crashed worker's job is reclaimed within its name's lease plus sweep interval", async () => {
    const w = twoPods({ name: 'lc', queue: { leaseDuration: '30s', leaseDurationByName: { short: '2s' } } });
    try {
      const a = w.pod({ freezable: true });
      const { job } = await w.b.add({}, { name: 'short' });
      a.queue.process({ short: () => new Promise(() => {}) }, live);
      await vi.advanceTimersByTimeAsync(10);
      expect((await w.store.get(w.scope, job.id))!.lease!.expiresAt - w.clock.t).toBe(2000);
      a.view!.freeze();
      const b = w.pod();
      b.queue.process({ short: () => 'B' }, live);
      w.clock.t += 2001;
      // one sweep interval (500 ms) and the next poll
      await vi.advanceTimersByTimeAsync(600);
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'completed', result: 'B', crashCount: 1 });
    } finally {
      await w.teardown();
    }
  });
});
