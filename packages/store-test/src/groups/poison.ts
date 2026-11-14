import assert from 'node:assert/strict';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, get, sweepReq, oneJob } from './util.js';

/** Expire the scope's active leases and sweep them. */
async function crash(env: TestEnv, s: ReturnType<TestEnv['scope']>, maxCrashes = 3) {
  await env.elapse(env.leaseMs + 1);
  return env.store.sweep(s, sweepReq({ maxCrashes, failError: 'attempts', poisonError: 'POISON_PILL' }));
}

export const poisonGroup: ConformanceGroup = {
  name: 'poison',
  mode: 'fake',
  register(t) {
    t.test('poison: sweep increments crashCount and requeues below the limit', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s, { maxAttempts: 10 });
      for (const n of [1, 2]) {
        const res = await crash(env, s);
        assert.deepEqual(res.swept.map((j) => [j.action, j.crashCount]), [['requeued', n]]);
        const rec = await get(env, s, job.id);
        assert.deepEqual([rec.state, rec.crashCount], ['waiting', n]);
        await env.claim(s);
      }
    });

    t.test('poison: sweep at crashCount reaching maxCrashes fails the job with POISON_PILL', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s, { maxAttempts: 10 });
      await crash(env, s, 2);
      await env.claim(s);
      const res = await crash(env, s, 2);
      assert.deepEqual(res.swept.map((j) => [j.action, j.crashCount]), [['failed', 2]]);
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.error], ['failed', 'POISON_PILL']);
    });

    t.race('poison: two concurrent sweeps increment crashCount once', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      const [a, b] = await Promise.all([env.store.sweep(s, sweepReq()), env.store.sweep(s, sweepReq())]);
      assert.equal(a.swept.length + b.swept.length, 1);
      assert.equal((await get(env, s, job.id)).crashCount, 1);
    });

    t.test('poison: sweep fails with attempts error when maxAttempts is used up first', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s, { maxAttempts: 1 });
      const res = await crash(env, s, 3);
      assert.equal(res.swept[0]?.action, 'failed');
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.error, rec.crashCount], ['failed', 'attempts', 1]);
    });

    t.test('poison: crashCount is not changed by complete, fail, release or cancel', async (env) => {
      const s = env.scope();
      const ops = [
        (id: string, token: number) => env.store.complete(s, { id, token, result: null }),
        (id: string, token: number) => env.store.fail(s, { id, token, error: 'e', retryInMs: 60_000 }),
        (id: string, token: number) => env.store.release(s, { id, token, refundAttempt: false, handlerStarted: true }),
        (id: string) => env.store.cancel(s, { id }),
      ];
      for (const [i, op] of ops.entries()) {
        const name = `op${i}`;
        const { job } = await claimed(env, s, { name, maxAttempts: 10 }, { names: [name] });
        await crash(env, s);
        const again = oneJob(await env.claim(s, { names: [name] }));
        assert.equal(again.crashCount, 1);
        await op(job.id, again.token);
        assert.equal((await get(env, s, job.id)).crashCount, 1, `op ${i} leaves crashCount`);
      }
    });
  },
};
