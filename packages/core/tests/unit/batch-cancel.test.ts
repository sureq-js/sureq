import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCancelledError, LeaseLostError } from '../../src/errors/catalog.js';
import type { CompleteRequest, FailRequest } from '../../src/store/contract.js';
import type { BatchContext, BatchJob } from '../../src/worker/batch.js';
import type { BatchWorker } from '../../src/worker/worker.js';
import { addAll, batchSetup, closeBatchQueues, gate, ids } from '../helpers/batch.js';
import { harness } from '../helpers/harness.js';

afterEach(closeBatchQueues);

const SWEEP = { limit: 10, maxCrashes: 3, failError: '{}', poisonError: '{}' };
const events = (w: BatchWorker) => {
  const seen: Array<[string, string]> = [];
  for (const e of ['completed', 'failed', 'retrying', 'leaseLost'] as const) {
    w.on(e, (p) => void seen.push([e, (p as { job: { id: string } }).job.id]));
  }
  return seen;
};

/** Three jobs running in one gated batch on a store with a hand-driven clock. */
async function running(o: { batchDelay?: string; result?: () => unknown } = {}) {
  const h = harness();
  const s = batchSetup({ inner: h.raw });
  await addAll(s.q, ids(3));
  const g = gate();
  let jobs: BatchJob[] = [];
  let ctx!: BatchContext;
  const w = s.run({ batchSize: 3, ...(o.batchDelay && { batchDelay: o.batchDelay as '1h' }) }, async (batch, c) => {
    jobs = [...batch.jobs];
    ctx = c;
    await g.p;
    return (o.result ?? (() => ['a', 'b', 'c']))() as never;
  });
  const seen = events(w);
  await vi.advanceTimersByTimeAsync(100);
  return { h, s, g, w, seen, jobs: () => jobs, ctx: () => ctx };
}

/** Another worker takes job `id`: every other job's lease is renewed, then the clock passes the lease and a sweep requeues `id`. */
async function steal(h: ReturnType<typeof harness>, s: ReturnType<typeof batchSetup>, id: string) {
  h.clock.advance(20_000);
  for (const rec of await h.raw.list(s.scope, { state: 'active', offset: 0, limit: 10, order: 'asc' })) {
    if (rec.id !== id) await h.raw.renew(s.scope, { id: rec.id, token: rec.token, leaseMs: 30_000 });
  }
  h.clock.advance(11_000);
  // Sent together, so the requeued job goes to `other` before this pod's worker wakes for it.
  const [, claim] = await Promise.all([h.raw.sweep(s.scope, SWEEP), h.raw.claim(s.scope, { workerId: 'other', limit: 1, leaseMs: 30_000, claimId: 'c' })]);
  return claim.jobs[0]!;
}

const writesFor = (s: ReturnType<typeof batchSetup>, id: string, token: number) =>
  s.spy.calls.filter((c) => (c.op === 'complete' || c.op === 'fail') && (c.args[1] as CompleteRequest | FailRequest).id === id && (c.args[1] as CompleteRequest).token === token);

describe('one job lost or cancelled in a batch', () => {
  it('batch: one lost lease aborts only that job and its siblings commit', async () => {
    const r = await running();
    const [j1, j2, j3] = r.jobs();
    const again = await steal(r.h, r.s, 'j2');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(j2!.signal.reason).toBeInstanceOf(LeaseLostError);
    expect((j2!.signal.reason as LeaseLostError).reason).toBe('superseded');
    expect([j1!.signal.aborted, j3!.signal.aborted, r.ctx().signal.aborted]).toEqual([false, false, false]);
    r.g.open();
    await vi.advanceTimersByTimeAsync(100);
    expect([(await r.s.q.getJob('j1'))!.result, (await r.s.q.getJob('j3'))!.result]).toEqual(['a', 'c']);
    expect(writesFor(r.s, 'j2', j2!.token)).toEqual([]);
    expect(await r.h.raw.get(r.s.scope, 'j2')).toMatchObject({ state: 'active', token: again.token, lease: { owner: 'other' } });
    expect(r.seen.sort()).toEqual([['completed', 'j1'], ['completed', 'j3'], ['leaseLost', 'j2']]);
  });

  it('batch: one lost lease drops or aborts only that job', async () => {
    const h = harness();
    const s = batchSetup({ inner: h.raw });
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    const seen = events(w);
    await vi.advanceTimersByTimeAsync(100);
    await steal(h, s, 'j2');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.batch.held).toBe(2);
    await expect(w.batch.flush()).resolves.toBe(2);
    expect(s.calls.map((c) => c.ids)).toEqual([['j1', 'j3']]);
    expect(seen.filter(([e]) => e === 'leaseLost')).toEqual([['leaseLost', 'j2']]);

    // While running, only the lost job's signal aborts.
    await closeBatchQueues();
    const r = await running();
    await steal(r.h, r.s, 'j1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.jobs().map((j) => j.signal.aborted)).toEqual([true, false, false]);
    r.g.open();
  });

  it('batch: held job cancelled before handler start is not delivered', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    await s.q.cancel('j2');
    await w.batch.flush();
    expect(s.calls.map((c) => c.ids)).toEqual([['j1', 'j3']]);
  });

  it('batch-result: settlement of a cancelled task rejects with JobCancelledError, lost lease with LeaseLostError', async () => {
    const r = await running();
    const [j1, j2] = r.jobs();
    await r.s.q.cancel('j2');
    await steal(r.h, r.s, 'j1');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(r.ctx().complete(j2!, 1)).rejects.toBeInstanceOf(JobCancelledError);
    await expect(r.ctx().fail(j1!, new Error('x'))).rejects.toBeInstanceOf(LeaseLostError);
    r.g.open();
  });

  it('batch-result: lost lease on one job aborts only that job.signal', async () => {
    const r = await running();
    await steal(r.h, r.s, 'j3');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.jobs().map((j) => j.signal.aborted)).toEqual([false, false, true]);
    expect(r.ctx().signal.aborted).toBe(false);
    r.g.open();
  });

  it('batch-cancel: cancelling a waiting job keeps it out of later batches', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(4));
    await s.q.cancel('j2');
    s.run({ batchSize: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(s.calls.map((c) => c.ids)).toEqual([['j1', 'j3'], ['j4']]);
  });

  it('batch-cancel: cancelling a held job drops it from the forming batch on the same pod', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    expect(w.batch.held).toBe(3);
    await s.q.cancel('j2');
    expect(w.batch.held).toBe(2);
    await expect(w.batch.flush()).resolves.toBe(2);
    expect(s.calls[0]!.ids).toEqual(['j1', 'j3']);
  });

  it('batch-cancel: cancelling a held job on another pod drops it by next renew', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    await s.other().cancel('j2');
    expect(w.batch.held).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.batch.held).toBe(2);
    await w.batch.flush();
    expect(s.calls[0]!.ids).toEqual(['j1', 'j3']);
  });

  it('batch-cancel: held job cancelled after its last renew reaches the handler and is settled as cancelled', async () => {
    const s = batchSetup({
      over: (inner) => ({
        renew: async (scope, req) => {
          const res = await inner.renew(scope, req);
          if (req.started && req.id === 'j2') await inner.cancel(scope, { id: 'j2' });
          return res;
        },
      }),
    });
    await addAll(s.q, ids(3));
    let rejected: unknown;
    let cancelled: boolean | undefined;
    const w = s.run({ batchSize: 5, batchDelay: '9s' }, async ({ jobs }, ctx) => {
      rejected = await ctx.complete(jobs[1]!, 1).catch((e: unknown) => e);
      cancelled = jobs[1]!.cancelled;
    });
    const seen = events(w);
    await vi.advanceTimersByTimeAsync(9100);
    expect(s.calls[0]!.ids).toEqual(ids(3));
    expect(rejected).toBeInstanceOf(JobCancelledError);
    expect(cancelled).toBe(true);
    expect(seen.sort()).toEqual([['completed', 'j1'], ['completed', 'j3']]);
    expect((await s.q.getJob('j2'))!.state).toBe('cancelled');
  });

  it('batch-cancel: cancelling a running task aborts only that task signal with JobCancelledError', async () => {
    const r = await running();
    const [j1, j2, j3] = r.jobs();
    await r.s.q.cancel('j2');
    expect(j2!.signal.reason).toBeInstanceOf(JobCancelledError);
    expect(j2!.cancelled).toBe(true);
    expect([j1!.signal.aborted, j3!.signal.aborted, r.ctx().signal.aborted, j1!.cancelled]).toEqual([false, false, false, false]);
    await expect(r.ctx().complete(j2!, 1)).rejects.toBeInstanceOf(JobCancelledError);
    r.g.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.seen.filter(([e]) => e === 'leaseLost')).toEqual([]);
  });

  it('batch-cancel: siblings keep running and complete after one task is cancelled', async () => {
    const r = await running();
    await r.s.q.cancel('j2');
    await vi.advanceTimersByTimeAsync(1000);
    r.g.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.seen.sort()).toEqual([['completed', 'j1'], ['completed', 'j3']]);
  });

  it('batch-cancel: settlement of a cancelled task is discarded without event or failure', async () => {
    const r = await running();
    const j2 = r.jobs()[1]!;
    await r.s.q.cancel('j2');
    r.g.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(writesFor(r.s, 'j2', j2.token)).toEqual([]);
    expect(r.seen.filter(([, id]) => id === 'j2')).toEqual([]);
    expect((await r.s.q.getJob('j2'))!.state).toBe('cancelled');
  });

  it('batch-cancel: handler throw fails unsettled siblings but not the cancelled task', async () => {
    const r = await running({
      result: () => {
        throw new Error('x');
      },
    });
    await r.s.q.cancel('j2');
    r.g.open();
    await vi.advanceTimersByTimeAsync(100);
    const states = await Promise.all(ids(3).map(async (id) => (await r.s.q.getJob(id))!));
    expect(states.map((j) => j.state)).toEqual(['delayed', 'cancelled', 'delayed']);
    expect([states[0]!.attempt, states[2]!.attempt]).toEqual([1, 1]);
  });

  it('batch-cancel: cancelled event fires once and counts move active to cancelled once', async () => {
    const r = await running();
    const cancelled = vi.fn();
    r.s.q.on('cancelled', cancelled);
    const before = await r.s.q.getCounts();
    await r.s.q.cancel('j2');
    r.g.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(cancelled).toHaveBeenCalledTimes(1);
    const after = await r.s.q.getCounts();
    expect([before.active, before.cancelled]).toEqual([3, 0]);
    expect([after.active, after.cancelled, after.completed]).toEqual([0, 1, 2]);
  });

  it('batch-cancel: cancel racing complete leaves exactly one outcome', async () => {
    const s = batchSetup();
    const raced = ids(50, 'r');
    for (const id of raced) {
      await s.q.add({}, { id });
      await s.q.add({}, { id: `${id}-x` });
    }
    const results = new Map<string, unknown>();
    s.run({ batchSize: 2 }, async ({ jobs }, ctx) => {
      const [first] = jobs;
      const [cancel] = await Promise.all([s.q.cancel(first!.id), ctx.complete(first!, 'done').catch(() => {})]);
      results.set(first!.id, cancel);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(results.size).toBe(50);
    for (const [id, cancel] of results) {
      const state = (await s.q.getJob(id))!.state;
      expect(['completed', 'cancelled']).toContain(state);
      expect((cancel as { cancelled: boolean; reason?: string }).reason === 'already-terminal', id).toBe(state === 'completed');
    }
  });

  it('batch-cancel: batch with all tasks cancelled never delivers or ends cleanly', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(2));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    for (const id of ids(2)) await s.q.cancel(id);
    await expect(w.batch.flush()).resolves.toBe(0);
    expect(s.calls).toEqual([]);

    await closeBatchQueues();
    const t = batchSetup({ queue: { timeoutGrace: '1s' } });
    await addAll(t.q, ids(2));
    let ctx!: BatchContext;
    t.run({ batchSize: 2 }, async (_b, c) => {
      ctx = c;
      if (t.calls.length === 1) await new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(100);
    for (const id of ids(2)) await t.q.cancel(id);
    expect(ctx.signal.reason).toBeInstanceOf(JobCancelledError);
    await t.q.add({}, { id: 'j3' });
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(t.calls.map((c) => c.ids)).toEqual([ids(2), ['j3']]);
  });

  it('batch-cancel: cancelled is not counted as a crash', async () => {
    const r = await running();
    await r.s.q.cancel('j2');
    r.h.clock.advance(60_000);
    const swept = await r.h.raw.sweep(r.s.scope, SWEEP);
    expect(swept.swept.map((j) => j.id)).not.toContain('j2');
    expect(await r.h.raw.get(r.s.scope, 'j2')).toMatchObject({ state: 'cancelled', crashCount: 0 });
    r.g.open();
  });
});
