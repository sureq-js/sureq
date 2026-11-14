import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { MAX_PAGES_PER_POLICY, RetentionCleaner, runRetentionPass } from '../../src/retention/cleaner.js';
import type { Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { harness, next, silent } from '../helpers/harness.js';
import { live } from '../helpers/pods.js';
import { spyStore } from '../helpers/spy-store.js';

const DAY = 86_400_000;
const pass = async (q: Queue): Promise<number> => (await runRetentionPass({ client: q.internals.client, scope: q.internals.scope, retention: q.internals.retention })).removed;
const counts = async (q: Queue) => q.getCounts();

/** Run every job through workers that fail jobs named `bad` and return `'r'` otherwise (unnamed jobs, and `named` too); resolves once `done` holds, with the workers closed. */
async function work(q: Queue, done: (c: Awaited<ReturnType<typeof counts>>) => boolean, named: string[] = []): Promise<void> {
  const handler = async (job: Job) => {
    if (job.name === 'bad') throw new Error('boom');
    return 'r';
  };
  const opts = { ...live, concurrency: 50 };
  const workers = [q.process(handler, opts), ...(named.length > 0 ? [q.process(Object.fromEntries(named.map((n) => [n, handler])), opts)] : [])];
  for (let i = 0; i < 200 && !done(await counts(q)); i++) await vi.advanceTimersByTimeAsync(50);
  await Promise.all(workers.map((w) => w.close()));
  expect(done(await counts(q))).toBe(true);
}

/** A second queue object on the same store, as another pod would have. */
const pod = (store: Store, opts: QueueOptions = {}) => new Queue('h', { logger: silent, ...opts, store });

describe('retention', () => {
  beforeEach(() => useFakeTime());
  afterEach(() => vi.useRealTimers());

  it('retention: dead letters and jobs inside the result grace are never removed', async () => {
    const h = harness({ queue: { retention: { completed: { count: 2 } } } });
    const q = h.queue;
    const grace: string[] = [];
    for (let i = 0; i < 5; i++) grace.push((await q.add(i, { keep: { completed: 0 } })).job.id);
    for (let i = 0; i < 5; i++) await q.add(i);
    for (let i = 0; i < 2; i++) await q.add(i, { name: 'bad', maxAttempts: 1 });
    await work(q, (c) => c.completed === 10 && c.failed === 2, ['bad']);
    await pass(q);
    expect((await counts(q)).completed).toBe(10);
    for (const id of grace) expect((await q.getJob(id))?.result).toBe('r');
    expect(await q.countDeadLetters()).toBe(2);
    h.clock.advance(30_000);
    await pass(q);
    for (const id of grace) expect(await q.getJob(id)).toBeNull();
    expect(await counts(q)).toMatchObject({ completed: 2, failed: 2 });
    h.clock.advance(30 * DAY);
    await pass(q);
    expect(await q.countDeadLetters()).toBe(2);
    await q.close();
  });

  it('retention: a keep-none record is readable through the grace and its closed attempt goes with it', async () => {
    const h = harness();
    const { job } = await h.queue.add(1, { keep: { completed: 0 } });
    await work(h.queue, (c) => c.completed === 1);
    expect((await h.queue.getAttempts(job.id)).attempts.map((a) => a.outcome)).toEqual(['completed']);
    h.clock.advance(29_999);
    await pass(h.queue);
    expect((await h.queue.getJob(job.id))?.result).toBe('r');
    h.clock.advance(1);
    await pass(h.queue);
    expect(await h.queue.getJob(job.id)).toBeNull();
    expect((await h.queue.getAttempts(job.id)).attempts).toEqual([]);
    await h.queue.close();
  });

  it('retention: a pass is capped, continues on the next tick, never delays the sweep and stops for close', async () => {
    const inner = new MemoryStore();
    let started = 0;
    const { store, calls } = spyStore(inner, {
      // each clean takes 50 ms, so an uncapped pass over the backlog would hold the tick for seconds
      clean: async (s, r) => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return inner.clean(s, r);
      },
    });
    const q = new Queue('q', { logger: silent, store, retention: { completed: true, pageSize: 10 } });
    await q.ready();
    const scope = q.internals.scope;
    await inner.add(scope, Array.from({ length: 2000 }, (_, i) => ({ id: `j${i}`, data: '1', formatVersion: 1, maxAttempts: 1 })));
    for (let round = 0; round < 2; round++) {
      const { jobs } = await inner.claim(scope, { workerId: 'w', limit: 1000, leaseMs: 60_000, claimId: `c${round}` });
      for (const j of jobs) await inner.complete(scope, { id: j.id, token: j.token, result: null, retention: { retainMs: 0 } });
    }
    const w = q.process(async () => 'r', { ...live, sweepInterval: '5s', acknowledgeVolatileStore: true });
    const of = (op: string) => calls.filter((c) => c.op === op);
    const ageCalls = () => of('clean').filter((c) => (c.args[1] as { state: string }).state === 'completed').length;
    await vi.advanceTimersByTimeAsync(5_000 + 20 * 50);
    expect(ageCalls()).toBe(MAX_PAGES_PER_POLICY);
    // the next tick goes on with the backlog without waiting for the interval, and the sweep after a capped pass is on time
    await vi.advanceTimersByTimeAsync(5_000 + 20 * 50);
    expect(ageCalls()).toBe(2 * MAX_PAGES_PER_POLICY);
    const sweeps = of('sweep').map((c) => c.at);
    expect(sweeps[1]! - sweeps[0]!).toBeLessThanOrEqual(5_000 + 20 * 50);
    // a close in the middle of a pass ends it after the page in flight
    const mid = started + 3;
    while (started < mid) await vi.advanceTimersByTimeAsync(10);
    let closed = false;
    const closing = w.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(closed).toBe(true);
    await closing;
    expect(ageCalls()).toBe(2 * MAX_PAGES_PER_POLICY + 3);
    await q.close();
  });

  it('retention: keep none with resultGrace 0 fires completed event with removed true', async () => {
    const h = harness({ queue: { retention: { completed: 0, resultGrace: 0 } } });
    const completed = next<{ job: Job; result: unknown; removed?: boolean }>(h.queue, 'completed');
    const { job } = await h.queue.add(1);
    await work(h.queue, (c) => c.active === 0 && c.waiting === 0);
    const e = await completed;
    expect([e.removed, e.result, e.job.result, e.job.state]).toEqual([true, 'r', 'r', 'completed']);
    expect(await h.queue.getJob(job.id)).toBeNull();
    await h.queue.close();
  });

  it('retention: policy is resolved at finish from the stored per-job keep', async () => {
    const h = harness();
    const { job } = await h.queue.add(1, { keep: { completed: '1h' } });
    const worker = pod(h.raw, { retention: { completed: 0 } });
    await work(worker, (c) => c.completed === 1);
    const done = (await worker.getJob(job.id))!;
    expect(done.retainUntil).toBe(done.finishedAt! + 3_600_000);
    await Promise.all([h.queue.close(), worker.close()]);
  });

  it('retention: count policy is per name for byName entries', async () => {
    const h = harness({ queue: { retention: { completed: { count: 1 }, byName: { a: { completed: { count: 3 } } } } } });
    for (let i = 0; i < 4; i++) await h.queue.add(i, { name: 'a' });
    for (let i = 0; i < 4; i++) await h.queue.add(i);
    await work(h.queue, (c) => c.completed === 8, ['a']);
    h.clock.advance(30_000);
    await pass(h.queue);
    const left = await h.queue.getJobs('completed', { limit: 10 });
    expect(left.map((j) => j.name).sort()).toEqual(['a', 'a', 'a', null]);
    await h.queue.close();
  });

  it('retention: retained id is free after retention removes the job', async () => {
    const h = harness({ queue: { uniqueWhile: 'retained', retention: { retainedAge: '1m' } } });
    await h.queue.add(1, { id: 'x' });
    await work(h.queue, (c) => c.completed === 1);
    expect((await h.queue.add(2, { id: 'x' })).added).toBe(false);
    expect((await h.queue.getJob('x'))!.retainUntil).toBe((await h.queue.getJob('x'))!.finishedAt! + 60_000);
    h.clock.advance(60_000);
    await pass(h.queue);
    expect((await h.queue.add(3, { id: 'x' })).added).toBe(true);
    await h.queue.close();
  });

  it('retention: several pods running the pass delete each job once without error', async () => {
    const h = harness();
    await h.queue.ready();
    const scope: Scope = h.queue.internals.scope;
    await h.raw.add(scope, Array.from({ length: 100 }, (_, i) => ({ id: `j${i}`, data: '1', formatVersion: 1, maxAttempts: 1 })));
    const { jobs } = await h.raw.claim(scope, { workerId: 'w', limit: 100, leaseMs: 60_000, claimId: 'c' });
    for (const j of jobs) await h.raw.complete(scope, { id: j.id, token: j.token, result: null, retention: { retainMs: 1000 } });
    h.clock.advance(1000);
    const opts = { retention: { completed: true, pageSize: 7 } } as const;
    const pods = [pod(h.raw, opts), pod(h.raw, opts)];
    const errors: unknown[] = [];
    for (const p of pods) p.on('error', (e) => void errors.push(e));
    let removed = 0;
    for (let round = 0; round < 5; round++) for (const n of await Promise.all(pods.map(pass))) removed += n;
    expect(removed).toBe(100);
    expect(errors).toEqual([]);
    expect((await counts(pods[0]!)).completed).toBe(0);
    await Promise.all([h.queue.close(), ...pods.map((p) => p.close())]);
  });

  it('retention: changing count applies to existing jobs, changing age does not', async () => {
    const h = harness({ queue: { retention: { completed: { count: 10, age: '1h' } } } });
    for (let i = 0; i < 5; i++) await h.queue.add(i);
    await work(h.queue, (c) => c.completed === 5);
    const b = pod(h.raw, { retention: { completed: { count: 2, age: '1m' } } });
    h.clock.advance(30_000);
    await pass(b);
    const left = await b.getJobs('completed', { limit: 10 });
    expect(left).toHaveLength(2);
    for (const j of left) expect(j.retainUntil).toBe(j.finishedAt! + 3_600_000);
    await Promise.all([h.queue.close(), b.close()]);
  });

  it('retention: cancel applies the cancelled policy', async () => {
    const h = harness();
    const { job } = await h.queue.add(1);
    await h.queue.cancel(job.id);
    const cancelled = (await h.queue.getJob(job.id))!;
    expect(cancelled.retainUntil).toBe(cancelled.finishedAt! + 14 * DAY);
    const none = pod(h.raw, { retention: { cancelled: 0, resultGrace: 0 } });
    const other = await none.add(2);
    const event = next<{ job: Job }>(none, 'cancelled');
    const res = await none.cancel(other.job.id);
    expect(res).toMatchObject({ cancelled: true, previousState: 'waiting', job: { id: other.job.id, state: 'cancelled', finishedAt: h.clock.now } });
    expect((await event).job.id).toBe(other.job.id);
    expect(await none.getJob(other.job.id)).toBeNull();
    await Promise.all([h.queue.close(), none.close()]);
  });

  it('retention: a discarding cancel that succeeded resolves with a finish time read before the write', async () => {
    let after = false;
    const inner = new MemoryStore();
    const { store, calls } = spyStore(inner, {
      cancel: async (s, req) => ((after = true), inner.cancel(s, req)),
      now: async () => {
        if (after) throw new Error('store clock unreachable');
        return inner.now();
      },
    });
    const q = new Queue('q', { logger: silent, store, retention: { cancelled: 0, resultGrace: 0 } });
    const { job } = await q.add(1);
    const at = await inner.now();
    const res = await q.cancel(job.id);
    expect(res).toMatchObject({ cancelled: true, job: { id: job.id, state: 'cancelled', finishedAt: at } });
    const ops = calls.map((c) => c.op);
    expect(ops.slice(ops.lastIndexOf('cancel')).includes('now')).toBe(false);
    expect(await q.getJob(job.id)).toBeNull();
    await q.close();
  });

  it('retention: the sweeper runs a pass once per interval', async () => {
    const { store, calls } = spyStore(new MemoryStore());
    const q = new Queue('q', { logger: silent, store, retention: { interval: '60s' } });
    const w = q.process(async () => 'r', { ...live, sweepInterval: '5s', acknowledgeVolatileStore: true });
    const cleans = () => calls.filter((c) => c.op === 'clean').length;
    await vi.advanceTimersByTimeAsync(5_000);
    const first = cleans();
    expect(first).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(cleans()).toBe(first);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleans()).toBeGreaterThan(first);
    await w.close();
    await q.close();
  });

  it('retention: a failing pass is reported once per outage and retried on the next tick', async () => {
    let down = true;
    const inner = new MemoryStore();
    const { store } = spyStore(inner, { clean: (s, r) => (down ? Promise.reject(new Error('down')) : inner.clean(s, r)) });
    const q = new Queue('q', { logger: silent, store });
    await q.ready();
    const reports: unknown[] = [];
    const cleaner = new RetentionCleaner({ client: q.internals.client, scope: q.internals.scope, retention: q.internals.retention }, (e) => void reports.push(e));
    await cleaner.maybeRun(0);
    await cleaner.maybeRun(1);
    expect(reports).toHaveLength(1);
    down = false;
    await cleaner.maybeRun(2);
    await cleaner.maybeRun(3);
    down = true;
    await cleaner.maybeRun(60_002);
    expect(reports).toHaveLength(2);
    await q.close();
  });

  it('format: age-based retention removes a job finished by a previous-release pod via finishedAt', async () => {
    const h = harness({ queue: { retention: { completed: { count: 1 } } } });
    const scope: Scope = h.queue.internals.scope;
    await h.queue.ready();
    // the previous release writes no retention ext and no dead-letter field
    await h.raw.add(scope, ['c1', 'c2', 'x', 'd'].map((id) => ({ id, data: '1', formatVersion: 1, maxAttempts: 1 })));
    await h.raw.cancel(scope, { id: 'x' });
    const { jobs } = await h.raw.claim(scope, { workerId: 'old', limit: 3, leaseMs: 60_000, claimId: 'c' });
    for (const j of jobs) {
      if (j.id === 'd') await h.raw.fail(scope, { id: j.id, token: j.token, error: '{"v":1,"name":"E","message":"boom"}' });
      else await h.raw.complete(scope, { id: j.id, token: j.token, result: null });
    }
    expect((await h.queue.getJob('d'))!.deadLetter?.reason).toBe('legacy');
    h.clock.advance(14 * DAY);
    await pass(h.queue);
    expect(await h.queue.getJob('x')).toBeNull();
    expect((await counts(h.queue)).completed).toBe(1);
    expect(await h.queue.getJob('d')).not.toBeNull();
    await h.queue.close();
  });
});
