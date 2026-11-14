import assert from 'node:assert/strict';
import type { ConformanceGroup } from './types.js';
import { claimed, get, STATES, together } from './util.js';

export const cancelGroup: ConformanceGroup = {
  name: 'cancel',
  mode: 'fake',
  register(t) {
    t.test('cancel: waiting and delayed jobs become cancelled and never run', async (env) => {
      const s = env.scope();
      const [waiting] = await env.addJobs(s, 1);
      const [delayed] = await env.addJobs(s, 1, { delayMs: 1000 });
      assert.deepEqual(await env.store.cancel(s, { id: waiting!.id }), { ok: true, previousState: 'waiting' });
      assert.deepEqual(await env.store.cancel(s, { id: delayed!.id }), { ok: true, previousState: 'delayed' });
      await env.elapse(1001);
      assert.deepEqual((await env.claim(s, { limit: 10 })).jobs, []);
      for (const j of [waiting!, delayed!]) assert.equal((await get(env, s, j.id)).state, 'cancelled');
    });

    t.test('cancel: active job becomes cancelled immediately and lease is cleared', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      assert.deepEqual(await env.store.cancel(s, { id: job.id }), { ok: true, previousState: 'active' });
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.lease], ['cancelled', null]);
      assert.deepEqual(await env.store.complete(s, { id: job.id, token, result: null }), { ok: false, reason: 'not-active' });
    });

    t.test('cancel: terminal job returns already-terminal with its state', async (env) => {
      const s = env.scope();
      const done = await claimed(env, s);
      await env.store.complete(s, { id: done.job.id, token: done.token, result: null });
      const failed = await claimed(env, s);
      await env.store.fail(s, { id: failed.job.id, token: failed.token, error: 'e' });
      assert.deepEqual(await env.store.cancel(s, { id: done.job.id }), { ok: false, reason: 'already-terminal', state: 'completed' });
      assert.deepEqual(await env.store.cancel(s, { id: failed.job.id }), { ok: false, reason: 'already-terminal', state: 'failed' });
      assert.equal((await get(env, s, done.job.id)).state, 'completed');
    });

    t.test('cancel: unknown id returns not-found', async (env) => {
      const res = await env.store.cancel(env.scope(), { id: 'missing' });
      assert.deepEqual({ ok: res.ok, reason: !res.ok && res.reason }, { ok: false, reason: 'not-found' });
    });

    t.race('cancel: concurrent cancel and complete with a valid token — exactly one wins', async (env, i) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const [cancel, complete] = await together(
        i % 2 === 1,
        () => env.store.cancel(s, { id: job.id }),
        () => env.store.complete(s, { id: job.id, token, result: 'r' }),
      );
      assert.notEqual(cancel.ok, complete.ok, 'exactly one of cancel and complete wins');
      assert.equal((await get(env, s, job.id)).state, cancel.ok ? 'cancelled' : 'completed');
    });

    t.race('cancel: concurrent cancel and claim leave a consistent state', async (env, i) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1);
      const [cancel, res] = await together(i % 2 === 1, () => env.store.cancel(s, { id: job!.id }), () => env.claim(s));
      const won = res.jobs.length === 1;
      assert.deepEqual(cancel, { ok: true, previousState: won ? 'active' : 'waiting' });
      const rec = await get(env, s, job!.id);
      assert.deepEqual([rec.state, rec.lease], ['cancelled', null]);
    });

    t.test('cancel: frees pending id and singleton key', async (env) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1);
      await env.store.cancel(s, { id: job!.id });
      assert.equal((await get(env, s, job!.id)).state, 'cancelled');
      const c = await env.store.counts(s);
      assert.deepEqual([c.waiting, c.cancelled], [0, 1]);
    });

    t.test('cancel: counts move atomically between states', async (env) => {
      const s = env.scope();
      const jobs = await env.addJobs(s, 20);
      await env.claim(s, { limit: 5 });
      let done = false;
      const sums: number[] = [];
      const reader = (async () => {
        while (!done) {
          const c = await env.store.counts(s);
          sums.push(STATES.reduce((n, st) => n + c[st], 0));
        }
      })();
      await Promise.all(jobs.map((j) => env.store.cancel(s, { id: j.id })));
      done = true;
      await reader;
      assert.ok(sums.length > 0);
      assert.deepEqual([...new Set(sums)], [20], 'every counts read sums to the same total');
      assert.equal((await env.store.counts(s)).cancelled, 20);
    });
  },
};
