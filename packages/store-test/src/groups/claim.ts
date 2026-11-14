import assert from 'node:assert/strict';
import type { JobRecord } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { assertUnique, claimAll, claimed, get, rejectsRequest, sweepReq, together, oneJob } from './util.js';

const ids = (jobs: JobRecord[]): string[] => jobs.map((j) => j.id);

export const claimGroup: ConformanceGroup = {
  name: 'claim',
  mode: 'fake',
  register(t) {
    t.test('claim: returns a waiting job as active with attempt 1, a positive token and lease owner and claimId set', async (env) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1);
      const res = await env.claim(s, { workerId: 'pod-a', claimId: 'claim-1' });
      const got = res.jobs[0];
      assert.equal(got?.id, job!.id);
      assert.equal(got.state, 'active');
      assert.equal(got.attempt, 1);
      assert.ok(Number.isInteger(got.token) && got.token > 0, 'token is a positive integer');
      assert.equal(got.lease?.owner, 'pod-a');
      assert.equal(got.lease.claimId, 'claim-1');
      assert.equal(got.lease.token, got.token);
    });

    t.test('claim: lease expiresAt equals store now plus leaseMs and startedAt equals now', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 1);
      const res = await env.claim(s, { leaseMs: 4321 });
      const got = oneJob(res);
      assert.equal(got.lease?.expiresAt, res.now + 4321);
      assert.equal(got.startedAt, res.now);
    });

    t.test('claim: leaseMsByName overrides leaseMs for that name only', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 1, { name: 'slow' });
      await env.addJobs(s, 1);
      const res = await env.claim(s, { limit: 2, leaseMs: 1000, leaseMsByName: { slow: 5000 } });
      const slow = res.jobs.find((j) => j.name === 'slow');
      const plain = res.jobs.find((j) => j.name === null);
      assert.equal(slow?.lease?.expiresAt, res.now + 5000);
      assert.equal(plain?.lease?.expiresAt, res.now + 1000);
    });

    t.test('claim: respects limit and returns fewer when fewer are claimable', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 5);
      assert.equal((await env.claim(s, { limit: 3 })).jobs.length, 3);
      assert.equal((await env.claim(s, { limit: 3 })).jobs.length, 2);
      assert.equal((await env.claim(s, { limit: 3 })).jobs.length, 0);
    });

    t.test('claim: empty queue returns an empty list and no error', async (env) => {
      const res = await env.claim(env.scope(), { limit: 10 });
      assert.deepEqual(res.jobs, []);
      assert.ok(Number.isInteger(res.now));
    });

    t.test('claim: orders by priority desc then seq asc', async (env) => {
      const s = env.scope();
      const jobs: JobRecord[] = [];
      for (const priority of [1, 5, 1, 5, 0, 1]) jobs.push(...(await env.addJobs(s, 1, { priority })));
      const want = [...jobs].sort((a, b) => b.priority - a.priority || a.seq - b.seq).map((j) => j.id);
      const got: string[] = [];
      for (let i = 0; i < jobs.length; i++) got.push(...ids((await env.claim(s)).jobs));
      assert.deepEqual(got, want);
      assert.deepEqual(ids((await claimFresh(env, jobs)).jobs), want, 'one claim of all returns them in the same order');
    });

    t.test('claim: lifo reverses seq order within a priority', async (env) => {
      const s = env.scope();
      const jobs: JobRecord[] = [];
      for (const priority of [1, 1, 5, 1, 5]) jobs.push(...(await env.addJobs(s, 1, { priority })));
      const want = [...jobs].sort((a, b) => b.priority - a.priority || b.seq - a.seq).map((j) => j.id);
      const got: string[] = [];
      for (let i = 0; i < jobs.length; i++) got.push(...ids((await env.claim(s, { order: 'lifo' })).jobs));
      assert.deepEqual(got, want);
    });

    t.test('claim: first true job is claimed before older jobs of the same priority', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 3, { priority: 2 });
      const [first] = await env.addJobs(s, 1, { priority: 2, first: true });
      const [higher] = await env.addJobs(s, 1, { priority: 3 });
      assert.deepEqual(ids((await env.claim(s, { limit: 2 })).jobs), [higher!.id, first!.id]);
    });

    t.test('claim: skips delayed jobs until runAt on store time, then claims them', async (env) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1, { delayMs: 2000 });
      assert.deepEqual((await env.claim(s)).jobs, []);
      await env.elapse(1000);
      assert.deepEqual((await env.claim(s)).jobs, [], 'not due yet');
      await env.elapse(1000);
      assert.deepEqual(ids((await env.claim(s)).jobs), [job!.id]);
    });

    t.test('claim: retrying delayed job claims with attempt incremented', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      assert.equal((await env.store.fail(s, { id: job.id, token, error: 'e', retryInMs: 1000 })).ok, true);
      assert.deepEqual((await env.claim(s)).jobs, []);
      await env.elapse(1000);
      const again = (await env.claim(s)).jobs[0];
      assert.equal(again?.id, job.id);
      assert.equal(again.attempt, 2);
    });

    t.test('claim: names filter returns only matching names and null matches unnamed', async (env) => {
      const s = env.scope();
      const [a] = await env.addJobs(s, 1, { name: 'a' });
      await env.addJobs(s, 1, { name: 'b' });
      const [none] = await env.addJobs(s, 1);
      const res = await env.claim(s, { limit: 10, names: ['a', null] });
      assert.deepEqual(ids(res.jobs).sort(), [a!.id, none!.id].sort());
      assert.deepEqual(ids((await env.claim(s, { limit: 10, names: ['c'] })).jobs), []);
    });

    t.test('claim: names empty array returns nothing', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 2, { name: 'a' });
      await env.addJobs(s, 1);
      assert.deepEqual((await env.claim(s, { limit: 10, names: [] })).jobs, []);
      assert.equal((await env.store.counts(s)).waiting, 3);
    });

    t.test('claim: paused queue returns nothing, reports blocked paused, and resume restores claiming', async (env) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1);
      await env.store.setPaused(s, true);
      const res = await env.claim(s);
      assert.deepEqual(res.jobs, []);
      assert.equal(res.paused, true);
      assert.equal(res.blocked?.reason, 'paused');
      assert.equal((await get(env, s, job!.id)).state, 'waiting');
      await env.store.setPaused(s, false);
      const after = await env.claim(s);
      assert.deepEqual(ids(after.jobs), [job!.id]);
      assert.equal(after.paused, false);
    });

    t.test('claim: never returns active, completed, failed or cancelled jobs', async (env) => {
      const s = env.scope();
      const active = await claimed(env, s);
      const done = await claimed(env, s);
      await env.store.complete(s, { id: done.job.id, token: done.token, result: null });
      const failed = await claimed(env, s);
      await env.store.fail(s, { id: failed.job.id, token: failed.token, error: 'e' });
      const [cancelled] = await env.addJobs(s, 1);
      await env.store.cancel(s, { id: cancelled!.id });
      const [waiting] = await env.addJobs(s, 1);
      const res = await env.claim(s, { limit: 10 });
      assert.deepEqual(ids(res.jobs), [waiting!.id]);
      assert.equal((await get(env, s, active.job.id)).token, active.token, 'the active job keeps its lease');
    });

    t.test('claim: second claim of the same job after release or sweep issues a larger token, and tokens are unique across jobs', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      await env.store.release(s, { id: a.job.id, token: a.token, refundAttempt: false, handlerStarted: true });
      const a2 = oneJob(await env.claim(s));
      assert.equal(a2.id, a.job.id);
      assert.ok(a2.token > a.token, 'larger token after release');
      await env.elapse(env.leaseMs + 1);
      assert.equal((await env.store.sweep(s, sweepReq())).swept.length, 1);
      const a3 = oneJob(await env.claim(s));
      assert.equal(a3.id, a.job.id);
      assert.ok(a3.token > a2.token, 'larger token after sweep');
      await env.addJobs(s, 10);
      const many = (await env.claim(s, { limit: 10 })).jobs.map((j) => j.token);
      const all = [a.token, a2.token, a3.token, ...many];
      assert.equal(new Set(all).size, all.length, 'tokens are unique across jobs');
    });

    t.test('claim: repeat with the same claimId returns the same jobs with recovered true and claims nothing new', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 4);
      const first = await env.claim(s, { limit: 2, claimId: 'same' });
      const again = await env.claim(s, { limit: 2, claimId: 'same' });
      assert.equal(again.recovered, true);
      assert.deepEqual(ids(again.jobs).sort(), ids(first.jobs).sort());
      for (const j of again.jobs) assert.equal(j.token, first.jobs.find((f) => f.id === j.id)!.token, 'same lease, same token');
      assert.equal((await env.store.counts(s)).waiting, 2, 'nothing new was claimed');
    });

    t.test('claim: repeat with an unknown claimId after nothing was applied is an ordinary claim', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 2);
      const res = await env.claim(s, { claimId: 'never-applied' });
      assert.equal(res.jobs.length, 1);
      assert.equal(res.recovered, undefined);
      assert.equal((await env.store.counts(s)).active, 1);
    });

    t.test('claim: blocked is reported only when jobs is empty, with the first applicable reason', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 2);
      const got = await env.claim(s, { claimId: 'r' });
      assert.equal(got.jobs.length, 1);
      assert.equal(got.blocked, undefined);
      await env.store.setPaused(s, true);
      const recovered = await env.claim(s, { claimId: 'r' });
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.blocked, undefined, 'a recovery returns jobs, so no blocked');
      const blocked = await env.claim(s);
      assert.deepEqual(blocked.jobs, []);
      assert.deepEqual(blocked.blocked, { reason: 'paused' });
      await env.store.setPaused(s, false);
    });

    t.test('claim: result records equal stored records', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 3, { data: 'payload' });
      const res = await env.claim(s, { limit: 3 });
      assert.equal(res.jobs.length, 3);
      for (const j of res.jobs) assert.deepEqual(await get(env, s, j.id), j);
    });

    t.test('claim: limit 0, over max and non-integer throw StoreRequestError', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 1);
      for (const limit of [0, env.caps.limits.maxClaimLimit + 1, 2.5]) await rejectsRequest(env.claim(s, { limit }), `limit ${limit}`);
      assert.equal((await env.store.counts(s)).waiting, 1, 'nothing was claimed');
    });

    t.race('claim: concurrent claimers never receive the same job', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 50);
      const pods = await env.pods(env.concurrency);
      const results = await Promise.all(
        pods.map((p, i) => p.claim(s, { workerId: `w${i}`, limit: 5, leaseMs: env.leaseMs, claimId: `c${i}` })),
      );
      const got = results.flatMap((r) => ids(r.jobs));
      assertUnique(got, 'concurrent claim');
      assert.equal(got.length, Math.min(50, 5 * env.concurrency));
    });

    t.test(
      'claim: 100k jobs each claimed exactly once',
      async (env) => {
        const s = env.scope();
        const total = env.iterations * 500;
        for (let n = 0; n < total; n += 1000) await env.addJobs(s, Math.min(1000, total - n));
        const pods = await env.pods(env.concurrency);
        const got = await claimAll(pods, s, 100, 3_600_000);
        assertUnique(got, 'claim');
        assert.equal(got.length, total);
        assert.equal((await env.store.counts(s)).active, total);
      },
      { timeoutMs: 600_000 },
    );

    t.race('claim: concurrent claim and cancel never leaves a claimed job in a non-active state', async (env, i) => {
      const s = env.scope();
      const jobs = await env.addJobs(s, 6);
      const cancels = () => Promise.all(jobs.map((j) => env.store.cancel(s, { id: j.id })));
      const claim = () => env.claim(s, { limit: 6 });
      const [res, cancelled] = await together(i % 2 === 1, claim, cancels);
      for (const [k, job] of jobs.entries()) {
        const rec = await get(env, s, job.id);
        assert.equal(rec.state, 'cancelled');
        assert.equal(rec.lease, null, 'a cancelled job has no lease');
        const wasClaimed = res.jobs.some((j) => j.id === job.id);
        assert.deepEqual(cancelled[k], { ok: true, previousState: wasClaimed ? 'active' : 'waiting' });
      }
    });

    t.race('claim: concurrent claim and replace never returns a half-applied job', async (env, i) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1, { data: '"old"', priority: 1 });
      const replace = () => env.store.add(s, [env.job({ id: job!.id, data: '"new"', priority: 7, onDuplicate: 'replace' })]);
      const [res, [out]] = await together(i % 2 === 1, () => env.claim(s), replace);
      const claimedJob = oneJob(res);
      if (out?.status === 'duplicate' && out.action === 'ignored') {
        assert.equal(out.existingState, 'active', 'a replace that lost to the claim is ignored');
        assert.deepEqual([claimedJob.data, claimedJob.priority], ['"old"', 1]);
      } else {
        assert.equal(out?.status === 'duplicate' && out.action, 'replaced');
        assert.deepEqual([claimedJob.data, claimedJob.priority], ['"new"', 7], 'the claim sees the whole replace');
      }
      assert.deepEqual(await get(env, s, job!.id), claimedJob);
    });

    t.race('claim: concurrent claim and sweep of an expired job yields at most one holder', async (env, i) => {
      const s = env.scope();
      const first = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      const claim = () => env.claim(s, { workerId: 'w2' });
      const sweep = () => env.store.sweep(s, sweepReq());
      const [res, swept] = await together(i % 2 === 1, claim, sweep);
      assert.equal(swept.swept.length, 1, 'the expired lease is swept exactly once');
      const rec = await get(env, s, first.job.id);
      if (res.jobs.length === 1) {
        assert.equal(rec.state, 'active');
        assert.ok(rec.token > first.token, 'the new holder has a larger token');
        assert.equal(rec.lease?.owner, 'w2');
      } else {
        assert.equal(rec.state, 'waiting');
        assert.equal(rec.lease, null);
      }
    });

    t.test('claim: high-priority job added after low ones is claimed first', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 5, { priority: 0 });
      const [high] = await env.addJobs(s, 1, { priority: 10 });
      assert.deepEqual(ids((await env.claim(s)).jobs), [high!.id]);
    });
  },
};

/** A second scope holding copies of `jobs` (same priorities, same add order), claimed in one call. */
async function claimFresh(env: TestEnv, jobs: JobRecord[]) {
  const s = env.scope();
  for (const j of jobs) await env.store.add(s, [env.job({ id: j.id, priority: j.priority })]);
  return env.claim(s, { limit: jobs.length });
}
