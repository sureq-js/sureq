import assert from 'node:assert/strict';
import type { ConformanceGroup } from './types.js';
import { claimed, get, rejectsRequest, sweepReq } from './util.js';

export const batchGroup: ConformanceGroup = {
  name: 'batch',
  mode: 'fake',
  register(t) {
    t.test('batch: claim with limit returns distinct tokens per job', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 5);
      const res = await env.claim(s, { limit: 5, hold: true });
      assert.equal(res.jobs.length, 5);
      const tokens = res.jobs.map((j) => j.lease!.token);
      for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i]! > tokens[i - 1]!, 'tokens increase in claim order');
      for (const j of res.jobs) assert.equal((await get(env, s, j.id)).lease?.token, j.token);
    });

    t.test('batch: renew of one job does not extend another', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 2);
      const [a, b] = (await env.claim(s, { limit: 2, hold: true })).jobs;
      await env.elapse(env.leaseMs / 2);
      assert.ok((await env.store.renew(s, { id: a!.id, token: a!.token, leaseMs: env.leaseMs })).ok);
      assert.equal((await get(env, s, b!.id)).lease?.expiresAt, b!.lease!.expiresAt);
      await env.elapse(env.leaseMs / 2 + 1);
      assert.deepEqual(await env.store.renew(s, { id: b!.id, token: b!.token, leaseMs: env.leaseMs }), { ok: false, reason: 'expired' });
      assert.ok((await env.store.renew(s, { id: a!.id, token: a!.token, leaseMs: env.leaseMs })).ok, 'the renewed job is still live');
    });

    t.test('batch: claim with hold marks the lease held and renew with started clears it', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s, {}, { hold: true });
      assert.equal((await get(env, s, job.id)).lease?.held, true);
      assert.ok((await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs, started: true })).ok);
      const started = (await get(env, s, job.id)).lease!;
      assert.notEqual(started.held, true);
      assert.deepEqual([started.owner, started.token], [job.lease!.owner, token]);
      assert.ok((await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs })).ok);
      assert.notEqual((await get(env, s, job.id)).lease?.held, true);
    });

    t.test('batch: claim without hold leaves the lease unheld', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s);
      assert.notEqual((await get(env, s, job.id)).lease?.held, true);
    });

    t.test('batch: an expired held lease is swept as a refunded release without crashCount', async (env) => {
      const s = env.scope();
      for (const maxAttempts of [3, 1]) {
        const { job, token } = await claimed(env, s, { maxAttempts }, { hold: true });
        await env.elapse(env.leaseMs + 1);
        const res = await env.store.sweep(s, sweepReq());
        assert.deepEqual(res.swept.map((j) => [j.id, j.action, j.attempt, j.crashCount]), [[job.id, 'requeued', 0, 0]], `maxAttempts ${maxAttempts}`);
        const rec = await get(env, s, job.id);
        assert.deepEqual([rec.state, rec.attempt, rec.crashCount, rec.lease, rec.token], ['waiting', 0, 0, null, token]);
        const again = (await env.claim(s)).jobs[0];
        assert.deepEqual([again?.id, again?.attempt], [job.id, 1]);
        await env.store.complete(s, { id: job.id, token: again!.token, result: null });
      }
    });

    t.test('batch: an expired lease after started is swept as an ordinary crash', async (env) => {
      const s = env.scope();
      for (const [maxAttempts, action] of [[3, 'requeued'], [1, 'failed']] as const) {
        const { job, token } = await claimed(env, s, { maxAttempts }, { hold: true });
        await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs, started: true });
        await env.elapse(env.leaseMs + 1);
        const res = await env.store.sweep(s, sweepReq());
        assert.deepEqual(res.swept.map((j) => [j.action, j.attempt, j.crashCount]), [[action, 1, 1]], `maxAttempts ${maxAttempts}`);
        if (action === 'requeued') {
          const again = (await env.claim(s)).jobs[0]!;
          await env.store.complete(s, { id: job.id, token: again.token, result: null });
        }
      }
    });

    t.test('batch: renew with started and batchId writes them to the open attempt record', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s, {}, { hold: true });
      await env.elapse(500);
      await rejectsRequest(env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs, batchId: 'b1' }), 'batchId without started');
      const before = (await env.store.getAttempts(s, { id: job.id })).attempts;
      assert.deepEqual(before.map((r) => [r.batchId, r.heldMs]), [[null, null]], 'the refused renew wrote nothing');
      assert.ok((await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs, started: true, batchId: 'b1' })).ok);
      const rows = (await env.store.getAttempts(s, { id: job.id })).attempts;
      assert.deepEqual(rows.map((r) => [r.token, r.outcome, r.batchId, r.heldMs]), [[token, 'running', 'b1', 500]]);
      await env.elapse(100);
      assert.ok((await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs })).ok);
      const later = (await env.store.getAttempts(s, { id: job.id })).attempts;
      assert.deepEqual(later.map((r) => [r.batchId, r.heldMs]), [['b1', 500]], 'a later renew keeps them');
    });

    t.test('batch: a swept held lease closes its attempt as released', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s, {}, { hold: true });
      await env.elapse(env.leaseMs + 1);
      const { now } = await env.store.sweep(s, sweepReq());
      const rows = (await env.store.getAttempts(s, { id: job.id })).attempts;
      assert.deepEqual(rows.map((r) => [r.token, r.outcome, r.endedBy, r.finishedAt, r.error]), [[token, 'released', 'sweeper', now, null]]);
    });

    t.test('batch: a non-boolean hold or started is a StoreRequestError', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 1);
      await rejectsRequest(env.claim(s, { hold: 'yes' as never }));
      assert.equal((await env.store.counts(s)).waiting, 1, 'the bad claim took nothing');
      const job = (await env.claim(s, { hold: true })).jobs[0]!;
      await rejectsRequest(env.store.renew(s, { id: job.id, token: job.token, leaseMs: env.leaseMs, started: 1 as never }));
      assert.deepEqual(await get(env, s, job.id), job);
    });
  },
};
