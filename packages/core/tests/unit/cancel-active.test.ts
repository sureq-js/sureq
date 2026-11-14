import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCancelledError, LeaseLostError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { JobContext } from '../../src/worker/context.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
/** A 3 s lease (heartbeat every second), a fixed poll, no jitter and no sweep within a test. */
const steady = { ...poll(50), random: () => 0.5, sweepInterval: 3_600_000 };
const SWEEP = { limit: 100, maxCrashes: 3, failError: '{}', poisonError: '{}' };

/** Pod A runs jobs on a spied view of the store (its `get` can be made to fail); pod B shares the store. */
function pods() {
  useFakeTime();
  const clock = { t: Date.now() };
  const inner = new MemoryStore({ clock: () => clock.t });
  const broken = { get: false, slowGetMs: 0 };
  const spy = spyStore(inner, {
    get: async (scope, id) => {
      if (broken.get) throw new TypeError('down');
      if (broken.slowGetMs > 0) await new Promise((r) => setTimeout(r, broken.slowGetMs));
      return inner.get(scope, id);
    },
  });
  const make = (store: typeof inner | typeof spy.store) => {
    const q = new Queue('ca', { store, logger: silent, leaseDuration: '3s', notify: false, shutdownAbortGrace: 0 });
    queues.push(q);
    return q;
  };
  const a = make(spy.store);
  const b = make(inner);
  const events = { leaseLost: vi.fn(), completed: vi.fn(), failed: vi.fn(), retrying: vi.fn(), error: vi.fn(), cancelled: vi.fn() };
  for (const [k, fn] of Object.entries(events)) a.on(k as 'failed', fn);
  return { clock, inner, spy, a, b, broken, events, scope: a.internals.scope };
}

/** Start one job on pod A; its handler waits for the gate, then returns or throws. */
async function running(p: ReturnType<typeof pods>, outcome: 'return' | 'throw' = 'return') {
  const g = gate();
  const { job } = await p.a.add({});
  let ctx!: JobContext;
  p.a.process(async (_j, c) => {
    ctx = c;
    await g.p;
    if (outcome === 'throw') throw new TypeError('after the abort');
    return 'late';
  }, steady);
  await vi.advanceTimersByTimeAsync(10);
  return { job, g, ctx: () => ctx };
}

describe('cancel of an active job', () => {
  it('cancel: local active handler is aborted with JobCancelledError at once', async () => {
    const p = pods();
    const { job, ctx } = await running(p);
    let resolved = false;
    let abortedFirst = false;
    ctx().signal.addEventListener('abort', () => (abortedFirst = !resolved));
    const res = p.a.cancel(job.id).then((r) => ((resolved = true), r));
    await vi.advanceTimersByTimeAsync(0);
    expect(await res).toMatchObject({ cancelled: true, previousState: 'active' });
    expect(abortedFirst).toBe(true);
    expect(ctx().signal.reason).toBeInstanceOf(JobCancelledError);
    expect(ctx().signal.reason).toMatchObject({ code: 'JOB_CANCELLED', jobId: job.id });
    expect(await p.inner.get(p.scope, job.id)).toMatchObject({ state: 'cancelled', lease: null });
    expect(p.events.cancelled).toHaveBeenCalledOnce();
  });

  it('cancel: remote active handler is aborted after its next rejected renew', async () => {
    const p = pods();
    const { job, ctx } = await running(p);
    await p.b.cancel(job.id);
    expect(ctx().signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx().signal.reason).toBeInstanceOf(JobCancelledError);
    expect(ctx().signal.reason).not.toBeInstanceOf(LeaseLostError);
    expect(p.events.leaseLost).not.toHaveBeenCalled();
    expect(p.events.error).not.toHaveBeenCalled();
    // only the calling pod emits the event
    expect(p.events.cancelled).not.toHaveBeenCalled();
  });

  it("cancel: aborted handler's result is discarded and records no failure or retry", async () => {
    for (const outcome of ['return', 'throw'] as const) {
      const p = pods();
      const { job, g } = await running(p, outcome);
      await p.a.cancel(job.id);
      g.open();
      await vi.advanceTimersByTimeAsync(1100);
      for (const k of ['completed', 'failed', 'retrying', 'leaseLost', 'error'] as const) expect(p.events[k], `${outcome} ${k}`).not.toHaveBeenCalled();
      expect(await p.inner.get(p.scope, job.id)).toMatchObject({ state: 'cancelled', attempt: 1, crashCount: 0, result: null, error: null });
      // no write follows the cancel: neither the outcome nor a release
      const writes = p.spy.calls.filter((c) => ['complete', 'fail', 'release'].includes(c.op));
      expect(writes, outcome).toHaveLength(0);
      const closing = Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
      await vi.advanceTimersByTimeAsync(5000);
      await closing;
    }
  });

  it('cancel: complete winning the race makes cancel return already-terminal', async () => {
    const p = pods();
    const { job, g, ctx } = await running(p);
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.events.completed).toHaveBeenCalledOnce();
    expect(await p.a.cancel(job.id)).toMatchObject({ cancelled: false, reason: 'already-terminal', state: 'completed' });
    expect(p.events.cancelled).not.toHaveBeenCalled();
    expect(ctx().signal.aborted).toBe(false);
  });

  it('cancel: finalising write rejected after remote cancel aborts with JobCancelledError and reports nothing', async () => {
    const p = pods();
    const { job, g, ctx } = await running(p);
    await p.b.cancel(job.id);
    // the handler returns before any renew
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.spy.calls.filter((c) => c.op === 'complete')).toHaveLength(1);
    expect(p.spy.calls.filter((c) => c.op === 'renew')).toHaveLength(0);
    expect(ctx().signal.reason).toBeInstanceOf(JobCancelledError);
    for (const k of ['completed', 'failed', 'leaseLost', 'error'] as const) expect(p.events[k], k).not.toHaveBeenCalled();
    expect((await p.inner.get(p.scope, job.id))!.state).toBe('cancelled');
  });

  it('cancel: remote handler on an unreadable store is aborted as lease loss without a crash', async () => {
    const p = pods();
    const { job, ctx } = await running(p);
    await p.b.cancel(job.id);
    p.broken.get = true;
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx().signal.reason).toBeInstanceOf(LeaseLostError);
    expect(ctx().signal.reason).toMatchObject({ reason: 'not-active' });
    expect(p.events.leaseLost).toHaveBeenCalledOnce();
    p.broken.get = false;
    expect(await p.inner.get(p.scope, job.id)).toMatchObject({ state: 'cancelled', crashCount: 0 });
  });

  it('cancel: cancel from inside the handler on itself is allowed', async () => {
    const p = pods();
    const { job } = await p.a.add({});
    let reason: unknown;
    p.a.process(async (j, c) => {
      expect(await j.cancel()).toMatchObject({ cancelled: true, previousState: 'active' });
      reason = c.signal.reason;
      return 'discarded';
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    expect(reason).toBeInstanceOf(JobCancelledError);
    expect(p.events.completed).not.toHaveBeenCalled();
    expect(await p.inner.get(p.scope, job.id)).toMatchObject({ state: 'cancelled', result: null });
  });

  it('cancel: the local lease deadline passing while the cancel is read is not a lease loss', async () => {
    const p = pods();
    const { job, ctx } = await running(p);
    await p.b.cancel(job.id);
    // the read after the rejected renew outlasts the 3 s lease
    p.broken.slowGetMs = 5000;
    await vi.advanceTimersByTimeAsync(7000);
    expect(ctx().signal.reason).toBeInstanceOf(JobCancelledError);
    expect(p.events.leaseLost).not.toHaveBeenCalled();
  });

  it('cancel: a cancelled handler still running at shutdown is not released', async () => {
    const p = pods();
    const { job } = await running(p);
    await p.a.cancel(job.id);
    const closing = p.a.close({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(2000);
    await closing;
    expect(p.spy.calls.filter((c) => c.op === 'release')).toHaveLength(0);
    expect((await p.inner.get(p.scope, job.id))!.state).toBe('cancelled');
  });

  it('cancel: a cancelled handler frees its slot once it returns', async () => {
    for (const where of ['local', 'remote'] as const) {
      const p = pods();
      const { job, g } = await running(p);
      if (where === 'local') await p.a.cancel(job.id);
      else {
        await p.b.cancel(job.id);
        await vi.advanceTimersByTimeAsync(1100);
      }
      g.open();
      await vi.advanceTimersByTimeAsync(10);
      const { job: second } = await p.a.add({});
      await vi.advanceTimersByTimeAsync(100);
      expect(p.events.completed, where).toHaveBeenCalledOnce();
      expect((await p.inner.get(p.scope, second.id))!.state, where).toBe('completed');
      const closing = Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
      await vi.advanceTimersByTimeAsync(5000);
      await closing;
    }
  });

  it('cancel: a lease loss that is not a cancel still reports leaseLost', async () => {
    const p = pods();
    const { job, ctx } = await running(p);
    // the store's clock passes the lease and a sweep requeues the job
    p.clock.t += 31_000;
    await p.inner.sweep(p.scope, SWEEP);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx().signal.reason).toBeInstanceOf(LeaseLostError);
    expect(p.events.leaseLost).toHaveBeenCalledOnce();
    expect((await p.inner.get(p.scope, job.id))!.state).not.toBe('cancelled');
  });
});
