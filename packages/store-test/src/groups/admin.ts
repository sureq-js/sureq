import assert from 'node:assert/strict';
import type { CleanRequest, JobCounts, Scope } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, fireJob, get, obliterateAll, oneJob, rejectsRequest, scheduleInput, sweepReq, ZERO_COUNTS } from './util.js';

const clean = (env: TestEnv, s: Scope, req: CleanRequest) => env.store.clean(s, req);

/** Add one job, claim it and complete it. */
async function completed(env: TestEnv, s: Scope): Promise<string> {
  const { job, token } = await claimed(env, s);
  assert.ok((await env.store.complete(s, { id: job.id, token, result: null })).ok);
  return job.id;
}

const without = (c: JobCounts, ...states: Array<keyof JobCounts>): Partial<JobCounts> =>
  Object.fromEntries(Object.entries(c).filter(([k]) => !states.includes(k as keyof JobCounts)));

const hasCode = (code: string) => (e: unknown): boolean => (e as { code?: unknown } | null)?.code === code;
const rejectsMarked = (p: Promise<unknown>, what: string): Promise<void> => assert.rejects(p, hasCode('QUEUE_OBLITERATING'), what);

export const adminGroup: ConformanceGroup = {
  name: 'admin',
  mode: 'fake',
  register(t) {
    t.test('admin: clean removes only jobs of the state older than the cutoff by store time', async (env) => {
      const s = env.scope();
      const a = await completed(env, s);
      await env.elapse(5000);
      const b = await completed(env, s);
      await env.addJobs(s, 1, { delayMs: 600_000 });
      const before = await env.store.counts(s);
      await env.skewPodClock(3_600_000, async () => {
        assert.deepEqual(await clean(env, s, { state: 'completed', olderThanMs: 3000, limit: 100 }), { removed: 1, remaining: false });
      });
      assert.equal(await env.store.get(s, a), null);
      await get(env, s, b);
      const [w1] = await env.addJobs(s, 1);
      await env.elapse(2000);
      const [w2] = await env.addJobs(s, 1);
      assert.deepEqual(await clean(env, s, { state: 'waiting', olderThanMs: 1000, limit: 100 }), { removed: 1, remaining: false });
      assert.equal(await env.store.get(s, w1!.id), null);
      await get(env, s, w2!.id);
      assert.deepEqual(await clean(env, s, { state: 'completed', olderThanMs: 0, limit: 100 }), { removed: 1, remaining: false });
      assert.equal(await env.store.get(s, b), null);
      const after = await env.store.counts(s);
      assert.deepEqual(without(after, 'completed', 'waiting'), without(before, 'completed', 'waiting'), 'other states are never touched');
      assert.deepEqual([after.completed, after.waiting], [0, 1]);
    });

    t.race('admin: clean skips a job that changed state between listing and delete', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 20);
      const [a, b] = await env.pods(2);
      const [cleaned, claimedRes] = await Promise.all([
        a!.clean(s, { state: 'waiting', limit: 20 }),
        b!.claim(s, { workerId: 'w', limit: 20, leaseMs: env.leaseMs, claimId: 'c' }),
      ]);
      assert.equal(cleaned.removed + claimedRes.jobs.length, 20, 'each job is removed or claimed, never both');
      for (const job of claimedRes.jobs) assert.equal((await get(env, s, job.id)).state, 'active');
      assert.equal((await env.store.counts(s)).waiting, 0);
    });

    t.test('admin: clean removes attempt history with the job', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      assert.ok((await env.store.complete(s, { id: job.id, token, result: null })).ok);
      assert.deepEqual(await clean(env, s, { state: 'completed', limit: 10 }), { removed: 1, remaining: false });
      assert.deepEqual((await env.store.getAttempts(s, { id: job.id })).attempts, []);
      await env.store.add(s, [env.job({ id: job.id })]);
      const again = oneJob(await env.claim(s));
      assert.ok((await env.store.complete(s, { id: job.id, token: again.token, result: null })).ok);
      const rows = (await env.store.getAttempts(s, { id: job.id })).attempts;
      assert.deepEqual(rows.map((r) => r.token), [again.token], 'only the new attempt is recorded');
    });

    t.test('admin: drain removes waiting and keeps active', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s);
      const active = await get(env, s, job.id);
      await env.addJobs(s, 5);
      assert.deepEqual(await clean(env, s, { state: 'waiting', limit: 2 }), { removed: 2, remaining: true });
      assert.deepEqual(await clean(env, s, { state: 'waiting', limit: 10 }), { removed: 3, remaining: false });
      assert.equal((await get(env, s, job.id)).rev, active.rev, 'the active job is unchanged');
      assert.equal((await env.store.counts(s)).active, 1);
    });

    t.test('admin: drain delayed true removes delayed too', async (env) => {
      const s = env.scope();
      const [later] = await env.addJobs(s, 1, { delayMs: 60_000 });
      const { job, token } = await claimed(env, s);
      const res = await env.store.fail(s, { id: job.id, token, error: 'e', retryInMs: 60_000 });
      assert.ok(res.ok && res.state === 'delayed');
      assert.deepEqual(await clean(env, s, { state: 'delayed', limit: 10 }), { removed: 2, remaining: false });
      for (const id of [later!.id, job.id]) assert.equal(await env.store.get(s, id), null);
      await rejectsRequest(clean(env, s, { state: 'active', limit: 10 } as never));
      for (const req of [{ state: 'waiting', limit: 0 }, { state: 'waiting', limit: 5001 }, { state: 'waiting', olderThanMs: -1, limit: 1 }, { state: 'waiting', limit: 1, keepLast: 1 }]) {
        await rejectsRequest(clean(env, s, req as never), JSON.stringify(req));
      }
    });

    t.test('admin: obliterate refuses with active jobs unless forced', async (env) => {
      const s = env.scope();
      await claimed(env, s);
      await env.addJobs(s, 2);
      const before = await env.store.counts(s);
      await assert.rejects(env.store.obliterate(s, { limit: 100 }), (e: unknown) => hasCode('QUEUE_NOT_IDLE')(e) && (e as { active?: unknown }).active === 1);
      assert.deepEqual(await env.store.counts(s), before, 'a refused call writes nothing');
      assert.deepEqual(await env.store.obliterate(s, { force: true, limit: 100 }), { removed: 3, done: true });
      assert.deepEqual(await env.store.counts(s), ZERO_COUNTS);
      assert.deepEqual(await env.store.obliterate(env.scope(), { limit: 100 }), { removed: 0, done: true }, 'an unknown queue is already gone');
      for (const req of [{ limit: 0 }, { limit: 5001 }, { limit: 1, force: 'yes' }, { limit: 1, other: 1 }]) {
        await rejectsRequest(env.store.obliterate(s, req as never), JSON.stringify(req));
      }
    });

    t.test('admin: obliterate with active jobs and no force sets no marker', async (env) => {
      const s = env.scope();
      await claimed(env, s);
      await assert.rejects(env.store.obliterate(s, { limit: 100 }), hasCode('QUEUE_NOT_IDLE'));
      const [added] = await env.addJobs(s, 1);
      assert.equal(oneJob(await env.claim(s)).id, added!.id);
    });

    t.test('admin: obliterate marker blocks add and claim', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 3);
      assert.deepEqual(await env.store.obliterate(s, { limit: 1 }), { removed: 1, done: false });
      await rejectsMarked(env.store.add(s, [env.job()]), 'add');
      await rejectsMarked(env.claim(s), 'claim');
      await rejectsMarked(env.store.sweep(s, sweepReq()), 'sweep');
      await env.addJobs(env.scope(), 1);
      await env.addJobs(env.scope(s.queue, 'other'), 1);
      await obliterateAll(env.store, s, false, 1);
      await env.addJobs(s, 1);
    });

    t.test('admin: obliterate marker blocks every other write path', async (env) => {
      const s = env.scope();
      const now = await env.store.now();
      assert.ok((await env.store.putSchedule(s, { schedule: scheduleInput('k', { nextRunAt: now }), expectedRev: null })).ok);
      const sched = (await env.store.getSchedule(s, { key: 'k' }))!;
      const f = await claimed(env, s, { maxAttempts: 1 });
      assert.ok((await env.store.fail(s, { id: f.job.id, token: f.token, error: 'e', deadLetter: {} })).ok);
      const held = await claimed(env, s, {}, { hold: true });
      await env.addJobs(s, 2);
      assert.equal((await env.store.obliterate(s, { force: true, limit: 1 })).done, false);
      await rejectsMarked(env.store.redrive(s, { ids: [f.job.id], limit: 1 }), 'redrive');
      await rejectsMarked(env.store.setProgress(s, { id: held.job.id, token: held.token, progress: 'p' }), 'setProgress');
      await rejectsMarked(env.store.renew(s, { id: held.job.id, token: held.token, leaseMs: env.leaseMs, started: true }), 'renew started');
      await rejectsMarked(env.store.putSchedule(s, { schedule: scheduleInput('k2'), expectedRev: null }), 'putSchedule');
      await rejectsMarked(
        env.store.fireSchedule(s, { key: 'k', expectedRev: sched.rev, mode: 'tick', nextRunAt: now + 60_000, job: fireJob('k', now) }),
        'fireSchedule',
      );
      const after = await env.store.getSchedule(s, { key: 'k' });
      assert.ok(after, 'schedules stay until the last page');
      assert.equal(after.rev, sched.rev, 'a blocked fire does not advance the schedule');
      assert.equal(await env.store.get(s, fireJob('k', now).id), null, 'a blocked fire inserts no job');
      await obliterateAll(env.store, s, false);
    });

    t.test('admin: obliterate is resumable after a crash between pages', async (env) => {
      const s = env.scope();
      await claimed(env, s);
      await env.addJobs(s, 2);
      assert.equal((await env.store.obliterate(s, { force: true, limit: 1 })).done, false);
      const store = env.caps.durable ? await env.reopen() : env.store;
      if (store !== env.store) await store.open();
      await obliterateAll(store, s, false, 1);
      assert.deepEqual(await store.counts(s), ZERO_COUNTS);
      await store.add(s, [env.job()]);
    });

    t.test('admin: obliterate deletes schedules and settings but not worker records', async (env) => {
      const s = env.scope();
      assert.ok((await env.store.putSchedule(s, { schedule: scheduleInput('k'), expectedRev: null })).ok);
      // a dead letter with progress, and a finished job whose id was reused (a history record)
      const f = await claimed(env, s, { maxAttempts: 1 });
      assert.ok((await env.store.setProgress(s, { id: f.job.id, token: f.token, progress: 'p' })).ok);
      assert.ok((await env.store.fail(s, { id: f.job.id, token: f.token, error: 'e', deadLetter: {} })).ok);
      const r = await claimed(env, s);
      assert.ok((await env.store.complete(s, { id: r.job.id, token: r.token, result: null })).ok);
      await env.store.add(s, [env.job({ id: r.job.id })]);
      const historyId = `${r.job.id}#${r.job.seq}`;
      assert.equal((await env.store.getAttempts(s, { id: historyId })).attempts.length, 1);
      await env.store.setPaused(s, true);
      const n = { namespace: s.namespace };
      const w = {
        workerId: 'w1', queues: [s.queue], concurrency: 1, sureqVersion: '0.3.0', formatVersion: 1, heartbeatIntervalMs: 1000, host: 'h', pid: 1,
        labels: {}, scheduler: false,
      };
      await env.store.registerWorker(n, w);
      await env.store.registerWorker(n, { ...w, workerId: 'gone' });
      assert.equal((await env.store.obliterate(s, { force: true, limit: 1 })).done, false);
      // worker records belong to the namespace, so the queue's obliterating marker does not block them
      await env.store.registerWorker(n, { ...w, workerId: 'w2' });
      const beat = await env.store.heartbeatWorker(n, { workerId: 'w1', activeJobs: 0, concurrency: 1, status: 'running', scheduler: false });
      assert.deepEqual(beat, { ok: true });
      await env.store.unregisterWorker(n, { workerId: 'gone' });
      assert.deepEqual(await env.store.purgeWorkers(n, { staleIntervals: 3600, limit: 10 }), { removed: 0 });
      await obliterateAll(env.store, s, false);
      assert.deepEqual((await env.store.listWorkers(n, {})).workers.map((x) => x.workerId).sort(), ['w1', 'w2'], 'worker records stay');
      assert.equal(await env.store.isPaused(s), false);
      assert.equal(await env.store.getSchedule(s, { key: 'k' }), null);
      assert.deepEqual((await env.store.listSchedules(s, { limit: 10 })).schedules, []);
      assert.deepEqual(await env.store.list(s, { state: 'failed', deadLetter: {}, offset: 0, limit: 10, order: 'asc' }), []);
      assert.deepEqual((await env.store.getAttempts(s, { id: historyId })).attempts, []);
      assert.deepEqual((await env.store.getAttempts(s, { id: f.job.id })).attempts, []);
      assert.deepEqual(await env.store.counts(s), ZERO_COUNTS);
    });

    t.test("admin: token after forced obliterate and re-add of the same id is higher than the stale worker's", async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await obliterateAll(env.store, s);
      await env.store.add(s, [env.job({ id: job.id })]);
      const again = oneJob(await env.claim(s));
      assert.ok(again.token > token, 'the new token is higher');
      assert.ok(again.seq > job.seq, 'the new seq is higher');
    });

    t.test('admin: stale worker write after forced obliterate is rejected not-active', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await obliterateAll(env.store, s);
      const notActive = { ok: false, reason: 'not-active' };
      const id = job.id;
      assert.deepEqual(await env.store.complete(s, { id, token, result: null }), notActive);
      assert.deepEqual(await env.store.fail(s, { id, token, error: 'e' }), notActive);
      assert.deepEqual(await env.store.renew(s, { id, token, leaseMs: env.leaseMs }), notActive);
      assert.deepEqual(await env.store.setProgress(s, { id, token, progress: 'p' }), notActive);
      assert.deepEqual(await env.store.release(s, { id, token, refundAttempt: false, handlerStarted: true }), notActive);
    });
  },
};
