import assert from 'node:assert/strict';
import { sweepDoesNotUndoRenew } from './fencing.js';
import type { ConformanceGroup } from './types.js';
import { claimed, get, rejectsRequest, sweepReq, together } from './util.js';

export const sweepGroup: ConformanceGroup = {
  name: 'sweep',
  mode: 'fake',
  register(t) {
    t.test('sweep: expired lease is requeued to waiting with crashCount 1 and token kept', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      const res = await env.store.sweep(s, sweepReq());
      assert.deepEqual(res.swept, [{ id: job.id, token, previousOwner: 'w1', action: 'requeued', attempt: 1, crashCount: 1 }]);
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.crashCount, rec.token, rec.lease], ['waiting', 1, token, null]);
    });

    t.test('sweep: live lease is never touched', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s);
      await env.elapse(env.leaseMs - 1);
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept, []);
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.crashCount, rec.rev], ['active', 0, job.rev]);
    });

    t.test('sweep: lease expiring exactly at now is swept and one millisecond earlier is not', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s);
      if (env.clock) {
        env.clock.advance(job.lease!.expiresAt - 1 - env.clock.now());
        assert.deepEqual((await env.store.sweep(s, sweepReq())).swept, []);
        env.clock.advance(1);
      } else {
        await env.elapse(env.leaseMs + 50 * env.timeScale);
      }
      const res = await env.store.sweep(s, sweepReq());
      assert.deepEqual(res.swept.map((j) => j.id), [job.id]);
      if (env.clock) assert.equal(res.now, job.lease!.expiresAt);
    });

    t.test('sweep: job at maxAttempts with crashCount below maxCrashes is failed with the supplied failError', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s, { maxAttempts: 1 });
      await env.elapse(env.leaseMs + 1);
      const res = await env.store.sweep(s, sweepReq({ failError: 'attempts used up' }));
      assert.equal(res.swept[0]?.action, 'failed');
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.error, rec.crashCount], ['failed', 'attempts used up', 1]);
    });

    t.test('sweep: job reaching maxCrashes is failed with poisonError, also when maxAttempts is used up too', async (env) => {
      const s = env.scope();
      const both = await claimed(env, s, { maxAttempts: 1 });
      const crashes = await claimed(env, s, { maxAttempts: 5 });
      await env.elapse(env.leaseMs + 1);
      const res = await env.store.sweep(s, sweepReq({ maxCrashes: 1, failError: 'fail', poisonError: 'poison pill' }));
      assert.deepEqual(res.swept.map((j) => j.action), ['failed', 'failed']);
      for (const c of [both, crashes]) {
        const rec = await get(env, s, c.job.id);
        assert.deepEqual([rec.state, rec.error], ['failed', 'poison pill']);
      }
    });

    t.test('sweep: requeued job is claimable at once and its next claim gets a larger token', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      await env.store.sweep(s, sweepReq());
      const again = (await env.claim(s)).jobs[0];
      assert.equal(again?.id, job.id);
      assert.ok(again.token > token);
    });

    t.test('sweep: limit is respected and oldest expiry goes first', async (env) => {
      const s = env.scope();
      const order: string[] = [];
      for (let i = 0; i < 5; i++) {
        order.push((await claimed(env, s)).job.id);
        await env.elapse(10);
      }
      await env.elapse(env.leaseMs + 1);
      assert.deepEqual((await env.store.sweep(s, sweepReq({ limit: 2 }))).swept.map((j) => j.id), order.slice(0, 2));
      assert.deepEqual((await env.store.sweep(s, sweepReq({ limit: 2 }))).swept.map((j) => j.id), order.slice(2, 4));
    });

    t.test('sweep: sweep does not undo a renew that landed first', sweepDoesNotUndoRenew);

    t.race('sweep: concurrent sweepers count each crash exactly once', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      const pods = await env.pods(env.concurrency);
      const results = await Promise.all(pods.map((p) => p.sweep(s, sweepReq())));
      assert.equal(results.flatMap((r) => r.swept).length, 1, 'one sweeper acts on the job');
      assert.equal((await get(env, s, job.id)).crashCount, 1);
    });

    t.race('sweep: sweep and stale complete race — exactly one outcome', async (env, i) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const expired = i % 2 === 0;
      if (expired) await env.elapse(env.leaseMs + 1);
      const [done, res] = await together(
        i % 4 >= 2,
        () => env.store.complete(s, { id: job.id, token, result: null }),
        () => env.store.sweep(s, sweepReq()),
      );
      assert.notEqual(done.ok, res.swept.length === 1, 'exactly one of the complete and the sweep acts');
      assert.equal(done.ok, !expired);
      assert.equal((await get(env, s, job.id)).state, expired ? 'waiting' : 'completed');
    });

    t.test('sweep: cancelled and completed jobs are not swept', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      const b = await claimed(env, s);
      await env.store.cancel(s, { id: a.job.id });
      await env.store.complete(s, { id: b.job.id, token: b.token, result: null });
      await env.elapse(env.leaseMs + 1);
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept, []);
    });

    t.test('sweep: returns only the jobs this call swept, with previousOwner', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s, {}, { workerId: 'pod-a' });
      const b = await claimed(env, s, {}, { workerId: 'pod-b' });
      await claimed(env, s, {}, { workerId: 'pod-c', leaseMs: 10 * env.leaseMs });
      await env.elapse(env.leaseMs + 1);
      const res = await env.store.sweep(s, sweepReq());
      assert.deepEqual(
        res.swept.map((j) => [j.id, j.previousOwner]).sort(),
        [[a.job.id, 'pod-a'], [b.job.id, 'pod-b']].sort(),
      );
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept, []);
    });

    t.test('sweep: works while the queue is paused', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s);
      await env.store.setPaused(s, true);
      await env.elapse(env.leaseMs + 1);
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept.map((j) => j.id), [job.id]);
      assert.equal((await get(env, s, job.id)).state, 'waiting');
      await env.store.setPaused(s, false);
    });

    t.test('sweep: invalid limit or maxCrashes throws StoreRequestError', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      for (const over of [{ limit: 0 }, { limit: env.caps.limits.maxClaimLimit + 1 }, { maxCrashes: 0 }, { maxCrashes: 1.5 }]) {
        await rejectsRequest(env.store.sweep(s, sweepReq(over)), JSON.stringify(over));
      }
      assert.equal((await get(env, s, job.id)).state, 'active', 'nothing was swept');
    });
  },
};
