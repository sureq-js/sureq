import assert from 'node:assert/strict';
import { FakeClock } from '../clock.js';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, get, sweepReq, oneJob } from './util.js';

const HOUR = 3_600_000;
const margin = (env: TestEnv): number => 50 * env.timeScale;

/** `call` runs between two store clock reads; its store instants must lie between them. */
async function between<T>(env: TestEnv, call: () => Promise<T>, pick: (r: T) => (number | null | undefined)[]): Promise<T> {
  const before = await env.store.now();
  const r = await call();
  const after = await env.store.now();
  for (const at of pick(r)) {
    assert.ok(Number.isInteger(at), `store instant ${at} is an integer`);
    assert.ok(at! >= before && at! <= after, `store instant ${at} lies within [${before}, ${after}]`);
  }
  return r;
}

export const clockGroup: ConformanceGroup = {
  name: 'clock',
  mode: 'real',
  register(t) {
    t.test('clock: now returns an integer that never decreases across calls', async (env) => {
      let last = -Infinity;
      for (let i = 0; i < 200; i++) {
        const now = await env.store.now();
        assert.ok(Number.isInteger(now), `now ${now} is an integer`);
        assert.ok(now >= last, `now ${now} is not below ${last}`);
        last = now;
      }
    });

    t.test('clock: store follows the injected test clock', async (env) => {
      const clock = new FakeClock(1_800_000_000_000);
      const store = await env.freshStore({ clock });
      await store.open();
      assert.equal(await store.now(), clock.now());
      clock.advance(500);
      assert.equal(await store.now(), clock.now());
      await store.close();
    }, { fakeClock: true });

    t.test('clock: store time is unaffected by pod clock skew +1h', async (env) => {
      const s = env.scope();
      const realNow = Date.now;
      const live = await claimed(env, s);
      await env.skewPodClock(HOUR, async () => {
        assert.equal((await env.store.renew(s, { id: live.job.id, token: live.token, leaseMs: env.leaseMs })).ok, true, 'a fresh lease is live');
        const fresh = await claimed(env, s);
        assert.ok(fresh.job.lease!.expiresAt - fresh.now === env.leaseMs);
        const now = await env.store.now();
        assert.ok(Math.abs(now - realNow()) < 5000 * env.timeScale, `store time ${now} follows the real clock, not the pod's`);
      });
    });

    t.test('clock: store time is unaffected by pod clock skew -1h', async (env) => {
      const s = env.scope();
      const old = await claimed(env, s);
      await env.elapse(env.leaseMs + margin(env));
      await env.skewPodClock(-HOUR, async () => {
        const fresh = await claimed(env, s, { name: 'fresh' }, { names: ['fresh'] });
        const first = await env.store.sweep(s, sweepReq());
        assert.deepEqual(first.swept.map((j) => j.id), [old.job.id], 'a lease that expired before the skew is swept');
        await env.elapse(env.leaseMs + margin(env));
        const second = await env.store.sweep(s, sweepReq());
        assert.deepEqual(second.swept.map((j) => j.id), [fresh.job.id], 'store time keeps moving while the pod clock is behind');
      });
    });

    t.test('clock: lease expiry and delayed due time use the same clock', async (env) => {
      const s = env.scope();
      const [delayed] = await env.addJobs(s, 1, { name: 'delayed', delayMs: env.leaseMs });
      const leased = await claimed(env, s, { name: 'leased' }, { names: ['leased'] });
      assert.equal(delayed!.runAt - delayed!.createdAt, env.leaseMs);
      assert.equal(leased.job.lease!.expiresAt - leased.now, env.leaseMs);
      await env.elapse(env.leaseMs / 2);
      if ((await env.store.now()) < Math.min(delayed!.runAt, leased.job.lease!.expiresAt)) {
        assert.deepEqual((await env.store.sweep(s, sweepReq())).swept, [], 'not expired yet');
        assert.equal((await get(env, s, delayed!.id)).state, 'delayed', 'not due yet');
      }
      await env.elapse(env.leaseMs / 2 + margin(env));
      assert.ok((await env.store.now()) >= Math.max(delayed!.runAt, leased.job.lease!.expiresAt));
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept.map((j) => j.id), [leased.job.id], 'expired');
      assert.equal((await get(env, s, delayed!.id)).state, 'waiting', 'due');
    });

    t.test('clock: delayMs and retryInMs are resolved against store time not request time', async (env) => {
      const s = env.scope();
      const check = async () => {
        const [d] = await env.addJobs(s, 1, { delayMs: 7000 });
        assert.equal(d!.runAt - d!.createdAt, 7000);
        const { job, token } = await claimed(env, s);
        const res = await env.store.fail(s, { id: job.id, token, error: 'e', retryInMs: 9000 });
        assert.ok(res.ok && res.runAt !== undefined);
        assert.equal(res.runAt - res.now, 9000);
        assert.equal((await get(env, s, job.id)).runAt, res.runAt);
      };
      await check();
      await env.skewPodClock(HOUR, check);
    });

    t.test('clock: results carry the now that was used', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 1);
      const c = await between(env, () => env.claim(s), (r) => [r.now]);
      const job = oneJob(c);
      assert.equal(job.lease?.expiresAt, c.now + env.leaseMs);
      const r = await between(env, () => env.store.renew(s, { id: job.id, token: job.token, leaseMs: env.leaseMs }), (x) => [x.ok ? x.now : null]);
      assert.ok(r.ok && r.expiresAt === r.now + env.leaseMs);
      await between(env, () => env.store.complete(s, { id: job.id, token: job.token, result: null }), (x) => [x.ok ? x.now : null]);
      await between(env, () => env.store.sweep(s, sweepReq()), (x) => [x.now]);
    });

    t.test('clock: createdAt, startedAt and finishedAt are store instants', async (env) => {
      const s = env.scope();
      await env.skewPodClock(HOUR, async () => {
        const [added] = await between(env, () => env.addJobs(s, 1), (jobs) => [jobs[0]!.createdAt]);
        await between(env, () => env.claim(s), (r) => [oneJob(r).startedAt]);
        const rec = await get(env, s, added!.id);
        await env.store.complete(s, { id: rec.id, token: rec.token, result: null });
        const before = await env.store.now();
        const done = await get(env, s, added!.id);
        assert.ok(done.finishedAt !== null && done.finishedAt <= before && done.finishedAt >= rec.startedAt!, 'finishedAt is a store instant');
      });
    });

    t.test(
      'clock: two store objects on one backend agree on expiry',
      async (env) => {
        const [a, b] = await env.pods(2);
        const s = env.scope();
        await a!.add(s, [env.job()]);
        const res = await a!.claim(s, { workerId: 'pod-a', claimId: 'c', limit: 1, leaseMs: env.leaseMs });
        assert.equal(res.jobs.length, 1);
        await env.elapse(env.leaseMs + margin(env));
        assert.deepEqual((await b!.sweep(s, sweepReq())).swept.map((j) => j.id), [oneJob(res).id]);
      },
      { requires: 'shared' },
    );
  },
};
