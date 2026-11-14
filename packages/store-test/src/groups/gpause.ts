import assert from 'node:assert/strict';
import type { ConformanceGroup } from './types.js';
import { claimed, get, sweepReq } from './util.js';

export const gpauseGroup: ConformanceGroup = {
  name: 'gpause',
  mode: 'fake',
  register(t) {
    t.test('gpause: setPaused persists and changed flag is correct', async (env) => {
      const s = env.scope();
      assert.equal(await env.store.isPaused(s), false);
      assert.deepEqual(await env.store.setPaused(s, false), { changed: false });
      assert.deepEqual(await env.store.setPaused(s, true), { changed: true });
      assert.equal(await env.store.isPaused(s), true);
      assert.deepEqual(await env.store.setPaused(s, true), { changed: false });
      assert.deepEqual(await env.store.setPaused(s, false), { changed: true });
      assert.equal(await env.store.isPaused(s), false);
    });

    t.test('gpause: claim returns no jobs while paused and jobs after resume', async (env) => {
      const s = env.scope();
      await env.store.setPaused(s, true);
      const jobs = await env.addJobs(s, 2);
      assert.deepEqual((await env.claim(s, { limit: 5 })).jobs, []);
      for (const j of jobs) assert.equal((await get(env, s, j.id)).rev, 1, 'a paused claim touches nothing');
      assert.equal(await env.store.isPaused(s), true);
      await env.store.setPaused(s, false);
      assert.equal((await env.claim(s, { limit: 5 })).jobs.length, 2);
    });

    t.test('gpause: claim result reports paused true and blocked reason paused, also when a gate would apply', async (env) => {
      const empty = env.scope();
      const full = env.scope();
      await env.addJobs(full, 2);
      for (const paused of [true, false]) {
        for (const s of [empty, full]) {
          await env.store.setPaused(s, paused);
          const res = await env.claim(s);
          assert.equal(res.paused, res.blocked?.reason === 'paused', 'paused is the same as blocked for pause');
          if (paused && s === full) assert.deepEqual([res.jobs, res.paused, res.blocked], [[], true, { reason: 'paused' }]);
        }
      }
    });

    t.race('gpause: concurrent setPaused and claim never return a job claimed after pause was acknowledged', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 50);
      const pods = await env.pods(env.concurrency);
      let acked = false;
      const pausing = env.store.setPaused(s, true).then(() => void (acked = true));
      const claimers = pods.map(async (p, k) => {
        for (let n = 0; n < 4; n++) {
          const after = acked;
          const res = await p.claim(s, { workerId: `w${k}`, limit: 1, leaseMs: env.leaseMs, claimId: `c${k}-${n}` });
          if (after) assert.deepEqual(res.jobs, [], 'a claim started after the pause was acknowledged takes nothing');
        }
      });
      await Promise.all([pausing, ...claimers]);
      await env.store.setPaused(s, false);
    });

    t.test('gpause: add, renew, complete, fail, release, sweep and cancel work while paused', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      const b = await claimed(env, s);
      const c = await claimed(env, s);
      const d = await claimed(env, s);
      const e = await claimed(env, s);
      await env.store.setPaused(s, true);
      assert.equal((await env.addJobs(s, 1)).length, 1);
      assert.equal((await env.store.renew(s, { id: a.job.id, token: a.token, leaseMs: env.leaseMs })).ok, true);
      assert.equal((await env.store.complete(s, { id: a.job.id, token: a.token, result: null })).ok, true);
      assert.equal((await env.store.fail(s, { id: b.job.id, token: b.token, error: 'e' })).ok, true);
      assert.equal((await env.store.release(s, { id: c.job.id, token: c.token, refundAttempt: true, handlerStarted: false })).ok, true);
      assert.equal((await env.store.cancel(s, { id: d.job.id })).ok, true);
      await env.elapse(env.leaseMs + 1);
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept.map((j) => j.id), [e.job.id]);
      await env.store.setPaused(s, false);
    });

    t.test('gpause: flag is per queue and namespace', async (env) => {
      const a = env.scope('q');
      const otherQueue = env.scope('q2');
      const otherNs = env.scope('q', 'other');
      for (const s of [a, otherQueue, otherNs]) await env.addJobs(s, 1);
      await env.store.setPaused(a, true);
      assert.equal(await env.store.isPaused(otherQueue), false);
      assert.equal(await env.store.isPaused(otherNs), false);
      assert.deepEqual((await env.claim(a)).jobs, []);
      assert.equal((await env.claim(otherQueue)).jobs.length, 1);
      assert.equal((await env.claim(otherNs)).jobs.length, 1);
      await env.store.setPaused(a, false);
    });
  },
};
