import assert from 'node:assert/strict';
import type { ConformanceGroup } from './types.js';
import { claimed, get, oneJob, rejectsRequest } from './util.js';

export const progressGroup: ConformanceGroup = {
  name: 'progress',
  mode: 'fake',
  register(t) {
    t.test('progress: write with current token is stored with store-time updatedAt', async (env) => {
      const s = env.scope();
      const { job, token, now: claimedAt } = await claimed(env, s);
      await env.elapse(250);
      const res = await env.store.setProgress(s, { id: job.id, token, progress: 'p1' });
      assert.ok(res.ok, 'the write is accepted');
      assert.equal(res.now, claimedAt + 250);
      let rec = await get(env, s, job.id);
      assert.deepEqual(rec.progress, { value: 'p1', updatedAt: res.now });
      assert.equal(rec.batchProgress, null);
      const b = await env.store.setProgress(s, { id: job.id, token, progress: 'b1', field: 'batchProgress' });
      assert.ok(b.ok);
      rec = await get(env, s, job.id);
      assert.equal(rec.batchProgress?.value, 'b1');
      assert.deepEqual(rec.progress, { value: 'p1', updatedAt: res.now }, 'the other field is unchanged');
      const bytes = new Uint8Array([0, 1, 254, 255]);
      assert.ok((await env.store.setProgress(s, { id: job.id, token, progress: bytes })).ok);
      assert.deepEqual((await get(env, s, job.id)).progress?.value, bytes);
    });

    t.test('progress: write with stale token is rejected and changes nothing', async (env) => {
      const s = env.scope();
      const { job, token: first } = await claimed(env, s);
      assert.ok((await env.store.setProgress(s, { id: job.id, token: first, progress: 'old' })).ok);
      await env.store.release(s, { id: job.id, token: first, refundAttempt: true, handlerStarted: true });
      const second = oneJob(await env.claim(s)).token;
      const rejects = async (token: number, reason: string, what: string) => {
        const before = await get(env, s, job.id);
        assert.deepEqual(await env.store.setProgress(s, { id: job.id, token, progress: 'stale' }), { ok: false, reason }, what);
        assert.deepEqual(await get(env, s, job.id), before, `${what}: the record is unchanged`);
      };
      await rejects(first, 'superseded', 'an older token');
      await env.elapse(env.leaseMs + 1);
      await rejects(second, 'expired', 'an expired lease');
      await env.store.cancel(s, { id: job.id });
      await rejects(second, 'not-active', 'a cancelled job');
    });

    t.test('progress: new claim resets progress to null', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await env.store.setProgress(s, { id: job.id, token, progress: 'p' });
      await env.store.setProgress(s, { id: job.id, token, progress: 'b', field: 'batchProgress' });
      await env.store.release(s, { id: job.id, token, refundAttempt: true, handlerStarted: true });
      const again = oneJob(await env.claim(s));
      assert.deepEqual([again.progress, again.batchProgress], [null, null], 'the claimed record');
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.progress, rec.batchProgress], [null, null], 'the stored record');
      const res = await env.store.setProgress(s, { id: job.id, token: again.token, progress: 'last' });
      assert.ok(res.ok);
      await env.store.complete(s, { id: job.id, token: again.token, result: null });
      assert.deepEqual((await get(env, s, job.id)).progress, { value: 'last', updatedAt: res.now }, 'finish keeps the last value');
    });

    t.test('progress: batch jobs are written independently with their own tokens', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 3);
      const { jobs } = await env.claim(s, { limit: 3 });
      assert.equal(jobs.length, 3);
      const res = await Promise.all(jobs.map((j) => env.store.setProgress(s, { id: j.id, token: j.token, progress: 'b', field: 'batchProgress' })));
      assert.ok(res.every((r) => r.ok), 'every write is accepted');
      for (const j of jobs) assert.equal((await get(env, s, j.id)).batchProgress?.value, 'b');
      const [a, b] = jobs;
      const before = await get(env, s, a!.id);
      const wrong = await env.store.setProgress(s, { id: a!.id, token: b!.token, progress: 'x', field: 'batchProgress' });
      assert.ok(!wrong.ok && (wrong.reason === 'not-active' || wrong.reason === 'superseded'), 'another job\'s token is refused');
      assert.deepEqual(await get(env, s, a!.id), before);
    });

    t.test('progress: malformed requests are refused', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const before = await get(env, s, job.id);
      const bad = (req: unknown) => env.store.setProgress(s, req as never);
      await rejectsRequest(bad({ id: job.id, progress: 'p' }), 'a missing token');
      await rejectsRequest(bad({ id: job.id, token, progress: 42 }), 'a progress that is not a payload');
      await rejectsRequest(bad({ id: job.id, token, progress: 'p', field: 'other' }), 'an unknown field name');
      assert.deepEqual(await get(env, s, job.id), before);
    });
  },
};
