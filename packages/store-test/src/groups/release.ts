import assert from 'node:assert/strict';
import type { ConformanceGroup } from './types.js';
import { claimed, get, sweepReq, together, oneJob } from './util.js';

const keep = { refundAttempt: false, handlerStarted: true } as const;

export const releaseGroup: ConformanceGroup = {
  name: 'release',
  mode: 'fake',
  register(t) {
    t.test('release: returns job to waiting, clears lease, decrements attempt', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const res = await env.store.release(s, { id: job.id, token, refundAttempt: true, handlerStarted: false });
      assert.ok(res.ok && res.state === 'waiting');
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.lease, rec.attempt], ['waiting', null, job.attempt - 1]);
    });

    t.test('release: release leaves crashCount unchanged', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      await env.store.release(s, { id: a.job.id, token: a.token, ...keep });
      assert.equal((await get(env, s, a.job.id)).crashCount, 0);
      const b = oneJob(await env.claim(s));
      await env.elapse(env.leaseMs + 1);
      await env.store.sweep(s, sweepReq());
      const c = oneJob(await env.claim(s));
      assert.equal(c.id, b.id);
      await env.store.release(s, { id: c.id, token: c.token, refundAttempt: true, handlerStarted: false });
      assert.equal((await get(env, s, c.id)).crashCount, 1);
    });

    t.test('release: repeat with the same token returns the original outcome with repeated true and changes nothing', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const first = await env.store.release(s, { id: job.id, token, delayMs: 5000, ...keep });
      const rec = await get(env, s, job.id);
      const again = await env.store.release(s, { id: job.id, token, delayMs: 5000, ...keep });
      assert.ok(first.ok && again.ok);
      assert.equal(again.repeated, true);
      assert.deepEqual([again.state, again.runAt], [first.state, first.runAt]);
      assert.deepEqual(await get(env, s, job.id), rec);
    });

    t.test('release: stale token is rejected and changes nothing', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      await env.store.release(s, { id: a.job.id, token: a.token, ...keep });
      await env.claim(s);
      const before = await get(env, s, a.job.id);
      assert.deepEqual(await env.store.release(s, { id: a.job.id, token: a.token, ...keep }), { ok: false, reason: 'superseded' });
      assert.deepEqual(await get(env, s, a.job.id), before);
      // a lease that ran out is stale too
      await env.elapse(env.leaseMs + 1);
      const expired = await get(env, s, a.job.id);
      assert.deepEqual(await env.store.release(s, { id: a.job.id, token: expired.token, ...keep }), { ok: false, reason: 'expired' });
      assert.deepEqual(await get(env, s, a.job.id), expired);
    });

    t.race('release: concurrent sweep and release leave exactly one state transition', async (env, i) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const expired = i % 2 === 0;
      if (expired) await env.elapse(env.leaseMs + 1);
      const [rel, res] = await together(
        i % 4 >= 2,
        () => env.store.release(s, { id: job.id, token, ...keep }),
        () => env.store.sweep(s, sweepReq()),
      );
      assert.notEqual(rel.ok, res.swept.length === 1, 'exactly one of release and sweep acts');
      if (rel.ok) assert.equal(rel.repeated, undefined, 'a first release is not a repeat');
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.crashCount], ['waiting', rel.ok ? 0 : 1]);
    });
  },
};
