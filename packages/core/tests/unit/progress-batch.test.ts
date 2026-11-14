import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCancelledError, LeaseLostError } from '../../src/errors/catalog.js';
import type { CompleteRequest, SetProgressRequest } from '../../src/store/contract.js';
import type { BatchContext, BatchJob } from '../../src/worker/batch.js';
import { addAll, batchSetup, closeBatchQueues, gate, ids } from '../helpers/batch.js';
import { harness } from '../helpers/harness.js';

afterEach(closeBatchQueues);

const SWEEP = { limit: 10, maxCrashes: 3, failError: '{}', poisonError: '{}' };

/** Three jobs running in one gated batch on a store with a hand-driven clock; `staggered` claims them 400 ms apart. */
async function running(staggered = false) {
  const h = harness();
  const s = batchSetup({ inner: h.raw });
  const g = gate();
  let jobs: BatchJob[] = [];
  let ctx!: BatchContext;
  if (!staggered) await addAll(s.q, ids(3));
  s.run({ batchSize: 3, batchDelay: '1h', progressInterval: 0 }, async (batch, c) => {
    jobs = [...batch.jobs];
    ctx = c;
    await g.p;
  });
  for (const [i, id] of (staggered ? ids(3) : []).entries()) {
    if (i > 0) h.clock.advance(400);
    await addAll(s.q, [id]);
    await vi.advanceTimersByTimeAsync(100);
  }
  await vi.advanceTimersByTimeAsync(100);
  const writes = () => s.ops('setProgress').map((c) => c.args[1] as SetProgressRequest);
  const stored = async (id: string) => (await s.q.getJob(id))!;
  return { h, s, g, jobs: () => jobs, ctx: () => ctx, writes, stored };
}

describe('progress (batch)', () => {
  it('progress: ctx.batchProgress writes batchProgress to every job, ctx.progress(job) writes progress to one', async () => {
    const r = await running(true);
    const jobs = r.jobs();
    expect(jobs.map((j) => j.startedAt! - jobs[0]!.startedAt!)).toEqual([0, 400, 800]);
    r.h.clock.advance(200);
    await r.ctx().batchProgress(1, 3);
    const batchWrites = r.writes();
    expect(batchWrites).toHaveLength(3);
    expect(batchWrites.map((w) => [w.id, w.token, w.field])).toEqual(jobs.map((j) => [j.id, j.token, 'batchProgress']));
    await r.ctx().progress(jobs[1]!, 5, 10);
    const one = r.writes().slice(3);
    expect(one.map((w) => [w.id, w.field])).toEqual([[jobs[1]!.id, undefined]]);
    for (const j of jobs) {
      const got = await r.stored(j.id);
      // elapsed 1000 ms from the earliest start, so (3 - 1) / 1 * 1000 ms remain.
      expect(got.batchProgress, j.id).toMatchObject({ kind: 'counter', n: 1, total: 3, etaMs: 2_000 });
      if (j === jobs[1]) expect(got.progress).toMatchObject({ n: 5, total: 10 });
      else expect(got.progress).toBeNull();
    }
  });

  it('progress: ctx.batchProgress skips a lost job and still resolves for the others', async () => {
    const r = await running();
    const [j1, j2, j3] = r.jobs();
    // Another worker takes j1: the others' leases are renewed, then j1 expires, is swept and claimed elsewhere.
    r.h.clock.advance(20_000);
    for (const j of [j2!, j3!]) await r.h.raw.renew(r.s.scope, { id: j.id, token: j.token, leaseMs: 30_000 });
    r.h.clock.advance(11_000);
    await r.h.raw.sweep(r.s.scope, SWEEP);
    const again = (await r.h.raw.claim(r.s.scope, { workerId: 'other', limit: 1, leaseMs: 30_000, claimId: 'c' })).jobs[0]!;
    await expect(r.ctx().batchProgress(2, 3)).resolves.toBeUndefined();
    expect(j1!.signal.reason).toBeInstanceOf(LeaseLostError);
    expect([j2!.signal.aborted, j3!.signal.aborted]).toEqual([false, false]);
    for (const j of [j2!, j3!]) expect((await r.stored(j.id)).batchProgress).toMatchObject({ n: 2 });
    expect((await r.h.raw.get(r.s.scope, j1!.id))!).toMatchObject({ token: again.token, batchProgress: null });
    await expect(r.ctx().progress(j1!, 1)).rejects.toBeInstanceOf(LeaseLostError);
    // A cancelled job and a job settled early get no further batch write.
    await r.s.q.cancel(j3!.id);
    expect(j3!.signal.reason).toBeInstanceOf(JobCancelledError);
    await r.ctx().complete(j2!, 'r');
    const before = r.writes().length;
    await r.ctx().batchProgress(3, 3);
    expect(r.writes().length).toBe(before);
  });

  it('batch-result: ctx.progress(job) and ctx.batchProgress write the progress fields', async () => {
    const r = await running();
    const jobs = r.jobs();
    await r.ctx().progress(jobs[0]!, 3, 10);
    await r.ctx().batchProgress({ stage: 'x' });
    const first = await r.stored(jobs[0]!.id);
    expect(first.progress).toMatchObject({ kind: 'counter', n: 3, total: 10 });
    expect(first.batchProgress).toMatchObject({ kind: 'object', value: { stage: 'x' } });
    for (const j of jobs.slice(1)) {
      const got = await r.stored(j.id);
      expect(got.progress).toBeNull();
      expect(got.batchProgress).toMatchObject({ kind: 'object', value: { stage: 'x' } });
    }
    await expect(r.ctx().batchProgress('x' as never)).rejects.toMatchObject({ code: 'INVALID_OPTION', scope: 'ctx.batchProgress' });
  });

  it('progress: per-task progress is flushed before that task settles early', async () => {
    const h = harness();
    const s = batchSetup({ inner: h.raw });
    await addAll(s.q, ids(3));
    const g = gate();
    s.run({ batchSize: 3, progressInterval: '250ms' }, async (batch, ctx) => {
      const [j1] = batch.jobs;
      await ctx.progress(j1!, 1, 2);
      void ctx.progress(j1!, 2, 2);
      await ctx.complete(j1!, 'r');
      await g.p;
    });
    await vi.advanceTimersByTimeAsync(100);
    const forJ1 = s.spy.calls
      .filter((c) => (c.op === 'setProgress' || c.op === 'complete') && (c.args[1] as CompleteRequest).id === 'j1')
      .map((c) => (c.op === 'complete' ? 'complete' : `n${(JSON.parse((c.args[1] as SetProgressRequest).progress as string) as { n: number }).n}`));
    expect(forJ1).toEqual(['n1', 'n2', 'complete']);
    expect((await s.q.getJob('j1'))!).toMatchObject({ state: 'completed', progress: { n: 2, percent: 100 } });
    g.open();
  });
  it('progress: ctx.batchProgress on a batch whose jobs are all settled resolves with no writes', async () => {
    const r = await running();
    for (const j of r.jobs()) await r.ctx().complete(j, 'r');
    const before = r.writes().length;
    await expect(r.ctx().batchProgress(1, 3)).resolves.toBeUndefined();
    expect(r.writes()).toHaveLength(before);
    r.g.open();
  });

  it('progress: a batch close timeout with progress writes in flight fires no leaseLost and nothing after closed', async () => {
    const s = batchSetup({
      over: (inner) => ({
        setProgress: async (scope, req) => {
          await new Promise((res) => setTimeout(res, 300));
          return inner.setProgress(scope, req);
        },
      }),
    });
    await addAll(s.q, ids(2));
    const seen: string[] = [];
    for (const e of ['leaseLost', 'error', 'closed'] as const) s.q.on(e, () => void seen.push(e));
    let late: unknown;
    s.run({ batchSize: 2 }, async (batch, ctx) => {
      void ctx.batchProgress(1, 2);
      await new Promise((res) => ctx.signal.addEventListener('abort', res));
      late = await ctx.progress(batch.jobs[0]!, 2, 2).then(() => 'stored', (e: unknown) => e);
      await new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(100);
    const closing = s.q.close({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).not.toContain('leaseLost');
    expect(seen.slice(seen.indexOf('closed') + 1)).toEqual([]);
    expect(late).toMatchObject({ code: 'SHUTDOWN' });
    expect(s.ops('setProgress')).toHaveLength(2);
    expect(s.ops('release')).toHaveLength(2);
  });
  it('progress: a batch progress write that never answers does not hold back the releases at close', async () => {
    const s = batchSetup({ over: () => ({ setProgress: () => new Promise(() => {}) }) });
    await addAll(s.q, ids(2));
    const seen: string[] = [];
    for (const e of ['leaseLost', 'error', 'closed'] as const) s.q.on(e, () => void seen.push(e));
    s.run({ batchSize: 2 }, async (_batch, ctx) => {
      void ctx.batchProgress(1, 2);
      await new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(100);
    const t0 = Date.now();
    let closedAt = 0;
    const closing = s.q.close({ timeoutMs: 50 }).then(() => (closedAt = Date.now()));
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(closedAt - t0).toBeLessThanOrEqual(50 + 1_000);
    expect(s.ops('release').map((c) => c.at <= closedAt)).toEqual([true, true]);
    expect(seen.slice(seen.indexOf('closed') + 1)).toEqual([]);
    expect(seen).not.toContain('leaseLost');
    for (const id of ids(2)) expect((await s.inner.get(s.scope, id))!).toMatchObject({ state: 'waiting', lease: null });
  });
  it('progress: a batch progress write that never answers is dropped at the lease deadline and the jobs still complete', async () => {
    const s = batchSetup({ over: () => ({ setProgress: () => new Promise(() => {}) }), queue: { leaseDuration: '3s' } });
    await addAll(s.q, ids(2));
    const t0 = Date.now();
    s.run({ batchSize: 2 }, async (batch, ctx) => {
      void ctx.batchProgress(1, 2);
      void ctx.progress(batch.jobs[0]!, 1, 2).catch(() => {});
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const completes = s.ops('complete');
    expect(completes).toHaveLength(2);
    for (const c of completes) expect(c.at - t0).toBeLessThanOrEqual(3_000 + 100);
    for (const id of ids(2)) expect((await s.q.getJob(id))!.state).toBe('completed');
  });
});
