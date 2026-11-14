import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShutdownError } from '../../src/errors/catalog.js';
import type { ReleaseRequest } from '../../src/store/contract.js';
import type { BatchContext, BatchJob } from '../../src/worker/batch.js';
import { addAll, batchSetup, closeBatchQueues, gate, ids, steady } from '../helpers/batch.js';
import { silent } from '../helpers/harness.js';
import { Pod } from '../helpers/pods.js';

afterEach(closeBatchQueues);

const SWEEP = { limit: 10, maxCrashes: 3, failError: '{}', poisonError: '{}' };

/** Pod A (killable) holding or running a batch over a shared store; pod B is a plain queue on the same store. */
async function crashWorld(o: { gated?: boolean } = {}) {
  const s = batchSetup();
  const store = s.inner;
  const a = new Pod(store, 'b', { logger: silent, leaseDuration: '3s' });
  const g = gate();
  const calls: string[][] = [];
  await addAll(s.q, ids(3));
  a.queue.processBatch(async (batch) => {
    calls.push(batch.jobs.map((j) => j.id));
    await g.p;
  }, { ...steady, batchSize: 5, batchDelay: o.gated ? 0 : '1h' });
  await vi.advanceTimersByTimeAsync(100);
  const teardown = async () => {
    a.view.unfreeze();
    g.open();
    await a.queue.close({ timeoutMs: 100 });
  };
  return { s, store, a, calls, teardown };
}

describe('batch shutdown, pause and crashes', () => {
  it('batch: shutdown flush runs the held batch within shutdownTimeout', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    const completed = vi.fn();
    w.on('completed', completed);
    await vi.advanceTimersByTimeAsync(100);
    const closed = vi.fn();
    void w.close({ timeoutMs: 5000 }).then(closed);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.calls.map((c) => c.ids)).toEqual([ids(3)]);
    expect(completed).toHaveBeenCalledTimes(3);
    expect(closed).toHaveBeenCalled();
  });

  it('batch: shutdown release returns held jobs claimable without consuming an attempt', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5, batchDelay: '1h', onShutdown: 'release' });
    await vi.advanceTimersByTimeAsync(100);
    await w.close();
    const releases = s.ops('release').map((c) => c.args[1] as ReleaseRequest);
    expect(releases.map((r) => [r.id, r.refundAttempt, r.handlerStarted, r.reason])).toEqual(ids(3).map((id) => [id, true, false, 'shutdown']));
    for (const id of ids(3)) expect(await s.q.getJob(id)).toMatchObject({ state: 'waiting', attempt: 0 });
    expect(s.calls).toEqual([]);
    const next = s.run({ batchSize: 5 });
    const attempts: number[] = [];
    next.on('active', ({ job }) => void attempts.push(job.attempt));
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toEqual([1, 1, 1]);
  });

  it('batch: pause stops claims while held jobs still close by their timers', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(2));
    const w = s.run({ batchSize: 5, batchDelay: '300ms' });
    await vi.advanceTimersByTimeAsync(100);
    await w.pause();
    const claims = s.ops('claim').length;
    await s.q.add({}, { id: 'j3' });
    await vi.advanceTimersByTimeAsync(250);
    expect(s.calls.map((c) => c.ids)).toEqual([ids(2)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.ops('claim')).toHaveLength(claims);
  });

  it('batch: flush while paused delivers the held jobs', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(2));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    await w.pause();
    await expect(w.batch.flush()).resolves.toBe(2);
    expect(s.calls.map((c) => c.ids)).toEqual([ids(2)]);
  });

  it('batch: shutdown after the timeout releases only unsettled jobs of a running batch', async () => {
    const s = batchSetup({ queue: { shutdownAbortGrace: 500 } });
    await addAll(s.q, ids(3));
    let ctx!: BatchContext;
    let jobs: readonly BatchJob[] = [];
    const w = s.run({ batchSize: 3 }, async (batch, c) => {
      ctx = c;
      jobs = batch.jobs;
      await c.complete(batch.jobs[0]!, 'early');
      await new Promise(() => {});
    });
    w.on('error', () => {});
    await vi.advanceTimersByTimeAsync(100);
    void w.close({ timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.signal.reason).toBeInstanceOf(ShutdownError);
    expect(jobs.map((j) => j.signal.aborted)).toEqual([false, false, false]);
    expect(s.ops('release')).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    const releases = s.ops('release').map((c) => c.args[1] as ReleaseRequest);
    expect(releases.map((r) => [r.id, r.refundAttempt, r.handlerStarted])).toEqual([['j2', true, true], ['j3', true, true]]);
    expect((await s.q.getJob('j1'))!.state).toBe('completed');
    for (const id of ['j2', 'j3']) expect(await s.q.getJob(id)).toMatchObject({ state: 'waiting', attempt: 0 });
  });

  it('batch: pod crash while holding jobs reclaims all of them via sweeper without crashCount or attempt used', async () => {
    const c = await crashWorld();
    expect(c.calls).toEqual([]);
    c.a.kill();
    await vi.advanceTimersByTimeAsync(3100);
    const swept = await c.store.sweep(c.s.scope, SWEEP);
    expect(swept.swept.map((j) => [j.id, j.action, j.crashCount])).toEqual(ids(3).map((id) => [id, 'requeued', 0]));
    for (const id of ids(3)) expect(await c.s.q.getJob(id)).toMatchObject({ state: 'waiting', attempt: 0, crashCount: 0 });
    const done: Array<[string, number]> = [];
    c.s.run({ batchSize: 5 }).on('completed', ({ job }) => void done.push([job.id, job.attempt]));
    await vi.advanceTimersByTimeAsync(100);
    expect(done.sort()).toEqual(ids(3).map((id) => [id, 1]));
    await c.teardown();
  });

  it('batch: pod crash after the handler started counts crashCount per job', async () => {
    const c = await crashWorld({ gated: true });
    expect(c.calls).toEqual([ids(3)]);
    c.a.kill();
    await vi.advanceTimersByTimeAsync(3100);
    await c.store.sweep(c.s.scope, SWEEP);
    for (const id of ids(3)) expect(await c.s.q.getJob(id)).toMatchObject({ state: 'waiting', attempt: 1, crashCount: 1 });
    await c.teardown();
  });

  it('batch: a close timeout while the started renews are out releases the jobs unrun', async () => {
    const g = gate();
    const s = batchSetup({
      over: (inner) => ({
        renew: async (scope, req) => {
          if (req.started) await g.p;
          return inner.renew(scope, req);
        },
      }),
    });
    await addAll(s.q, ids(2));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    const closed = w.close({ timeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    g.open();
    await vi.advanceTimersByTimeAsync(100);
    await closed;
    expect(s.calls).toEqual([]);
    const releases = s.ops('release').map((c) => c.args[1] as ReleaseRequest);
    expect(releases.map((r) => [r.id, r.refundAttempt, r.handlerStarted, r.reason])).toEqual(ids(2).map((id) => [id, true, false, 'shutdown']));
    for (const id of ids(2)) expect(await s.q.getJob(id)).toMatchObject({ state: 'waiting', attempt: 0, crashCount: 0, lease: null });
  });

  it('batch: after the shutdown abort an early settle is refused and nothing is written', async () => {
    const s = batchSetup({ queue: { shutdownAbortGrace: 500 } });
    await addAll(s.q, ids(2));
    let late: unknown;
    const w = s.run({ batchSize: 2 }, async (batch, ctx) => {
      await new Promise((r) => ctx.signal.addEventListener('abort', r));
      late = await ctx.complete(batch.jobs[0]!, 'late').catch((e: unknown) => e);
    });
    await vi.advanceTimersByTimeAsync(100);
    void w.close({ timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1600);
    expect(late).toBeInstanceOf(ShutdownError);
    expect(s.ops('complete')).toEqual([]);
    for (const id of ids(2)) expect(await s.q.getJob(id)).toMatchObject({ state: 'waiting', attempt: 0 });
  });
});
