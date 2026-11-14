import assert from 'node:assert/strict';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, deleteJob, get, sweepReq, together, oneJob } from './util.js';

const release = { refundAttempt: false, handlerStarted: true } as const;

export const fencingGroup: ConformanceGroup = {
  name: 'fencing',
  mode: 'fake',
  register(t) {
    t.test('fencing: re-claim after sweep issues a larger token than the first claim', async (env) => {
      const s = env.scope();
      const first = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      assert.equal((await env.store.sweep(s, sweepReq())).swept.length, 1);
      const again = (await env.claim(s)).jobs[0];
      assert.equal(again?.id, first.job.id);
      assert.ok(again.token > first.token, `token ${again.token} is above ${first.token}`);
    });

    t.test('fencing: tokens are unique per queue across jobs and never reused after remove, clean or forced obliterate', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 50);
      const res = await env.claim(s, { limit: 50 });
      const tokens = res.jobs.map((j) => j.token);
      assert.equal(new Set(tokens).size, 50, 'every claimed job has its own token');
      const gone = oneJob(res);
      await env.store.cancel(s, { id: gone.id });
      assert.equal((await env.store.remove(s, { id: gone.id })).removed, true);
      await env.addJobs(s, 1, { id: gone.id });
      const again = (await env.claim(s)).jobs[0];
      assert.equal(again?.id, gone.id);
      assert.ok(again.token > Math.max(...tokens), 'the re-added id gets a token above every token seen');
      tokens.push(again.token);
      for (const how of ['clean', 'obliterate'] as const) {
        await deleteJob(env, s, gone.id, how);
        await env.addJobs(s, 1, { id: gone.id });
        const next = (await env.claim(s, { limit: 50 })).jobs.find((j) => j.id === gone.id);
        assert.ok(next && next.token > Math.max(...tokens), `${how}: the re-added id gets a token above every token seen`);
        tokens.push(next.token);
      }
    });

    t.test('fencing: stale token from a previous incarnation of a reused id is rejected', async (env) => {
      const s = env.scope();
      const old = await claimed(env, s);
      await env.store.cancel(s, { id: old.job.id });
      await env.store.remove(s, { id: old.job.id });
      const next = await claimed(env, s, { id: old.job.id });
      assert.ok(next.token > old.token, 'the new incarnation has a larger token');
      assert.deepEqual(await env.store.complete(s, { id: old.job.id, token: old.token, result: null }), { ok: false, reason: 'superseded' });
      assert.equal((await env.store.complete(s, { id: old.job.id, token: next.token, result: null })).ok, true);
    });

    t.test('fencing: complete, fail and release repeated with the finalising token return the original outcome with repeated true', async (env) => {
      const s = env.scope();
      const c = await claimed(env, s);
      await env.store.complete(s, { id: c.job.id, token: c.token, result: 'r' });
      const cAgain = await env.store.complete(s, { id: c.job.id, token: c.token, result: 'r' });
      assert.ok(cAgain.ok && cAgain.repeated === true, 'complete repeat');
      const f = await claimed(env, s);
      const fFirst = await env.store.fail(s, { id: f.job.id, token: f.token, error: 'e' });
      const fAgain = await env.store.fail(s, { id: f.job.id, token: f.token, error: 'e' });
      assert.ok(fFirst.ok && fAgain.ok && fAgain.repeated === true, 'fail repeat');
      assert.equal(fAgain.state, fFirst.state);
      const r = await claimed(env, s);
      const rFirst = await env.store.release(s, { id: r.job.id, token: r.token, delayMs: 10_000, ...release });
      const rAgain = await env.store.release(s, { id: r.job.id, token: r.token, delayMs: 10_000, ...release });
      assert.ok(rFirst.ok && rAgain.ok && rAgain.repeated === true, 'release repeat');
      assert.deepEqual([rAgain.state, rAgain.runAt], [rFirst.state, rFirst.runAt]);
    });

    t.test('fencing: complete with current token succeeds', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const res = await env.store.complete(s, { id: job.id, token, result: 'ok' });
      assert.equal(res.ok, true);
      assert.equal(res.ok && res.repeated, undefined);
      assert.equal((await get(env, s, job.id)).state, 'completed');
    });

    t.test('fencing: complete with old token after re-claim is rejected as superseded', async (env) => {
      const s = env.scope();
      const first = await claimed(env, s);
      await env.store.release(s, { id: first.job.id, token: first.token, ...release });
      const again = oneJob(await env.claim(s));
      const before = await get(env, s, first.job.id);
      assert.deepEqual(await env.store.complete(s, { id: first.job.id, token: first.token, result: null }), { ok: false, reason: 'superseded' });
      assert.deepEqual(await get(env, s, first.job.id), before);
      assert.equal(before.token, again.token);
    });

    t.test('fencing: complete after expiry but before sweep is rejected as expired', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      assert.deepEqual(await env.store.complete(s, { id: job.id, token, result: null }), { ok: false, reason: 'expired' });
      assert.equal((await get(env, s, job.id)).state, 'active');
    });

    t.test('fencing: renew, fail and release with stale token are all rejected and change nothing', async (env) => {
      const s = env.scope();
      const first = await claimed(env, s);
      await env.store.release(s, { id: first.job.id, token: first.token, ...release });
      await env.claim(s);
      const before = await get(env, s, first.job.id);
      const id = first.job.id;
      const token = first.token;
      assert.deepEqual(await env.store.renew(s, { id, token, leaseMs: env.leaseMs }), { ok: false, reason: 'superseded' });
      assert.deepEqual(await env.store.fail(s, { id, token, error: 'e', retryInMs: 10 }), { ok: false, reason: 'superseded' });
      assert.deepEqual(await env.store.release(s, { id, token, delayMs: 10, ...release }), { ok: false, reason: 'superseded' });
      assert.deepEqual(await get(env, s, id), before);
    });

    t.test('fencing: token never decreases and is kept after the job finishes', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      const tokens = [a.token];
      await env.store.release(s, { id: a.job.id, token: a.token, refundAttempt: true, handlerStarted: false });
      tokens.push(oneJob(await env.claim(s)).token);
      await env.elapse(env.leaseMs + 1);
      await env.store.sweep(s, sweepReq());
      const last = oneJob(await env.claim(s));
      tokens.push(last.token);
      for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i]! > tokens[i - 1]!, `each claim raises the token: ${tokens.join(', ')}`);
      await env.store.complete(s, { id: a.job.id, token: last.token, result: null });
      assert.equal((await get(env, s, a.job.id)).token, last.token, 'the token is kept after complete');
    });

    t.test('fencing: rejection order is superseded, then not-active, then expired', async (env) => {
      const s = env.scope();
      // stale and finished: superseded comes before not-active
      const a = await claimed(env, s);
      await env.store.release(s, { id: a.job.id, token: a.token, ...release });
      const a2 = oneJob(await env.claim(s));
      await env.store.complete(s, { id: a.job.id, token: a2.token, result: null });
      // finished after its lease ran out: not-active comes before expired
      const b = await claimed(env, s);
      // live but run out: expired
      const c = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      await env.store.cancel(s, { id: b.job.id });
      const renew = (id: string, token: number) => env.store.renew(s, { id, token, leaseMs: env.leaseMs });
      assert.deepEqual(await renew(a.job.id, a.token), { ok: false, reason: 'superseded' });
      assert.deepEqual(await renew(b.job.id, b.token), { ok: false, reason: 'not-active' });
      assert.deepEqual(await renew(c.job.id, c.token), { ok: false, reason: 'expired' });
    });

    t.test('fencing: complete on cancelled job is rejected as not-active', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      await env.store.cancel(s, { id: job.id });
      assert.deepEqual(await env.store.complete(s, { id: job.id, token, result: null }), { ok: false, reason: 'not-active' });
      assert.deepEqual(await env.store.fail(s, { id: job.id, token, error: 'e', retryInMs: 10 }), { ok: false, reason: 'not-active' });
      assert.deepEqual(
        await env.store.release(s, { id: job.id, token, refundAttempt: false, handlerStarted: true }),
        { ok: false, reason: 'not-active' },
      );
      assert.equal((await get(env, s, job.id)).state, 'cancelled');
    });

    t.race('fencing: concurrent stale complete and fresh claim — exactly one wins', async (env, i) => {
      const s = env.scope();
      const first = await claimed(env, s);
      const expired = i % 2 === 0;
      if (expired) {
        await env.elapse(env.leaseMs + 1);
        assert.equal((await env.store.sweep(s, sweepReq())).swept.length, 1);
      }
      const [done, res] = await together(
        i % 4 >= 2,
        () => env.store.complete(s, { id: first.job.id, token: first.token, result: 'stale' }),
        () => env.claim(s, { workerId: 'w2' }),
      );
      const rec = await get(env, s, first.job.id);
      assert.notEqual(done.ok, res.jobs.length === 1, 'exactly one of the stale complete and the fresh claim wins');
      if (done.ok) {
        assert.equal(rec.state, 'completed');
        assert.equal(rec.lease, null);
      } else {
        assert.equal(rec.state, 'active');
        assert.ok(rec.token > first.token);
        assert.equal(rec.lease?.owner, 'w2');
      }
      assert.equal(done.ok, !expired, 'only a live lease can complete');
    });

    t.test('fencing: sweep does not undo a renew that landed first', sweepDoesNotUndoRenew);

    t.test('fencing: expiry is judged by store time when pod clock is skewed ±1h', async (env) => {
      const s = env.scope();
      for (const skew of [3_600_000, -3_600_000]) {
        await env.skewPodClock(skew, async () => {
          const fresh = await claimed(env, s);
          assert.equal((await env.store.renew(s, { id: fresh.job.id, token: fresh.token, leaseMs: env.leaseMs })).ok, true, `fresh lease is live (skew ${skew})`);
          await env.store.complete(s, { id: fresh.job.id, token: fresh.token, result: null });
          const old = await claimed(env, s);
          await env.elapse(env.leaseMs + 1);
          assert.deepEqual(await env.store.complete(s, { id: old.job.id, token: old.token, result: null }), { ok: false, reason: 'expired' });
          await env.store.cancel(s, { id: old.job.id });
        });
      }
    });
  },
};

/** Fake clock: a sweep started one millisecond before expiry must not requeue a job whose renew landed first. */
export async function sweepDoesNotUndoRenew(env: TestEnv): Promise<void> {
  const s = env.scope();
  const { job, token } = await claimed(env, s);
  const clock = env.clock;
  if (clock) clock.advance(job.lease!.expiresAt - 1 - clock.now());
  else await env.elapse(env.leaseMs - 100 * env.timeScale);
  const sweep = env.store.sweep(s, sweepReq());
  const renewed = await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs });
  assert.ok(renewed.ok, 'the renew lands before expiry');
  if (clock) clock.advance(2);
  await sweep;
  const rec = await get(env, s, job.id);
  assert.equal(rec.state, 'active');
  assert.equal(rec.lease?.expiresAt, renewed.expiresAt);
  assert.equal(rec.crashCount, 0);
}
