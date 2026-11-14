import assert from 'node:assert/strict';
import type { JobRecord } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, get, oneJob, sweepReq } from './util.js';

const release = { refundAttempt: false, handlerStarted: true } as const;
const margin = (env: TestEnv): number => 50 * env.timeScale;

export const leaseGroup: ConformanceGroup = {
  name: 'lease',
  mode: 'real',
  register(t) {
    t.test('lease: claim stores owner, token and expiresAt as now plus leaseMs', async (env) => {
      const s = env.scope();
      const { job, now } = await claimed(env, s, {}, { workerId: 'owner-1' });
      const rec = await get(env, s, job.id);
      assert.deepEqual(
        { owner: rec.lease?.owner, token: rec.lease?.token, expiresAt: rec.lease?.expiresAt },
        { owner: 'owner-1', token: rec.token, expiresAt: now + env.leaseMs },
      );
    });

    t.test('lease: lease expires at claim time plus leaseMs on store time', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      assert.equal(a.job.lease?.expiresAt, a.now + env.leaseMs);
      // The pod's clock is not the store's: a claim made while it is an hour ahead still uses store time.
      const realNow = Date.now;
      await env.skewPodClock(3_600_000, async () => {
        const b = await claimed(env, s);
        assert.ok(Math.abs(b.now - realNow()) < 5000 * env.timeScale, `store time ${b.now} is not the skewed pod time`);
        assert.equal(b.job.lease?.expiresAt, b.now + env.leaseMs);
      });
    });

    t.test('lease: renew sets expiresAt to now plus leaseMs and returns now', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const res = await env.store.renew(s, { id: job.id, token, leaseMs: 2 * env.leaseMs });
      assert.ok(res.ok);
      assert.equal(res.expiresAt, res.now + 2 * env.leaseMs);
      assert.equal((await get(env, s, job.id)).lease?.expiresAt, res.expiresAt);
    });

    t.test('lease: renew with current token extends beyond the original expiry', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await env.elapse(env.leaseMs / 2);
      const res = await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs });
      assert.ok(res.ok);
      assert.ok(res.expiresAt > job.lease!.expiresAt, 'the renewed lease ends later');
    });

    t.test('lease: renew after expiry is rejected as expired and does not revive the lease', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await env.elapse(env.leaseMs + margin(env));
      assert.deepEqual(await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs }), { ok: false, reason: 'expired' });
      const rec = await get(env, s, job.id);
      assert.equal(rec.lease?.expiresAt, job.lease!.expiresAt, 'the expiry is unchanged');
      assert.equal(rec.rev, job.rev);
    });

    t.test('lease: renew with stale token is rejected and changes nothing', async (env) => {
      const s = env.scope();
      const first = await claimed(env, s);
      await env.elapse(env.leaseMs + margin(env));
      assert.equal((await env.store.sweep(s, sweepReq())).swept.length, 1);
      assert.equal((await env.claim(s)).jobs[0]?.id, first.job.id);
      const before = await get(env, s, first.job.id);
      assert.deepEqual(await env.store.renew(s, { id: first.job.id, token: first.token, leaseMs: env.leaseMs }), {
        ok: false,
        reason: 'superseded',
      });
      assert.deepEqual(await get(env, s, first.job.id), before);
    });

    t.test('lease: renew on completed, failed, cancelled or removed job is rejected as not-active', async (env) => {
      const s = env.scope();
      const done = await claimed(env, s);
      await env.store.complete(s, { id: done.job.id, token: done.token, result: null });
      const failed = await claimed(env, s);
      await env.store.fail(s, { id: failed.job.id, token: failed.token, error: 'e' });
      const cancelled = await claimed(env, s);
      await env.store.cancel(s, { id: cancelled.job.id });
      const removed = await claimed(env, s);
      await env.store.complete(s, { id: removed.job.id, token: removed.token, result: null });
      await env.store.remove(s, { id: removed.job.id });
      for (const c of [done, failed, cancelled, removed]) {
        assert.deepEqual(await env.store.renew(s, { id: c.job.id, token: c.token, leaseMs: env.leaseMs }), { ok: false, reason: 'not-active' });
      }
    });

    t.test('lease: lease is cleared by complete, fail, release, cancel and sweep', async (env) => {
      const s = env.scope();
      const swept = await claimed(env, s);
      const done = await claimed(env, s);
      await env.store.complete(s, { id: done.job.id, token: done.token, result: null });
      const failed = await claimed(env, s);
      await env.store.fail(s, { id: failed.job.id, token: failed.token, error: 'e' });
      const released = await claimed(env, s);
      await env.store.release(s, { id: released.job.id, token: released.token, ...release });
      const c = await claimed(env, s, { name: 'c' }, { names: ['c'] });
      await env.store.cancel(s, { id: c.job.id });
      await env.elapse(env.leaseMs + margin(env));
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept.map((j) => j.id), [swept.job.id]);
      for (const j of [swept, done, failed, released, c]) assert.equal((await get(env, s, j.job.id)).lease, null, `${j.job.id} has no lease`);
    });

    t.test('lease: renew and sweep race — exactly one wins', async (env) => {
      const s = env.scope();
      const n = Math.min(env.iterations, env.caps.limits.maxClaimLimit);
      const spread = 400 * env.timeScale;
      await env.addJobs(s, n);
      // expiries spread over `spread` ms; the race starts at the middle one, so some leases are live and some ran out
      const jobs: JobRecord[] = [];
      for (let i = 0; i < n; i++) jobs.push(oneJob(await env.claim(s, { leaseMs: env.leaseMs + Math.floor((i * spread) / n) })));
      const middle = jobs[Math.floor(n / 2)]!.lease!.expiresAt;
      await env.elapse(Math.max(0, middle - (await env.store.now())));
      while ((await env.store.now()) < middle) await env.elapse(1);
      // half the renews start before the sweep and half after it
      const renew = (j: JobRecord) => env.store.renew(s, { id: j.id, token: j.token, leaseMs: env.leaseMs });
      const even = jobs.filter((_, i) => i % 2 === 0);
      const odd = jobs.filter((_, i) => i % 2 === 1);
      const [early, first, late] = await Promise.all([
        Promise.all(even.map(renew)),
        env.store.sweep(s, sweepReq({ limit: n })),
        Promise.all(odd.map(renew)),
      ]);
      const renews = jobs.map((_, i) => (i % 2 === 0 ? early[i / 2]! : late[(i - 1) / 2]!));
      await env.elapse(Math.max(0, jobs[n - 1]!.lease!.expiresAt - (await env.store.now())) + margin(env));
      const sweptIds = new Set(first.swept.map((j) => j.id));
      for (;;) {
        const r = await env.store.sweep(s, sweepReq({ limit: n }));
        if (r.swept.length === 0) break;
        for (const j of r.swept) sweptIds.add(j.id);
      }
      for (const [i, j] of jobs.entries()) {
        const renewed = renews[i]!.ok;
        assert.notEqual(renewed, sweptIds.has(j.id), `job ${i}: exactly one of renew and sweep wins`);
        assert.equal((await get(env, s, j.id)).state, renewed ? 'active' : 'waiting');
      }
      // with fewer than three jobs no lease is still live at the middle expiry, so only the sweep can win
      if (n >= 3) {
        const won = renews.filter((r) => r.ok).length;
        assert.ok(won > 0 && won < n, `both outcomes occur: ${won} of ${n} renews won`);
      }
    });

    t.test('lease: renew never changes owner, token or attempt', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s, {}, { workerId: 'keeper' });
      for (let i = 0; i < 3; i++) assert.equal((await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs })).ok, true);
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.lease?.owner, rec.token, rec.lease?.token, rec.attempt], ['keeper', token, token, job.attempt]);
    });

    t.test('lease: claim stores claimId on the lease and complete, fail and release clear it', async (env) => {
      const s = env.scope();
      const ops = [
        (id: string, token: number) => env.store.complete(s, { id, token, result: null }),
        (id: string, token: number) => env.store.fail(s, { id, token, error: 'e', retryInMs: 60_000 }),
        (id: string, token: number) => env.store.release(s, { id, token, delayMs: 60_000, ...release }),
      ];
      for (const [i, op] of ops.entries()) {
        const { job, token } = await claimed(env, s, {}, { claimId: `claim-${i}` });
        assert.equal((await get(env, s, job.id)).lease?.claimId, `claim-${i}`);
        assert.equal((await op(job.id, token)).ok, true);
        assert.equal((await get(env, s, job.id)).lease, null);
      }
    });

    t.test('lease: active jobs with live leases are never returned by sweep', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 5);
      const res = await env.claim(s, { limit: 5, leaseMs: 60_000 * env.timeScale });
      await env.elapse(margin(env));
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept, []);
      for (const j of res.jobs) assert.equal((await get(env, s, j.id)).state, 'active');
    });
  },
};
