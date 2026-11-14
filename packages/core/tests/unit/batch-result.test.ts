import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlreadySettledError, InvalidOptionError, JobTimeoutError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { ClaimRequest, CompleteRequest, RenewRequest } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { TaskFailure, type BatchContext, type BatchJob } from '../../src/worker/batch.js';
import type { BatchWorker } from '../../src/worker/worker.js';
import { addAll, batchSetup, closeBatchQueues, gate, ids } from '../helpers/batch.js';
import { harness } from '../helpers/harness.js';

afterEach(closeBatchQueues);

const events = (w: BatchWorker) => {
  const seen: Array<[string, string]> = [];
  for (const e of ['completed', 'failed', 'retrying', 'leaseLost'] as const) {
    w.on(e, (p) => void seen.push([e, (p as { job: { id: string } }).job.id]));
  }
  return seen;
};
const state = async (s: ReturnType<typeof batchSetup>, id: string) => (await s.q.getJob(id))!;

describe('per-task batch results', () => {
  it('batch-result: array return settles each job with its own result', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    s.run({ batchSize: 5 }, async () => ['a', 'b', 'c']);
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all(ids(3).map(async (id) => (await state(s, id)).result))).toEqual(['a', 'b', 'c']);
  });

  it('batch-result: TaskFailure fails only that job and siblings complete', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3), { maxAttempts: 3 });
    const w = s.run({ batchSize: 5 }, async () => [1, new TaskFailure(new Error('x')), 3]);
    const seen = events(w);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.sort()).toEqual([['completed', 'j1'], ['completed', 'j3'], ['retrying', 'j2']]);
  });

  it('batch-result: TaskFailure with retry false skips remaining attempts', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3), { maxAttempts: 3 });
    const w = s.run({ batchSize: 5 }, async () => [1, new TaskFailure(new Error('x'), { retry: false }), 3]);
    const failed = vi.fn();
    w.on('failed', failed);
    await vi.advanceTimersByTimeAsync(100);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]![0]).toMatchObject({ job: { id: 'j2', state: 'failed', attempt: 1 }, reason: 'unrecoverable' });
  });

  it('batch-result: thrown error fails all unsettled jobs separately with own retry counts', async () => {
    const s = batchSetup();
    for (const [i, maxAttempts] of [1, 2, 3].entries()) await s.q.add({}, { id: `j${i + 1}`, maxAttempts });
    const w = s.run({ batchSize: 5 }, async () => {
      throw new Error('boom');
    });
    const seen = events(w);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.sort()).toEqual([['failed', 'j1'], ['retrying', 'j2'], ['retrying', 'j3']]);
    for (const id of ids(3)) expect((await state(s, id)).attempt).toBe(1);
  });

  it('batch-result: jobs settled before a throw keep their outcome', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    s.run({ batchSize: 5 }, async (batch, ctx) => {
      await ctx.complete(batch.jobs[0]!, 'ok');
      await ctx.fail(batch.jobs[1]!, new Error('own'), { retry: false });
      throw new Error('boom');
    });
    await vi.advanceTimersByTimeAsync(100);
    const [j1, j2, j3] = await Promise.all(ids(3).map((id) => state(s, id)));
    expect([j1!.state, j1!.result]).toEqual(['completed', 'ok']);
    expect([j2!.state, j2!.error?.message]).toEqual(['failed', 'own']);
    expect([j3!.state, j3!.error?.message]).toEqual(['delayed', 'boom']);
  });

  it('batch-result: ctx.complete and ctx.fail settle early and commit immediately', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const g = gate();
    let early: string | undefined;
    s.run({ batchSize: 5 }, async (batch, ctx) => {
      await ctx.complete(batch.jobs[0]!, 1);
      await ctx.fail(batch.jobs[1]!, new Error('x'), { retry: false });
      early = (await s.q.getJob('j1'))!.state + '/' + (await s.q.getJob('j2'))!.state;
      await g.p;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(early).toBe('completed/failed');
    expect(s.ops('complete').map((c) => (c.args[1] as CompleteRequest).id)).toEqual(['j1']);
    g.open();
    await vi.advanceTimersByTimeAsync(100);
    expect((await state(s, 'j3')).state).toBe('completed');
  });

  it('batch-result: wrong-length array raises BatchResultMismatchError and fails all unsettled', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(6));
    const values: unknown[] = [[1, 2], {}];
    const w = s.run({ batchSize: 3 }, async () => values.shift() as never);
    const seen = events(w);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.sort()).toEqual(ids(6).map((id) => ['retrying', id]));
    expect(s.ops('complete')).toEqual([]);
    for (const [i, id] of ids(6).entries()) {
      expect((await state(s, id)).error).toMatchObject({ code: 'BATCH_RESULT_MISMATCH', props: { expected: 3, got: i < 3 ? 2 : 1 } });
    }
  });

  it('batch-result: a job settled early no longer counts as active in health', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const g = gate();
    const w = s.run({ batchSize: 5 }, async (batch, ctx) => {
      await ctx.complete(batch.jobs[0]!, 1);
      await g.p;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(w.healthSnapshot().activeJobs).toBe(2);
    g.open();
  });

  it('batch-result: second ctx.complete or ctx.fail throws AlreadySettledError and keeps the first', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(2));
    const errors: unknown[] = [];
    s.run({ batchSize: 5 }, async ({ jobs: [a, b] }, ctx) => {
      await ctx.complete(a!, 1);
      errors.push(await ctx.complete(a!, 2).catch((e: unknown) => e));
      errors.push(await ctx.fail(a!, new Error('x')).catch((e: unknown) => e));
      await ctx.fail(b!, new Error('y'), { retry: false });
      errors.push(await ctx.complete(b!, 3).catch((e: unknown) => e));
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(errors.map((e) => e instanceof AlreadySettledError && e.jobId)).toEqual(['j1', 'j1', 'j2']);
    expect([(await state(s, 'j1')).result, (await state(s, 'j2')).state]).toEqual([1, 'failed']);
  });

  it('batch-result: array element for an already settled job is silently ignored', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5 }, async (batch, ctx) => {
      await ctx.fail(batch.jobs[0]!, new Error('x'));
      return ['late', 'b', 'c'];
    });
    const errors = vi.fn();
    w.on('error', errors);
    await vi.advanceTimersByTimeAsync(100);
    expect((await state(s, 'j1')).state).toBe('delayed');
    expect(s.ops('complete').map((c) => (c.args[1] as CompleteRequest).id).sort()).toEqual(['j2', 'j3']);
    expect(errors).not.toHaveBeenCalled();
  });

  it('batch-result: transient settle failure is retried with the same token and a repeat returns the original outcome', async () => {
    let completes = 0;
    const inner = new MemoryStore({
      clock: () => Date.now(),
      faults: {
        after(op) {
          if (op === 'complete' && ++completes === 2) throw new StoreUnavailableError('lost answer', { operation: 'complete', retryable: true, outcomeUnknown: true });
        },
      },
    });
    const s = batchSetup({ inner });
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5 }, async () => ['a', 'b', 'c']);
    w.on('error', () => {});
    const completed = vi.fn();
    w.on('completed', completed);
    await vi.advanceTimersByTimeAsync(2000);
    const calls = s.ops('complete');
    const reqs = calls.map((c) => c.args[1] as CompleteRequest);
    expect(reqs.map((r) => r.id)).toEqual(['j1', 'j2', 'j3', 'j2']);
    expect(reqs[3]!.token).toBe(reqs[1]!.token);
    expect(calls[2]!.at).toBeLessThan(calls[3]!.at);
    expect(completed).toHaveBeenCalledTimes(3);
    expect((await state(s, 'j2')).state).toBe('completed');
  });

  it("batch-result: per-job retry uses that job's attempt, backoff and retryIf", async () => {
    const s = batchSetup();
    for (const n of [1, 2, 3]) await s.q.add({ n }, { id: `j${n}`, backoff: { type: 'fixed', delay: n * 1000 } });
    const w = s.run({ batchSize: 5, retryIf: (_e, job) => (job.data as { n: number }).n !== 2 }, async () => {
      throw new Error('x');
    });
    const retrying = vi.fn();
    w.on('retrying', retrying);
    await vi.advanceTimersByTimeAsync(100);
    expect(retrying.mock.calls.map(([p]) => [p.job.id, p.delayMs])).toEqual([['j1', 1000], ['j3', 3000]]);
    expect((await state(s, 'j2')).state).toBe('failed');

    const t = batchSetup();
    await addAll(t.q, ids(2));
    const v = t.run({ batchSize: 5, retryIf: (_e, job) => {
      if (job.id === 'j1') throw new Error('bad rule');
      return true;
    } }, async () => {
      throw new Error('x');
    });
    const errors = vi.fn();
    v.on('error', errors);
    await vi.advanceTimersByTimeAsync(100);
    // A throwing retryIf retries that job (and reports it), as for a single job; its sibling is untouched.
    expect([(await state(t, 'j1')).state, (await state(t, 'j2')).state]).toEqual(['delayed', 'delayed']);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]![0]).toMatchObject({ error: { code: 'RETRY_IF_ERROR' } });
  });

  it('batch-result: oversized result fails only that job', async () => {
    const s = batchSetup({ queue: { maxResultBytes: 100 } });
    await addAll(s.q, ids(3));
    s.run({ batchSize: 5 }, async () => ['a', 'x'.repeat(200), 'c']);
    await vi.advanceTimersByTimeAsync(100);
    const jobs = await Promise.all(ids(3).map((id) => state(s, id)));
    expect(jobs.map((j) => j.state)).toEqual(['completed', 'failed', 'completed']);
    expect(jobs[1]!.error?.code).toBe('RESULT_TOO_LARGE');
  });

  it('batch-result: stale token on one job discards it and commits the siblings', async () => {
    const h = harness();
    const s = batchSetup({ inner: h.raw });
    await addAll(s.q, ids(3));
    const g = gate();
    let jobs: readonly BatchJob[] = [];
    const w = s.run({ batchSize: 5 }, async (batch) => {
      jobs = batch.jobs;
      await g.p;
      return ['a', 'b', 'c'];
    });
    const seen = events(w);
    await vi.advanceTimersByTimeAsync(100);
    h.clock.advance(20_000);
    for (const j of [jobs[0]!, jobs[2]!]) await h.raw.renew(s.scope, { id: j.id, token: j.token, leaseMs: 30_000 });
    h.clock.advance(11_000);
    await h.raw.sweep(s.scope, { limit: 10, maxCrashes: 3, failError: '{}', poisonError: '{}' });
    const [again] = (await h.raw.claim(s.scope, { workerId: 'other', limit: 1, leaseMs: 30_000, claimId: 'c' })).jobs;
    g.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.sort()).toEqual([['completed', 'j1'], ['completed', 'j3'], ['leaseLost', 'j2']]);
    expect(await h.raw.get(s.scope, 'j2')).toMatchObject({ state: 'active', token: again!.token, lease: { owner: 'other' } });
    expect(s.logger.warn).toHaveBeenCalledWith('batch task outcome discarded', expect.objectContaining({ jobId: 'j2' }));
  });

  it('batch-result: events and counts update per job', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(5));
    const counts: number[] = [];
    const w = s.run({ batchSize: 5 }, async () => [1, new TaskFailure(new Error('x')), 3, new TaskFailure(new Error('y')), 5]);
    const seen = events(w);
    w.on('completed', async () => void counts.push((await s.q.getCounts()).completed));
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.filter(([e]) => e === 'completed')).toHaveLength(3);
    expect(seen.filter(([e]) => e === 'retrying')).toHaveLength(2);
    expect(await s.q.getCounts()).toMatchObject({ completed: 3, delayed: 2, active: 0 });
    expect(counts.length).toBe(3);
  });

  it('batch-result: timeout fails unsettled jobs individually after grace', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    let ctx!: BatchContext;
    s.run({ batchSize: 5, timeout: '1s', timeoutGrace: '500ms' }, async (batch, c) => {
      ctx = c;
      setTimeout(() => void c.complete(batch.jobs[0]!, 'early'), 200);
      await new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.signal.reason).toBeInstanceOf(JobTimeoutError);
    expect((await state(s, 'j2')).state).toBe('active');
    await vi.advanceTimersByTimeAsync(500);
    const jobs = await Promise.all(ids(3).map((id) => state(s, id)));
    expect(jobs.map((j) => j.state)).toEqual(['completed', 'delayed', 'delayed']);
    for (const [i, id] of ['j2', 'j3'].entries()) {
      expect(jobs[i + 1]!.error).toMatchObject({ code: 'JOB_TIMEOUT', props: { jobId: id, abandoned: true } });
    }
  });

  it('batch-result: settling a job from another batch throws InvalidOptionError', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(2));
    let first: BatchJob | undefined;
    let err: unknown;
    s.run({ batchSize: 2 }, async (batch, ctx) => {
      if (!first) {
        first = batch.jobs[0];
        await s.q.add({}, { id: 'j3' });
        return;
      }
      err = await ctx.complete(first, 1).catch((e: unknown) => e);
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(err).toBeInstanceOf(InvalidOptionError);
    expect((err as InvalidOptionError).issues[0]!.path).toBe('job');
  });
});

describe('batch id on the started renew', () => {
  it('batch: the started renew of every job carries the batch id and later renews do not', async () => {
    const s = batchSetup({ queue: { leaseDuration: '3s' } });
    await addAll(s.q, ids(2));
    let batchId: string | undefined;
    const g = gate();
    const w = s.run({ batchSize: 5, batchDelay: '1h' }, async (batch) => {
      batchId = batch.id;
      await g.p;
    });
    await vi.advanceTimersByTimeAsync(2000);
    await w.batch.flush();
    await vi.advanceTimersByTimeAsync(2500);
    const renews = s.ops('renew').map((c) => c.args[1] as RenewRequest);
    expect(renews.filter((r) => r.started).map((r) => [r.id, r.batchId])).toEqual(ids(2).map((id) => [id, batchId]));
    expect(renews.filter((r) => !r.started).every((r) => r.batchId === undefined)).toBe(true);
    expect(renews.filter((r) => !r.started).length).toBeGreaterThanOrEqual(6);
    g.open();
  });
});

describe('attempt history of batches', () => {
  it('batch: attempt history records batchId and heldMs', async () => {
    const s = batchSetup({ queue: { defaultJobOptions: { backoff: 0 } } });
    await addAll(s.q, ids(3), { maxAttempts: 2 });
    const batches: string[] = [];
    s.run({ batchSize: 5, batchDelay: '2s' }, async (batch) => {
      batches.push(batch.id);
      return batch.jobs.map((j) => (j.id === 'j2' && j.attempt === 1 ? new TaskFailure(new Error('again')) : 'ok'));
    });
    await vi.advanceTimersByTimeAsync(2100);
    expect(batches).toHaveLength(1);
    for (const id of ['j1', 'j3']) {
      const { attempts } = await s.q.getAttempts(id);
      expect(attempts.map((r) => [r.outcome, r.batchId])).toEqual([['completed', batches[0]]]);
      expect(attempts[0]!.heldMs).toBeGreaterThanOrEqual(1900);
      expect(attempts[0]!.heldMs).toBeLessThanOrEqual(2100);
    }
    await vi.advanceTimersByTimeAsync(2100);
    expect(batches).toHaveLength(2);
    const { attempts } = await s.q.getAttempts('j2');
    expect(attempts.map((r) => [r.attempt, r.outcome, r.batchId])).toEqual([[1, 'failed', batches[0]], [2, 'completed', batches[1]]]);
    expect(batches[1]).not.toBe(batches[0]);
    // the batch claim carries the same format bound and history ext as a single-job claim
    const claim = s.ops('claim')[0]!.args[1] as ClaimRequest;
    expect(claim).toMatchObject({ hold: true, maxFormat: s.q.internals.client.__formatSupport.maxReadable, history: { host: s.q.internals.host } });
  });

  it('batch: a job failing its last attempt is dead-lettered, and a redrive runs it in a new batch with its history kept', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(2), { maxAttempts: 1 });
    const batches: string[] = [];
    const w = s.run({ batchSize: 5 }, async (batch) => {
      batches.push(batch.id);
      return batch.jobs.map((j) => (j.id === 'j2' && batches.length === 1 ? new TaskFailure(new Error('last')) : 'ok'));
    });
    const dead = vi.fn();
    w.on('deadLettered', dead);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.ops('fail').map((c) => c.args[1])).toEqual([expect.objectContaining({ id: 'j2', deadLetter: { reason: 'exhausted' } })]);
    expect(dead).toHaveBeenCalledTimes(1);
    expect(dead.mock.calls[0]![0]).toMatchObject({ job: { id: 'j2', deadLetter: { reason: 'exhausted' } }, reason: 'exhausted' });
    expect(await s.q.redrive('j2')).toEqual({ id: 'j2', status: 'redriven', state: 'waiting', viaDeadLetter: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(batches).toHaveLength(2);
    expect((await state(s, 'j2')).state).toBe('completed');
    const { attempts } = await s.q.getAttempts('j2');
    expect(attempts.map((r) => [r.cycle, r.outcome, r.batchId, typeof r.heldMs])).toEqual([
      [0, 'failed', batches[0], 'number'], [1, 'completed', batches[1], 'number'],
    ]);
  });

  it('batch-result: attempt history has one record per job with shared batchId', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    let batchId = '';
    const w = s.run({ batchSize: 3 }, async (batch) => {
      batchId = batch.id;
    });
    await vi.advanceTimersByTimeAsync(100);
    const rows = (await Promise.all(ids(3).map((id) => s.q.getAttempts(id)))).map((p) => p.attempts);
    expect(rows.map((r) => r.length)).toEqual([1, 1, 1]);
    expect(rows.map((r) => [r[0]!.jobId, r[0]!.batchId, r[0]!.outcome, r[0]!.workerId])).toEqual(ids(3).map((id) => [id, batchId, 'completed', w.id]));
    expect(new Set(rows.map((r) => r[0]!.token)).size).toBe(3);
  });

  it('history: batch jobs each get their own record', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    s.run({ batchSize: 3 }, async (batch, ctx) => {
      await ctx.fail(batch.jobs[1]!, new Error('one'), { retry: false });
    });
    await vi.advanceTimersByTimeAsync(100);
    const rows = await Promise.all(ids(3).map(async (id) => (await s.q.getJob(id))!.getAttempts()));
    expect(rows.map((r) => r.map((x) => [x.jobId, x.attempt, x.outcome]))).toEqual([[['j1', 1, 'completed']], [['j2', 1, 'failed']], [['j3', 1, 'completed']]]);
    expect(rows[1]![0]!.error?.message).toBe('one');
    expect(new Set(rows.map((r) => r[0]!.batchId)).size).toBe(1);
    expect(new Set(rows.map((r) => r[0]!.token)).size).toBe(3);
  });

  it('batch: a held job swept after its pod died closes its attempt as released', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(1));
    const res = await s.inner.claim(s.scope, { workerId: 'dead', limit: 1, leaseMs: 1000, claimId: 'c1', hold: true });
    const token = res.jobs[0]!.token;
    s.run({ batchSize: 2, batchDelay: 0, sweepInterval: 500 });
    await vi.advanceTimersByTimeAsync(3000);
    const { attempts } = await s.q.getAttempts('j1');
    expect(attempts.map((r) => [r.token === token, r.outcome, r.endedBy])).toEqual([[true, 'released', 'sweeper'], [false, 'completed', 'worker']]);
    expect((await s.q.getJob('j1'))!).toMatchObject({ state: 'completed', crashCount: 0, attempt: 1 });
  });
});
