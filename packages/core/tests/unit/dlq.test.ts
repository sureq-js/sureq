import { describe, expect, it, vi } from 'vitest';
import { DuplicateJobError, InvalidJobStateError, InvalidOptionError, JobNotFoundError, UnrecoverableError } from '../../src/errors/catalog.js';
import type { QueueEvents } from '../../src/events/types.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import type { DeadLetterReason, FailRequest, RedriveOutcome, Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { failing } from '../helpers/faults.js';
import { collect, harness, next, silent } from '../helpers/harness.js';
import { killClaim, live, twoPods } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

type DeadLettered = QueueEvents<Job>['deadLettered'];
type Redriven = QueueEvents['redriven'];

/** `n` dead letters, written straight through the store: added, claimed in one call, each failed for good. */
async function deadLetters(q: Queue, store: Store, n: number, ext: FailRequest['deadLetter'] = {}): Promise<string[]> {
  const scope: Scope = q.internals.scope;
  const ids = (await q.addBulk(Array.from({ length: n }, (_, i) => ({ data: i, opts: { maxAttempts: 1 } })))).map((r) => (r.ok ? r.job.id : ''));
  const { jobs } = await store.claim(scope, { workerId: 'w', limit: n, leaseMs: 600_000, claimId: `c-${ids[0]}` });
  await Promise.all(jobs.map((j) => store.fail(scope, { id: j.id, token: j.token, error: '{"v":1,"name":"E","message":"boom"}', ...(ext !== undefined && { deadLetter: ext }) })));
  return ids;
}

/**
 * Four jobs that fail for good four ways: `u` throws UnrecoverableError, `r` is refused by `retryIf`, `e` fails
 * both its attempts (the first one retries), and `c` is claimed by a killed worker and swept at `maxCrashes: 1`.
 */
async function fourWays() {
  const w = twoPods({ name: 'ways', queue: { maxCrashes: 1, defaultJobOptions: { backoff: 0 } } });
  const order: string[] = [];
  w.a.on('failed', (e) => void order.push(`failed ${e.job.id}`));
  w.a.on('deadLettered', (e) => void order.push(`dead ${e.job.id}`));
  w.a.on('retrying', (e) => void order.push(`retrying ${e.job.id}`));
  const dead = collect<DeadLettered>(w.a, 'deadLettered', 4);
  const ids = {
    u: (await w.a.add({}, { name: 'u', maxAttempts: 5 })).job.id,
    r: (await w.a.add({}, { name: 'r', maxAttempts: 5 })).job.id,
    e: (await w.a.add({}, { name: 'e', maxAttempts: 2 })).job.id,
    c: (await w.a.add({}, { name: 'c', maxAttempts: 5 })).job.id,
  };
  await killClaim(w.store, 'ways', { names: ['c'] });
  w.clock.t += 30_001;
  const boom = () => {
    throw new TypeError('boom');
  };
  w.a.process({ u: () => Promise.reject(new UnrecoverableError('no')), e: boom }, live);
  w.a.process({ r: boom }, { ...live, retryIf: () => false });
  await vi.advanceTimersByTimeAsync(1000);
  return { ...w, ids, order, dead: await dead };
}

describe('dead-letter queue', () => {
  it('dlq: reason is unrecoverable for UnrecoverableError and retryRejected when retryIf says no', async () => {
    const w = await fourWays();
    try {
      const reasons: Record<string, DeadLetterReason | undefined> = {};
      for (const [k, id] of Object.entries(w.ids)) {
        const job = (await w.a.getJob(id))!;
        expect(job.state).toBe('failed');
        expect(job.deadLetter!.at).toBe(job.finishedAt);
        reasons[k] = job.deadLetter?.reason;
      }
      expect(reasons).toEqual({ u: 'unrecoverable', r: 'retryRejected', e: 'exhausted', c: 'crashLimit' });
      expect(await w.a.countDeadLetters()).toBe(4);
    } finally {
      await w.teardown();
    }
  });

  it('dlq: deadLettered event fires once per job', async () => {
    const w = await fourWays();
    try {
      expect(Object.fromEntries(w.dead.map((e) => [e.job.id, e.reason]))).toEqual({
        [w.ids.u]: 'unrecoverable', [w.ids.r]: 'retryRejected', [w.ids.e]: 'exhausted', [w.ids.c]: 'crashLimit',
      });
      for (const e of w.dead) expect(e.job.deadLetter?.reason).toBe(e.reason);
      await vi.advanceTimersByTimeAsync(2000);
      for (const id of Object.values(w.ids)) {
        const mine = w.order.filter((line) => line.endsWith(` ${id}`) && !line.startsWith('retrying'));
        expect(mine, id).toEqual([`failed ${id}`, `dead ${id}`]);
      }
      expect(w.order).toContain(`retrying ${w.ids.e}`);
    } finally {
      await w.teardown();
    }
  });

  it('dlq: deadLetter false leaves a plain failed job and job.retry still works', async () => {
    const spy = spyStore(new MemoryStore());
    const q = new Queue('plain', { store: spy.store, logger: silent, deadLetter: false });
    const dead = vi.fn();
    q.on('deadLettered', dead);
    let runs = 0;
    const w = q.process(() => {
      if (++runs === 1) throw new TypeError('first');
      return 'ok';
    }, poll(5));
    const failed = next<QueueEvents<Job>['failed']>(w, 'failed');
    const { job } = await q.add(1, { maxAttempts: 1 });
    await failed;
    const stored = (await q.getJob(job.id))!;
    expect([stored.state, stored.deadLetter]).toEqual(['failed', null]);
    expect(await q.getDeadLetters()).toEqual({ jobs: [], nextCursor: null });
    for (const c of spy.calls.filter((x) => x.op === 'fail')) expect((c.args[1] as FailRequest).deadLetter).toBe(false);
    const redriven = next<Redriven>(q, 'redriven');
    const completed = next(w, 'completed');
    expect(await stored.retry()).toEqual({ id: job.id, status: 'redriven', state: 'waiting', viaDeadLetter: false });
    expect(await redriven).toEqual({ id: job.id, state: 'waiting', viaDeadLetter: false });
    await completed;
    expect(runs).toBe(2);
    expect(dead).not.toHaveBeenCalled();
    await q.close();
  });

  it('dlq: job.retry on completed job throws InvalidJobStateError', async () => {
    const q = new Queue('retry-err', { store: new MemoryStore(), logger: silent });
    const completed = next(q.process(() => 'ok', poll(5)), 'completed');
    const { job } = await q.add(1);
    await completed;
    const done = (await q.getJob(job.id))!;
    const e = await done.retry().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidJobStateError);
    expect(e).toMatchObject({ jobId: job.id, state: 'completed' });
    expect(await q.remove(job.id)).toBe(true);
    await expect(done.retry()).rejects.toBeInstanceOf(JobNotFoundError);
    expect(await q.redrive('missing')).toEqual({ id: 'missing', status: 'skipped', reason: 'not-found' });
    await q.close();
    await expect(done.retry()).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
  });

  it('dlq: redriveAll pages, respects limit and is safe to re-run after a crash', async () => {
    const inner = new MemoryStore();
    const spy = spyStore(inner);
    const q = new Queue('bulk', { store: spy.store, logger: silent });
    await deadLetters(q, inner, 250);
    const events: Redriven[] = [];
    q.on('redriven', (e) => void events.push(e));
    expect(await q.redriveAll({}, { pageSize: 100, limit: 120 })).toEqual({ redriven: 120, skipped: 0, done: false, skippedIds: [] });
    expect(spy.calls.filter((c) => c.op === 'redrive').map((c) => (c.args[1] as { limit: number }).limit)).toEqual([100, 20]);
    expect(events).toHaveLength(120);
    expect(await q.countDeadLetters()).toBe(130);
    await q.close();

    // the second store call fails: the first page stays redriven, and a second run redrives the rest
    const store = new MemoryStore({ faults: failing((op, n) => (op === 'redrive' && n === 2 ? new TypeError('down') : undefined)) });
    const crash = new Queue('crash', { store, logger: silent });
    const ids = await deadLetters(crash, store, 250);
    await expect(crash.redriveAll()).rejects.toThrow();
    expect(await crash.countDeadLetters()).toBe(150);
    expect(await crash.redriveAll()).toEqual({ redriven: 150, skipped: 0, done: true, skippedIds: [] });
    expect(await crash.redriveAll()).toEqual({ redriven: 0, skipped: 0, done: true, skippedIds: [] });
    const jobs = await Promise.all(ids.map((id) => crash.getJob(id)));
    expect(jobs.every((j) => j!.state === 'waiting' && j!.redriveCount === 1)).toBe(true);
    await crash.close();
  });

  it('dlq: redrive(ids) returns outcomes in input order', async () => {
    const inner = new MemoryStore();
    const spy = spyStore(inner);
    const q = new Queue('order', { store: spy.store, logger: silent });
    const [a, c] = await deadLetters(q, inner, 2);
    expect(await q.redrive([c!, 'missing', a!, c!])).toEqual([
      { id: c, status: 'redriven', state: 'waiting', viaDeadLetter: true },
      { id: 'missing', status: 'skipped', reason: 'not-found' },
      { id: a, status: 'redriven', state: 'waiting', viaDeadLetter: true },
      { id: c, status: 'skipped', reason: 'not-failed' },
    ]);
    expect(await q.redrive([])).toEqual([]);
    spy.calls.length = 0;
    const many = Array.from({ length: 1001 }, (_, i) => `none-${i}`);
    expect((await q.redrive(many)).map((o) => o.id)).toEqual(many);
    expect(spy.calls.filter((x) => x.op === 'redrive').map((x) => (x.args[1] as { ids: string[] }).ids.length)).toEqual([1000, 1]);
    await q.close();
  });

  it('dlq: redriven job gets new history cycle and keeps old attempts', async () => {
    const q = new Queue('cycle', { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 } });
    const w = q.process((job) => {
      if (job.redriveCount === 0) throw new TypeError(`n${job.attempt}`);
      return 'ok';
    }, poll(5));
    const dead = next(w, 'deadLettered');
    const { job } = await q.add(1, { maxAttempts: 2 });
    await dead;
    const completed = next(w, 'completed');
    await q.redrive(job.id, { delay: 1, priority: 3 });
    await completed;
    const done = (await q.getJob(job.id))!;
    expect([done.state, done.redriveCount, done.lastError?.message, done.priority, done.attempt, done.deadLetter]).toEqual(['completed', 1, 'n2', 3, 1, null]);
    expect((await done.getAttempts()).map((r) => [r.cycle, r.attempt, r.outcome, r.error?.message ?? null])).toEqual([
      [0, 1, 'failed', 'n1'], [0, 2, 'failed', 'n2'], [1, 1, 'completed', null],
    ]);
    await q.close();
  });

  it('dlq: getDeadLetters filters by reason and olderThan and pages with cursor', async () => {
    const { raw, queue: q, clock } = harness();
    const scope = q.internals.scope;
    const ids: Record<string, string> = {};
    for (const [key, reason] of [['e0', 'exhausted'], ['e1', 'exhausted'], ['u', 'unrecoverable'], ['e2', 'exhausted'], ['e3', 'exhausted']] as const) {
      const { job } = await q.add(key, { maxAttempts: 1 });
      const [claimed] = (await raw.claim(scope, { workerId: 'w', limit: 1, leaseMs: 60_000, claimId: key })).jobs;
      await raw.fail(scope, { id: job.id, token: claimed!.token, error: '"e"', deadLetter: { reason } });
      ids[key] = job.id;
      clock.advance(1000);
    }
    // marked at 0 s to 4 s; now is 5.5 s
    clock.advance(500);
    const page1 = await q.getDeadLetters({ reason: 'exhausted', olderThan: '1s', limit: 2 });
    expect(page1.jobs.map((j) => j.id)).toEqual([ids['e0'], ids['e1']]);
    expect(page1.jobs[0]!.deadLetter).toEqual({ at: page1.jobs[0]!.finishedAt, reason: 'exhausted' });
    const page2 = await q.getDeadLetters({ reason: 'exhausted', olderThan: '1s', limit: 2, cursor: page1.nextCursor! });
    expect(page2.jobs.map((j) => j.id)).toEqual([ids['e2'], ids['e3']]);
    const page3 = await q.getDeadLetters({ reason: 'exhausted', olderThan: '1s', limit: 2, cursor: page2.nextCursor! });
    expect(page3).toEqual({ jobs: [], nextCursor: null });
    expect((await q.getDeadLetters({ olderThan: '2s' })).jobs.map((j) => j.id)).toEqual([ids['e0'], ids['e1'], ids['u'], ids['e2']]);
    expect([await q.countDeadLetters({ reason: 'exhausted' }), await q.countDeadLetters({ reason: 'unrecoverable' }), await q.countDeadLetters()]).toEqual([4, 1, 5]);
    await q.close();
  });

  it('dlq: redrive of a superseded dead letter throws DuplicateJobError', async () => {
    const inner = new MemoryStore();
    const q = new Queue('dup', { store: inner, logger: silent });
    const scope = q.internals.scope;
    const { job } = await q.add(1, { id: 'x', maxAttempts: 1 });
    const [claimed] = (await inner.claim(scope, { workerId: 'w', limit: 1, leaseMs: 60_000, claimId: 'c' })).jobs;
    await inner.fail(scope, { id: 'x', token: claimed!.token, error: '"e"', deadLetter: {} });
    expect((await q.add(2, { id: 'x' })).added).toBe(true);
    const old = `x#${job.seq}`;
    const e = await q.redrive(old).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DuplicateJobError);
    expect(e).toMatchObject({ jobId: old, existingState: 'waiting', by: 'id', reason: 'superseded' });
    expect(await q.redrive([old])).toEqual([{ id: old, status: 'skipped', reason: 'duplicate-id' }]);
    // it is a dead letter still: read, counted, passed by redriveAll, removed by its history key
    expect((await q.getDeadLetters()).jobs.map((j) => j.id)).toEqual([old]);
    expect(await q.countDeadLetters()).toBe(1);
    expect(await q.redriveAll()).toEqual({ redriven: 0, skipped: 0, done: true, skippedIds: [] });
    expect((await q.getJob('x'))!.data).toBe(2);
    expect(await q.remove(old)).toBe(true);
    expect(await q.countDeadLetters()).toBe(0);
    await q.close();
  });

  it('dlq: redriveAll reaches live dead letters behind a full page of superseded ones', async () => {
    const inner = new MemoryStore();
    const q = new Queue('pages', { store: inner, logger: silent });
    const scope = q.internals.scope;
    const failOne = async (id: string): Promise<void> => {
      const [c] = (await inner.claim(scope, { workerId: 'w', limit: 1, leaseMs: 60_000, claimId: id })).jobs;
      await inner.fail(scope, { id: c!.id, token: c!.token, error: '"e"', deadLetter: {} });
    };
    for (const id of ['a', 'b']) {
      await q.add(1, { id, maxAttempts: 1 });
      await failOne(id);
      await q.add(2, { id });
      await q.remove(id);
    }
    await q.add(3, { id: 'live', maxAttempts: 1 });
    await failOne('live');
    expect(await q.countDeadLetters()).toBe(3);
    expect(await q.redriveAll({}, { pageSize: 2 })).toEqual({ redriven: 1, skipped: 0, done: true, skippedIds: [] });
    expect((await q.getJob('live'))!.state).toBe('waiting');
    await q.close();
  });

  it('dlq: job.retry on a snapshot whose id was reused throws DuplicateJobError and leaves the new job alone', async () => {
    const q = new Queue('stale', { store: new MemoryStore(), logger: silent });
    const w = q.process(() => Promise.reject(new TypeError('boom')), poll(5));
    const first = next<QueueEvents<Job>['failed']>(w, 'failed');
    await q.add(1, { id: 'x', maxAttempts: 1 });
    const snapshot = (await first).job;
    const second = next<QueueEvents<Job>['failed']>(w, 'failed');
    expect((await q.add(2, { id: 'x', maxAttempts: 1 })).added).toBe(true);
    await second;
    const before = (await q.getJob('x'))!;
    expect(before.seq).not.toBe(snapshot.seq);
    const e = await snapshot.retry().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DuplicateJobError);
    expect(e).toMatchObject({ jobId: `x#${snapshot.seq}`, reason: 'superseded' });
    expect(await q.getJob('x')).toMatchObject({ state: 'failed', seq: before.seq, redriveCount: 0 });
    await q.close();
  });

  it('dlq: redriveAll counts only redriven jobs toward limit', async () => {
    let first = true;
    const spy = spyStore(new MemoryStore(), {
      redrive: async (_s, req) => {
        const out = Array.from({ length: req.limit }, (_, i): RedriveOutcome => ({ id: `j${i}`, status: 'redriven', state: 'waiting', viaDeadLetter: true }));
        if (first) for (let i = 0; i < 5; i++) out[i] = { id: `s${i}`, status: 'skipped', reason: 'not-failed' };
        first = false;
        return out;
      },
    });
    const q = new Queue('limit', { store: spy.store, logger: silent });
    expect(await q.redriveAll({}, { pageSize: 20, limit: 40 })).toEqual({
      redriven: 40, skipped: 5, done: false, skippedIds: ['s0', 's1', 's2', 's3', 's4'],
    });
    expect(spy.calls.filter((c) => c.op === 'redrive').map((c) => (c.args[1] as { limit: number }).limit)).toEqual([20, 20, 5]);
    await q.close();
  });

  it('dlq: redriveAll stops on a full page that moved nothing', async () => {
    const spy = spyStore(new MemoryStore(), {
      redrive: async (_s, req) => Array.from({ length: req.limit }, (_, i): RedriveOutcome => ({ id: `s${i}`, status: 'skipped', reason: 'not-failed' })),
    });
    const q = new Queue('stuck', { store: spy.store, logger: silent });
    const summary = await q.redriveAll({}, { pageSize: 10 });
    expect([summary.redriven, summary.skipped, summary.done]).toEqual([0, 10, false]);
    expect(spy.calls.filter((c) => c.op === 'redrive')).toHaveLength(1);
    await q.close();
  });

  it('dlq: invalid redrive and deadLetter options throw InvalidOptionError', async () => {
    const q = new Queue('bad', { store: new MemoryStore(), logger: silent });
    const issue = async (p: Promise<unknown>) => {
      const e = await p.then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(InvalidOptionError);
      return (e as InvalidOptionError).issues[0]!;
    };
    expect((await issue(q.getDeadLetters({ limit: 0 }))).path).toBe('limit');
    expect((await issue(q.getDeadLetters({ limit: 1001 }))).path).toBe('limit');
    expect((await issue(q.getDeadLetters({ cursor: 'next' }))).path).toBe('cursor');
    expect((await issue(q.getDeadLetters({ reason: 'oops' as never }))).path).toBe('reason');
    expect((await issue(q.redriveAll({}, { pageSize: 0 }))).path).toBe('pageSize');
    expect((await issue(q.redriveAll({}, { limit: 0 }))).path).toBe('limit');
    expect((await issue(q.redrive('a', { delay: -1 }))).path).toBe('delay');
    expect((await issue(q.redrive('a', { priorty: 1 } as never))).suggestion).toBe('priority');
    expect((await issue(q.redrive(5 as never))).path).toBe('id');
    expect((await issue(q.countDeadLetters({ reason: 'x' as never }))).path).toBe('reason');
    const ctor = (deadLetter: unknown) => issue(Promise.resolve().then(() => new Queue('q', { deadLetter } as never)));
    expect((await ctor({ warnAbove: -1 })).path).toBe('deadLetter.warnAbove');
    expect((await ctor({ warnAbove: 1.5 })).path).toBe('deadLetter.warnAbove');
    expect(await ctor({ warnAbov: 1 })).toMatchObject({ path: 'deadLetter.warnAbov', suggestion: 'warnAbove' });
    expect((await ctor('yes')).path).toBe('deadLetter');
    for (const [given, resolved] of [
      [undefined, { enabled: true, warnAbove: 10_000 }], [true, { enabled: true, warnAbove: 10_000 }], [false, { enabled: false, warnAbove: false }],
      [{ warnAbove: false }, { enabled: true, warnAbove: false }], [{ warnAbove: 0 }, { enabled: true, warnAbove: 0 }],
    ] as const) {
      const ok = new Queue('q', { logger: silent, ...(given !== undefined && { deadLetter: given }) });
      expect(ok.internals.deadLetter, JSON.stringify(given)).toEqual(resolved);
      await ok.close();
    }
    await q.close();
  });

  it('format: a failed job written by a previous-release pod is a legacy dead letter and redrive works', async () => {
    const store = new MemoryStore();
    const q = new Queue('legacy', { store, logger: silent });
    const scope = q.internals.scope;
    const { job } = await q.add({ n: 1 }, { maxAttempts: 1 });
    // The previous pod speaks the store protocol with its own request shapes: its final fail has no deadLetter field.
    const [claimed] = (await store.claim(scope, { workerId: 'previous', limit: 1, leaseMs: 30_000, claimId: 'p1' })).jobs;
    await store.fail(scope, { id: job.id, token: claimed!.token, error: '{"v":1,"name":"E","message":"old"}' });
    const failed = (await q.getJob(job.id))!;
    expect(failed.deadLetter).toEqual({ at: failed.finishedAt, reason: 'legacy' });
    expect((await q.getDeadLetters({ reason: 'legacy' })).jobs.map((j) => j.id)).toEqual([job.id]);
    expect(await q.redrive(job.id)).toEqual({ id: job.id, status: 'redriven', state: 'waiting', viaDeadLetter: true });
    const completed = next(q.process(() => 'done', poll(5)), 'completed');
    await completed;
    expect((await q.getJob(job.id))!.state).toBe('completed');
    await q.close();
  });
});
