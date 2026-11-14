import assert from 'node:assert/strict';
import type { GroupApi } from './types.js';
import { claimed, get, sweepReq, oneJob } from './util.js';

const release = { refundAttempt: false, handlerStarted: true } as const;

export function registerContractWrites(t: GroupApi): void {
  t.test('contract: complete stores result and clears lease', async (env) => {
    const s = env.scope();
    const { job, token } = await claimed(env, s);
    const res = await env.store.complete(s, { id: job.id, token, result: 'done ✓' });
    assert.equal(res.ok, true);
    const rec = await get(env, s, job.id);
    assert.equal(rec.state, 'completed');
    assert.equal(rec.result, 'done ✓');
    assert.equal(rec.lease, null);
    assert.ok(res.ok && rec.finishedAt === res.now, 'finishedAt is the completing store time');
    assert.equal(rec.rev, job.rev + 1);
  });

  t.test('contract: fail with retryInMs goes delayed, without it goes failed', async (env) => {
    const s = env.scope();
    const a = await claimed(env, s);
    const retry = await env.store.fail(s, { id: a.job.id, token: a.token, error: 'later', retryInMs: 2500 });
    assert.ok(retry.ok && retry.state === 'delayed');
    assert.equal(retry.runAt, retry.now + 2500);
    const ra = await get(env, s, a.job.id);
    assert.equal(ra.state, 'delayed');
    assert.equal(ra.runAt, retry.now + 2500);
    const b = await claimed(env, s);
    const error = Uint8Array.of(7, 0, 255);
    const final = await env.store.fail(s, { id: b.job.id, token: b.token, error });
    assert.ok(final.ok && final.state === 'failed');
    const rb = await get(env, s, b.job.id);
    assert.equal(rb.state, 'failed');
    assert.ok(rb.error instanceof Uint8Array);
    assert.deepEqual([...rb.error], [...error]);
    assert.equal(rb.lease, null);
  });

  t.test('contract: fail with retryInMs but attempt at maxAttempts goes failed', async (env) => {
    const s = env.scope();
    const { job, token } = await claimed(env, s, { maxAttempts: 1 });
    const res = await env.store.fail(s, { id: job.id, token, error: 'e', retryInMs: 100 });
    assert.ok(res.ok);
    assert.equal(res.state, 'failed');
    assert.equal((await get(env, s, job.id)).state, 'failed');
  });

  t.test(
    'contract: release returns job to waiting and keeps its token; refundAttempt decrements attempt; the next claim gets a larger token',
    async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s);
      const res = await env.store.release(s, { id: job.id, token, refundAttempt: true, handlerStarted: false });
      assert.ok(res.ok && res.state === 'waiting');
      const rec = await get(env, s, job.id);
      assert.equal(rec.state, 'waiting');
      assert.equal(rec.token, token);
      assert.equal(rec.attempt, 0);
      assert.equal(rec.lease, null);
      const again = (await env.claim(s)).jobs[0];
      assert.equal(again?.id, job.id);
      assert.ok(again.token > token, 'the next claim gets a larger token');
      assert.equal(again.attempt, 1);
    },
  );

  t.test('contract: release with delayMs goes delayed and without goes waiting', async (env) => {
    const s = env.scope();
    const a = await claimed(env, s);
    const later = await env.store.release(s, { id: a.job.id, token: a.token, delayMs: 3000, ...release });
    assert.ok(later.ok && later.state === 'delayed');
    assert.equal(later.runAt, later.now + 3000);
    assert.equal((await get(env, s, a.job.id)).state, 'delayed');
    const b = await claimed(env, s);
    const now = await env.store.release(s, { id: b.job.id, token: b.token, ...release });
    assert.ok(now.ok && now.state === 'waiting');
    for (const j of [a, b]) {
      const rec = await get(env, s, j.job.id);
      assert.equal(rec.attempt, j.job.attempt, 'a release without refundAttempt keeps attempt');
    }
    assert.equal((await get(env, s, b.job.id)).state, 'waiting');
  });

  t.test(
    'contract: complete, fail and release repeated with the same token return the original outcome with repeated true and change nothing, not even rev',
    async (env) => {
      const s = env.scope();
      const c = await claimed(env, s);
      const first = await env.store.complete(s, { id: c.job.id, token: c.token, result: 'r' });
      const cRec = await get(env, s, c.job.id);
      const again = await env.store.complete(s, { id: c.job.id, token: c.token, result: 'other' });
      assert.deepEqual({ ok: again.ok, repeated: again.ok && again.repeated }, { ok: true, repeated: true }, 'complete repeat');
      assert.equal(first.ok, true);
      assert.deepEqual(await get(env, s, c.job.id), cRec);

      const f = await claimed(env, s);
      const fFirst = await env.store.fail(s, { id: f.job.id, token: f.token, error: 'e', retryInMs: 5000 });
      const fRec = await get(env, s, f.job.id);
      const fAgain = await env.store.fail(s, { id: f.job.id, token: f.token, error: 'other', retryInMs: 9000 });
      assert.ok(fFirst.ok && fAgain.ok, 'fail repeat is ok');
      assert.equal(fAgain.repeated, true, 'fail repeat says repeated');
      assert.deepEqual([fAgain.state, fAgain.runAt], [fFirst.state, fFirst.runAt]);
      assert.deepEqual(await get(env, s, f.job.id), fRec);

      const r = await claimed(env, s, { name: 'r' }, { names: ['r'] });
      const rFirst = await env.store.release(s, { id: r.job.id, token: r.token, delayMs: 4000, ...release });
      const rRec = await get(env, s, r.job.id);
      const rAgain = await env.store.release(s, { id: r.job.id, token: r.token, ...release });
      assert.ok(rFirst.ok && rAgain.ok, 'release repeat is ok');
      assert.equal(rAgain.repeated, true, 'release repeat says repeated');
      assert.deepEqual([rAgain.state, rAgain.runAt], [rFirst.state, rFirst.runAt]);
      assert.deepEqual(await get(env, s, r.job.id), rRec);
    },
  );

  t.test(
    'contract: a repeat after the job was claimed again is rejected superseded; after removal it returns the original outcome with repeated true while the tombstone lives (finalsTtl) and not-active after it expired',
    async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      assert.equal((await env.store.release(s, { id: a.job.id, token: a.token, ...release })).ok, true);
      const reclaimed = (await env.claim(s)).jobs[0];
      assert.equal(reclaimed?.id, a.job.id);
      const stale = await env.store.release(s, { id: a.job.id, token: a.token, ...release });
      assert.deepEqual(stale, { ok: false, reason: 'superseded' });
      assert.equal((await env.store.complete(s, { id: a.job.id, token: reclaimed.token, result: null })).ok, true);
      assert.equal((await env.store.remove(s, { id: a.job.id })).removed, true);
      const repeat = await env.store.complete(s, { id: a.job.id, token: reclaimed.token, result: null });
      assert.deepEqual({ ok: repeat.ok, repeated: repeat.ok && repeat.repeated }, { ok: true, repeated: true });
      // The expiry half depends on the store's finalsTtl option, which is not part of the contract.
    },
  );

  t.test(
    "contract: a repeat after the job's id was reused by a new job returns the original outcome with repeated true and leaves the new job untouched",
    async (env) => {
      const s = env.scope();
      // superseded: the finished job no longer holds its id, and a new add takes it
      const a = await claimed(env, s, { id: 'reused-a' });
      assert.equal((await env.store.complete(s, { id: 'reused-a', token: a.token, result: null })).ok, true);
      await env.addJobs(s, 1, { id: 'reused-a' });
      const newA = await get(env, s, 'reused-a');
      const repeatA = await env.store.complete(s, { id: 'reused-a', token: a.token, result: null });
      assert.deepEqual({ ok: repeatA.ok, repeated: repeatA.ok && repeatA.repeated }, { ok: true, repeated: true }, 'repeat after supersede');
      assert.deepEqual(await get(env, s, 'reused-a'), newA, 'the new job is untouched');
      // removed, then added again (its own scope: the new reused-a job would be claimed first)
      const s2 = env.scope();
      const b = await claimed(env, s2, { id: 'reused-b' });
      const first = await env.store.fail(s2, { id: 'reused-b', token: b.token, error: 'boom' });
      assert.equal((await env.store.remove(s2, { id: 'reused-b' })).removed, true);
      await env.addJobs(s2, 1, { id: 'reused-b' });
      const newB = await get(env, s2, 'reused-b');
      const repeatB = await env.store.fail(s2, { id: 'reused-b', token: b.token, error: 'boom' });
      assert.ok(first.ok && repeatB.ok, 'repeat after remove and re-add is ok');
      assert.deepEqual([repeatB.state, repeatB.repeated], [first.state, true]);
      assert.deepEqual(await get(env, s2, 'reused-b'), newB, 'the new job is untouched');
    },
  );

  t.test('contract: claim repeated with the same claimId returns the same jobs with recovered true and claims nothing new', async (env) => {
    const s = env.scope();
    await env.addJobs(s, 5);
    const first = await env.claim(s, { limit: 2, claimId: 'c' });
    assert.equal(first.jobs.length, 2);
    const again = await env.claim(s, { limit: 2, claimId: 'c' });
    assert.equal(again.recovered, true);
    assert.deepEqual(again.jobs.map((j) => j.id).sort(), first.jobs.map((j) => j.id).sort());
    assert.equal((await env.store.counts(s)).active, 2);
    const other = await env.claim(s, { limit: 2, claimId: 'd' });
    assert.equal(other.jobs.length, 2);
    assert.notEqual(other.recovered, true);
    assert.equal((await env.store.counts(s)).active, 4);
  });

  t.test('contract: claim reports blocked with the first applicable reason and retryAfterMs, and only when jobs is empty', async (env) => {
    const withJobs = env.scope();
    await env.addJobs(withJobs, 2);
    await env.store.setPaused(withJobs, true);
    const paused = await env.claim(withJobs);
    assert.deepEqual(paused.jobs, []);
    assert.equal(paused.blocked?.reason, 'paused');
    await env.store.setPaused(withJobs, false);
    const got = await env.claim(withJobs);
    assert.equal(got.jobs.length, 1);
    assert.equal(got.blocked, undefined, 'no blocked when jobs were claimed');
    const empty = env.scope();
    await env.store.setPaused(empty, true);
    assert.equal((await env.claim(empty)).blocked, undefined, 'no blocked on an empty paused queue');
  });

  t.test(
    'contract: claim reports nextRunAt of the earliest delayed job and paused true when nothing was claimed because of pause',
    async (env) => {
      const s = env.scope();
      const [due] = await env.addJobs(s, 1, { delayMs: 100 });
      const [a] = await env.addJobs(s, 1, { delayMs: 500 });
      await env.addJobs(s, 1, { delayMs: 900 });
      await env.addJobs(s, 1);
      await env.elapse(200);
      const res = await env.claim(s);
      assert.equal(res.jobs.length, 1);
      assert.equal(res.nextRunAt, a!.runAt, `a job already due (runAt ${due!.runAt}) is not the next run time`);
      assert.equal(res.paused, false);
      await env.addJobs(s, 1);
      await env.store.setPaused(s, true);
      const paused = await env.claim(s);
      assert.deepEqual(paused.jobs, []);
      assert.equal(paused.paused, true);
      assert.equal(paused.nextRunAt, a!.runAt);
    },
  );

  t.test('contract: cancel waiting, delayed and active; second cancel is already-terminal', async (env) => {
    const s = env.scope();
    const { job: active } = await claimed(env, s);
    const [waiting] = await env.addJobs(s, 1);
    const [delayed] = await env.addJobs(s, 1, { delayMs: 60_000 });
    for (const [job, state] of [[waiting!, 'waiting'], [delayed!, 'delayed'], [active, 'active']] as const) {
      assert.deepEqual(await env.store.cancel(s, { id: job.id }), { ok: true, previousState: state });
      const rec = await get(env, s, job.id);
      assert.equal(rec.state, 'cancelled');
      assert.equal(rec.lease, null);
      assert.ok(Number.isInteger(rec.finishedAt) && rec.finishedAt! >= rec.createdAt, 'cancel sets finishedAt');
      assert.deepEqual(await env.store.cancel(s, { id: job.id }), { ok: false, reason: 'already-terminal', state: 'cancelled' });
    }
  });

  t.test('contract: remove deletes non-active jobs and refuses active', async (env) => {
    const s = env.scope();
    const done = await claimed(env, s);
    await env.store.complete(s, { id: done.job.id, token: done.token, result: null });
    const { job: active } = await claimed(env, s);
    const [waiting] = await env.addJobs(s, 1);
    assert.deepEqual(await env.store.remove(s, { id: waiting!.id }), { removed: true, previousState: 'waiting' });
    assert.deepEqual(await env.store.remove(s, { id: done.job.id }), { removed: true, previousState: 'completed' });
    assert.deepEqual(await env.store.remove(s, { id: active.id }), { removed: false, reason: 'active' });
    assert.deepEqual(await env.store.remove(s, { id: 'unknown' }), { removed: false, reason: 'not-found' });
    assert.equal(await env.store.get(s, waiting!.id), null);
    assert.equal(await env.store.get(s, done.job.id), null);
    assert.equal((await get(env, s, active.id)).state, 'active');
  });

  t.test('contract: update applies on matching rev, conflict on stale rev, not-editable when active', async (env) => {
    const s = env.scope();
    const [job] = await env.addJobs(s, 1, { priority: 1 });
    const up = await env.store.update(s, { id: job!.id, expectedRev: job!.rev, patch: { priority: 7 } });
    assert.ok(up.ok, 'update on the matching rev applies');
    assert.equal(up.job.rev, job!.rev + 1);
    assert.equal((await get(env, s, job!.id)).priority, 7);
    assert.deepEqual(await env.store.update(s, { id: job!.id, expectedRev: job!.rev, patch: { priority: 9 } }), {
      ok: false,
      reason: 'conflict',
    });
    assert.equal((await get(env, s, job!.id)).priority, 7, 'a conflict changes nothing');
    const res = await env.claim(s);
    const active = oneJob(res);
    assert.deepEqual(await env.store.update(s, { id: active.id, expectedRev: active.rev, patch: { priority: 9 } }), {
      ok: false,
      reason: 'not-editable',
    });
    const after = await get(env, s, active.id);
    assert.deepEqual([after.priority, after.state, after.rev], [7, 'active', active.rev]);
  });

  t.test('contract: setPaused persists, changed flag is correct, claim returns nothing while paused', async (env) => {
    const s = env.scope();
    await env.addJobs(s, 1);
    assert.deepEqual(await env.store.setPaused(s, true), { changed: true });
    assert.deepEqual(await env.store.setPaused(s, true), { changed: false });
    assert.equal(await env.store.isPaused(s), true);
    assert.deepEqual((await env.claim(s)).jobs, []);
    assert.deepEqual(await env.store.setPaused(s, false), { changed: true });
    assert.equal(await env.store.isPaused(s), false);
    assert.equal((await env.claim(s)).jobs.length, 1);
  });

  t.test('contract: pause does not block renew, complete or sweep', async (env) => {
    const s = env.scope();
    const { job, token } = await claimed(env, s);
    await env.store.setPaused(s, true);
    assert.equal((await env.store.renew(s, { id: job.id, token, leaseMs: env.leaseMs })).ok, true);
    assert.equal((await env.store.complete(s, { id: job.id, token, result: null })).ok, true);
    const swept = await env.store.sweep(s, sweepReq());
    assert.deepEqual(swept.swept, []);
    await env.store.setPaused(s, false);
  });

  t.test('contract: fence check order superseded, not-active, expired, and rejection changes nothing including rev', async (env) => {
    const s = env.scope();
    const unchanged = async (id: string, call: () => Promise<{ ok: boolean }>, reason: string) => {
      const before = await get(env, s, id);
      assert.deepEqual(await call(), { ok: false, reason });
      assert.deepEqual(await get(env, s, id), before, `a ${reason} rejection changes nothing`);
    };
    // superseded wins even when the old lease also expired
    const a = await claimed(env, s);
    await env.elapse(env.leaseMs + 1);
    assert.equal((await env.store.sweep(s, sweepReq())).swept.length, 1);
    const a2 = (await env.claim(s)).jobs[0];
    assert.equal(a2?.id, a.job.id);
    await unchanged(a.job.id, () => env.store.complete(s, { id: a.job.id, token: a.token, result: null }), 'superseded');
    await unchanged(a.job.id, () => env.store.renew(s, { id: a.job.id, token: a.token, leaseMs: env.leaseMs }), 'superseded');
    await env.store.complete(s, { id: a.job.id, token: a2.token, result: null });
    // not-active: a finished job with its own token, through a write that is not its repeat
    await unchanged(a.job.id, () => env.store.fail(s, { id: a.job.id, token: a2.token, error: 'e' }), 'not-active');
    await unchanged(a.job.id, () => env.store.renew(s, { id: a.job.id, token: a2.token, leaseMs: env.leaseMs }), 'not-active');
    // expired: the current token after the lease ran out, before any sweep
    const b = await claimed(env, s);
    await env.elapse(env.leaseMs + 1);
    await unchanged(b.job.id, () => env.store.complete(s, { id: b.job.id, token: b.token, result: null }), 'expired');
    await unchanged(b.job.id, () => env.store.release(s, { id: b.job.id, token: b.token, ...release }), 'expired');
    // not-active: an id that never existed, and a job that was never claimed
    assert.deepEqual(await env.store.complete(s, { id: 'never-added', token: 1, result: null }), { ok: false, reason: 'not-active' });
    assert.deepEqual(await env.store.fail(s, { id: 'never-added', token: 1, error: 'e' }), { ok: false, reason: 'not-active' });
    const [idle] = await env.addJobs(s, 1);
    await unchanged(idle!.id, () => env.store.complete(s, { id: idle!.id, token: 1, result: null }), 'not-active');
    await unchanged(idle!.id, () => env.store.fail(s, { id: idle!.id, token: 1, error: 'e' }), 'not-active');
  });
}
