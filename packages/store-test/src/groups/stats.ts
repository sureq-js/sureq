import assert from 'node:assert/strict';
import type { JobRecord, Scope, StatsResult } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, oneJob, rejectsRequest, ZERO_COUNTS } from './util.js';

const HOUR = 3_600_000;

const stats = (env: TestEnv, s: Scope): Promise<StatsResult> => env.store.stats(s, {});

/** One job in each state; returns the waiting one, added first. */
async function everyState(env: TestEnv, s: Scope): Promise<JobRecord> {
  const [w] = await env.addJobs(s, 1);
  await env.addJobs(s, 1, { delayMs: 60_000 });
  const only = (name: string) => claimed(env, s, { name }, { names: [name] });
  await only('active');
  const done = await only('completed');
  assert.equal((await env.store.complete(s, { id: done.job.id, token: done.token, result: null })).ok, true);
  const bad = await only('failed');
  assert.equal((await env.store.fail(s, { id: bad.job.id, token: bad.token, error: 'e' })).ok, true);
  const [c] = await env.addJobs(s, 1, { name: 'cancelled' });
  assert.equal((await env.store.cancel(s, { id: c!.id })).ok, true);
  return w!;
}

export const statsGroup: ConformanceGroup = {
  name: 'stats',
  mode: 'fake',
  register(t) {
    t.test('metrics: stats returns counts per state consistent with getCounts in one read', async (env) => {
      const s = env.scope();
      await everyState(env, s);
      const res = await stats(env, s);
      assert.deepEqual({ ...res.counts }, { ...(await env.store.counts(s)) });
      assert.deepEqual({ ...res.counts }, { waiting: 1, delayed: 1, active: 1, completed: 1, failed: 1, cancelled: 1, blocked: 0 });
      await env.store.setPaused(s, true);
      const paused = await stats(env, s);
      assert.equal(paused.counts.blocked, paused.counts.waiting, 'every waiting job is blocked while paused');
      await env.store.setPaused(s, false);
    });

    t.test('metrics: claim and complete return store timestamps', async (env) => {
      const s = env.scope();
      await env.elapse(1000);
      const { job, token, now } = await claimed(env, s);
      assert.equal(now, await env.store.now(), 'claim returns the store time');
      assert.equal(job.startedAt, now, 'the claim is stamped with the time it returns');
      await env.elapse(500);
      const done = await env.store.complete(s, { id: job.id, token, result: null });
      assert.ok(done.ok);
      assert.equal(done.now, await env.store.now(), 'complete returns the store time');
      assert.equal(done.now - now, 500);
      assert.equal((await env.store.get(s, job.id))?.finishedAt, done.now, 'the completion is stamped with the time it returns');
    }, { fakeClock: true });

    t.test('age: oldest waiting runAt ignores delayed, active and finished jobs', async (env) => {
      const s = env.scope();
      await env.elapse(1000);
      const w = await everyState(env, s);
      assert.equal((await stats(env, s)).oldestWaitingRunAt, w.runAt);
      assert.equal((await env.store.remove(s, { id: w.id })).removed, true);
      assert.equal((await stats(env, s)).oldestWaitingRunAt, null, 'no waiting job left');
      const empty = await stats(env, env.scope());
      assert.deepEqual([{ ...empty.counts }, empty.oldestWaitingRunAt, empty.deadLetters], [ZERO_COUNTS, null, 0]);
      await rejectsRequest(env.store.stats(s, { extra: 1 } as never), 'a stats request has no fields');
    });

    t.race('age: stats returns counts and oldest runAt from one read', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 30);
      const pods = await env.pods(3);
      const answers: StatsResult[] = [];
      // claims first, then stats, then adds: a read split across them sees the queue empty, then refilled
      await Promise.all([
        ...Array.from({ length: 10 }, (_, k) =>
          pods[k % 3]!.claim(s, { workerId: `w${k}`, limit: 3, leaseMs: env.leaseMs, claimId: `c${k}` })),
        ...Array.from({ length: 10 }, async (_, k) => void answers.push(await pods[k % 3]!.stats(s, {}))),
        ...Array.from({ length: 5 }, (_, k) => pods[k % 3]!.add(s, [env.job()])),
      ]);
      for (const a of answers) {
        const claimable = a.counts.waiting - a.counts.blocked > 0;
        assert.equal(claimable, a.oldestWaitingRunAt !== null, 'waiting jobs and an oldest runAt come from the same read');
        if (a.oldestWaitingRunAt !== null) assert.ok(a.oldestWaitingRunAt <= a.now, 'the oldest waiting job is due');
      }
      assert.deepEqual({ ...(await stats(env, s)).counts }, { ...(await env.store.counts(s)) });
    });

    t.test('age: promoted retry job ages from its runAt, not createdAt', async (env) => {
      const s = env.scope();
      const [x] = await env.addJobs(s, 1);
      await env.elapse(5000);
      const job = oneJob(await env.claim(s));
      const failed = await env.store.fail(s, { id: job.id, token: job.token, error: 'e', retryInMs: 2000 });
      assert.ok(failed.ok && failed.state === 'delayed', 'the job goes delayed for its retry');
      assert.equal((await stats(env, s)).oldestWaitingRunAt, null, 'a retry not yet due is not waiting');
      await env.elapse(2000);
      const res = await stats(env, s);
      assert.equal(res.oldestWaitingRunAt, failed.runAt);
      assert.notEqual(res.oldestWaitingRunAt, x!.createdAt);
      assert.equal(res.now - res.oldestWaitingRunAt!, 0);
    }, { fakeClock: true });

    t.test('age: computed in store time under pod clock skew ±1h', async (env) => {
      for (const skew of [HOUR, -HOUR]) {
        const s = env.scope();
        await env.skewPodClock(skew, async () => {
          await env.addJobs(s, 1);
          await env.elapse(4000);
          const res = await stats(env, s);
          assert.equal(res.now - res.oldestWaitingRunAt!, 4000, `age under skew ${skew}`);
          assert.equal(res.now, await env.store.now(), 'now is store time');
        });
      }
    }, { fakeClock: true });

    t.test('stats: deadLetters counts failed jobs with a dead-letter marker', async (env) => {
      const s = env.scope();
      for (const [name, deadLetter] of [['dead', {}], ['plain', false]] as const) {
        const { job, token } = await claimed(env, s, { name, maxAttempts: 1 }, { names: [name] });
        assert.ok((await env.store.fail(s, { id: job.id, token, error: 'e', deadLetter })).ok);
      }
      const done = await claimed(env, s, { name: 'done' }, { names: ['done'] });
      assert.ok((await env.store.complete(s, { id: done.job.id, token: done.token, result: null })).ok);
      const res = await stats(env, s);
      assert.deepEqual([res.deadLetters, res.counts.failed, res.counts.completed], [1, 2, 1]);
    });

    t.test('stats: oldest waiting runAt is null while the queue is paused', async (env) => {
      const s = env.scope();
      const [first] = await env.addJobs(s, 2);
      await env.store.setPaused(s, true);
      const paused = await stats(env, s);
      assert.equal(paused.oldestWaitingRunAt, null, 'paused jobs are blocked');
      assert.equal(paused.counts.waiting, 2);
      await env.store.setPaused(s, false);
      assert.equal((await stats(env, s)).oldestWaitingRunAt, first!.runAt);
    });
  },
};
