import { hostname } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, StoreUnavailableError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import type { Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { StoreOp } from '../../src/store/types.js';
import { next, silent } from '../helpers/harness.js';
import { killClaim, live, twoPods } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';
import { claimReq } from '../helpers/store.js';

const failingUntilLast = (job: { attempt: number; maxAttempts: number }) => {
  if (job.attempt < job.maxAttempts) throw new TypeError(`n${job.attempt}`);
};

describe('attempt history', () => {
  it('history: three failing attempts produce three records with three errors', async () => {
    const q = new Queue('h3', { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 } });
    const w = q.process((job) => {
      throw new TypeError(`n${job.attempt}`);
    }, poll(5));
    const failed = next(w, 'failed');
    const { job } = await q.add(1, { maxAttempts: 3 });
    await failed;
    const rows = await (await q.getJob(job.id))!.getAttempts();
    expect(rows.map((r) => [r.attempt, r.outcome, r.endedBy, r.error?.message])).toEqual([
      [1, 'failed', 'worker', 'n1'], [2, 'failed', 'worker', 'n2'], [3, 'failed', 'worker', 'n3'],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ jobId: job.id, host: hostname(), workerId: w.id, cycle: 0, error: { name: 'TypeError' } });
      expect(r.durationMs).toBe(r.finishedAt! - r.startedAt);
    }
    expect(new Set(rows.map((r) => r.token)).size).toBe(3);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'attempt', 'batchId', 'cycle', 'durationMs', 'endedBy', 'error', 'finishedAt', 'heldMs', 'host', 'jobId', 'outcome', 'startedAt', 'token',
      'waitMs', 'workerId',
    ]);
    await q.close();
  });

  it('history: cap drops the oldest closed record and reports truncated', async () => {
    const q = new Queue('cap', { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 }, history: { maxRecordsPerJob: 2 } });
    const w = q.process((job) => failingUntilLast(job), poll(5));
    const completed = next(w, 'completed');
    const { job } = await q.add(1, { maxAttempts: 4 });
    await completed;
    const page = await q.getAttempts(job.id);
    expect(page.attempts.map((r) => [r.attempt, r.outcome])).toEqual([[3, 'failed'], [4, 'completed']]);
    expect([page.truncated, page.nextCursor]).toEqual([2, null]);
    await q.close();
  });

  it('history: false writes nothing but metrics still record timing', async () => {
    const spy = spyStore(new MemoryStore());
    const q = new Queue('off', { store: spy.store, logger: silent, history: false });
    const w = q.process(() => 'ok', poll(5));
    const completed = next(w, 'completed');
    const { job } = await q.add(1);
    await completed;
    expect(await q.getAttempts(job.id)).toEqual({ attempts: [], truncated: 0, nextCursor: null });
    const writes = spy.calls.filter((c) => c.op === 'claim' || c.op === 'complete');
    expect(writes.map((c) => c.op)).toEqual(expect.arrayContaining(['claim', 'complete']));
    for (const c of writes) expect((c.args[1] as { history?: unknown }).history, c.op).toBe(false);
    const { samples } = await q.metrics();
    const count = (name: string) => samples.filter((s) => s.name === name).reduce((n, s) => n + ('count' in s ? s.count : 0), 0);
    expect(count('sureq_job_wait_seconds')).toBe(1);
    expect(count('sureq_job_processing_seconds')).toBe(1);
    await q.close();
  });

  const crashRun = (cap: number | undefined) => async () => {
    const w = twoPods({ name: 'crash', queue: { maxCrashes: 5, ...(cap !== undefined && { history: { maxRecordsPerJob: cap } }) } });
    try {
      const { job } = await w.a.add({}, { name: 'work' });
      w.b.process({ other: () => {} }, live);
      const dead: string[] = [];
      for (let i = 0; i < 2; i++) {
        dead.push((await killClaim(w.store, 'crash', { names: ['work'] })).workerId!);
        w.clock.t += 30_001;
        await vi.advanceTimersByTimeAsync(600);
      }
      w.b.process({ work: () => 'done' }, live);
      await vi.advanceTimersByTimeAsync(200);
      const rec = (await w.a.getJob(job.id))!;
      expect(rec).toMatchObject({ state: 'completed', attempt: 3, crashCount: 2 });
      const page = await w.a.getAttempts(job.id);
      if (cap === undefined) {
        const crashed = page.attempts.filter((r) => r.outcome === 'crashed' && r.cycle === 0);
        expect(page.truncated).toBe(0);
        expect(crashed).toHaveLength(rec.crashCount);
        expect(crashed.map((r) => [r.endedBy, r.error?.name, r.error?.props?.['workerId']])).toEqual(dead.map((d) => ['sweeper', 'LeaseExpired', d]));
        for (const r of crashed) expect(r.error?.props?.['lastRenewAt']).toBe(r.startedAt);
        expect(page.attempts.map((r) => r.outcome)).toEqual(['crashed', 'crashed', 'completed']);
      } else {
        expect(page.truncated).toBe(2);
        expect(page.attempts.map((r) => [r.attempt, r.outcome])).toEqual([[3, 'completed']]);
      }
    } finally {
      await w.teardown();
    }
  };
  it('history: crashCount equals crashed records in the current cycle while nothing was truncated', crashRun(undefined));
  it('history: cap never changes crashCount or attempt', crashRun(1));

  it('history: refunded attempt does not collide with the next claim of the same attempt number', async () => {
    const store = new MemoryStore();
    const q = new Queue('refund', { store, logger: silent, shutdownTimeout: 0, shutdownAbortGrace: 0 });
    const first = q.process((_job, ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))), poll(5));
    const started = next(first, 'active');
    const { job } = await q.add(1);
    await started;
    await first.close();
    expect((await q.getJob(job.id))!.attempt).toBe(0);
    const completed = next(q.process(() => 'ok', poll(5)), 'completed');
    await completed;
    const rows = await (await q.getJob(job.id))!.getAttempts();
    expect(rows.map((r) => [r.attempt, r.outcome, r.endedBy])).toEqual([[1, 'released', 'shutdown'], [1, 'completed', 'worker']]);
    expect(rows[0]!.token).toBeLessThan(rows[1]!.token);
    await q.close();
  });

  it('history: closing an attempt with no open record inserts one instead of failing', async () => {
    const store = new MemoryStore();
    const q = new Queue('insert', { store, logger: silent });
    const scope: Scope = q.internals.scope;
    const { job } = await q.add(1);
    const [claimed] = (await store.claim(scope, { ...claimReq(), history: false })).jobs;
    expect((await q.getAttempts(job.id)).attempts).toEqual([]);
    expect(await store.complete(scope, { id: job.id, token: claimed!.token, result: null, history: { max: 50 } })).toMatchObject({ ok: true });
    const [row, ...rest] = (await q.getAttempts(job.id)).attempts;
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ outcome: 'completed', endedBy: 'worker', token: claimed!.token, startedAt: claimed!.startedAt, host: null });
    await q.close();
  });

  it('history: maxRecordsPerJob below 1 throws InvalidOptionError', () => {
    const issues = (history: unknown) => {
      try {
        new Queue('q', { history } as never);
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidOptionError);
        return (e as InvalidOptionError).issues;
      }
      throw new TypeError('no error');
    };
    expect(issues({ maxRecordsPerJob: 0 })).toMatchObject([{ path: 'history.maxRecordsPerJob', code: 'out_of_range' }]);
    expect(issues({ maxRecordsPerJob: 1.5 })).toMatchObject([{ path: 'history.maxRecordsPerJob', code: 'invalid_type' }]);
    expect(issues({ maxRecordPerJob: 5 })).toMatchObject([{ path: 'history.maxRecordPerJob', code: 'unknown_option', suggestion: 'maxRecordsPerJob' }]);
    expect(issues('yes')).toMatchObject([{ path: 'history', code: 'invalid_type' }]);
    expect(new Queue('q', { history: { maxRecordsPerJob: 1 } }).internals.history).toEqual({ max: 1 });
    expect(new Queue('q', { history: true }).internals.history).toEqual({ max: 50 });
    expect(new Queue('q').internals.history).toEqual({ max: 50 });
  });

  it('history: job and active state never disagree under injected store faults', async () => {
    const counts = new Map<StoreOp, number>();
    const violations: string[] = [];
    // the hooks run only once the store exists, so they can read it
    const store: MemoryStore = new MemoryStore({ faults: { before: (op) => fault('before')(op), after: (op) => fault('after')(op) } });
    const check = () => {
      const { jobs, attempts } = store.dump();
      for (const rec of jobs) {
        const open = attempts.some((r) => r.jobId === rec.id && r.outcome === 'running' && r.token === rec.token);
        const running = attempts.filter((r) => r.jobId === rec.id && r.outcome === 'running');
        if ((rec.state === 'active') !== open || running.length > (open ? 1 : 0)) violations.push(`${rec.id} ${rec.state} ${JSON.stringify(running)}`);
      }
    };
    const fault = (phase: 'before' | 'after') => (op: StoreOp) => {
      check();
      if (op !== 'claim' && op !== 'complete') return;
      const n = (counts.get(op) ?? 0) + (phase === 'before' ? 1 : 0);
      counts.set(op, n);
      // every third call fails, alternately before and after its write
      if (n % 3 === 0 && (n % 2 === 0) === (phase === 'after')) {
        throw new StoreUnavailableError('injected', { operation: op, retryable: true, outcomeUnknown: true });
      }
    };
    const q = new Queue('faults', { store, logger: silent, reconnect: { initialDelay: 1, maxDelay: 5, jitter: 0 } });
    q.on('error', () => {});
    const ids = (await q.addBulk(Array.from({ length: 30 }, (_, i) => ({ data: i })))).map((r) => (r.ok ? r.job.id : ''));
    q.process(() => 'ok', { ...poll(2), concurrency: 3 });
    await vi.waitFor(async () => expect((await q.getCounts()).completed, JSON.stringify([...counts], null, 0) + JSON.stringify(await q.getCounts())).toBe(30), { timeout: 10_000, interval: 20 });
    check();
    expect(violations).toEqual([]);
    expect([...counts.values()].every((n) => n >= 3)).toBe(true);
    for (const id of ids) expect((await q.getAttempts(id)).attempts.at(-1)?.outcome).toBe('completed');
    await q.close();
  }, 20_000);

  /** A job that fails both of its attempts, then is redriven (`resetAttempts` as given) and completes. */
  async function redrivenOnce(name: string, resetAttempts: boolean) {
    const q = new Queue(name, { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 } });
    const w = q.process((job) => {
      if (job.redriveCount === 0) throw new TypeError(`n${job.attempt}`);
    }, poll(5));
    const dead = next(w, 'deadLettered');
    const { job } = await q.add(1, { maxAttempts: 2 });
    await dead;
    const completed = next(w, 'completed');
    expect(await q.redrive(job.id, { resetAttempts })).toMatchObject({ status: 'redriven', state: 'waiting' });
    await completed;
    const rows = await (await q.getJob(job.id))!.getAttempts();
    await q.close();
    return rows.map((r) => [r.attempt, r.cycle, r.outcome]);
  }

  it('history: redrive starts cycle 1 and keeps cycle 0 records', async () => {
    expect(await redrivenOnce('cycle', true)).toEqual([[1, 0, 'failed'], [2, 0, 'failed'], [1, 1, 'completed']]);
  });

  it('history: cycle starts at the redrive even with resetAttempts false', async () => {
    expect(await redrivenOnce('cycle-keep', false)).toEqual([[1, 0, 'failed'], [2, 0, 'failed'], [3, 1, 'completed']]);
  });

  it('history: getAttempts refuses a limit or cursor out of range', async () => {
    const q = new Queue('bad-page', { store: new MemoryStore(), logger: silent });
    for (const opts of [{ limit: 0 }, { limit: 1001 }, { cursor: 'x' }, { cursor: '-1' }, { cursor: '9999999999999999' }]) {
      await expect(q.getAttempts('a', opts), JSON.stringify(opts)).rejects.toBeInstanceOf(InvalidOptionError);
    }
    await q.close();
  });
});
