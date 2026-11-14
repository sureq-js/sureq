import assert from 'node:assert/strict';
import type { FailRequest, JobRecord, NewJob, RedriveOutcome, RedriveRequest, Scope } from '@sureq/core';
import { newId, type TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, get, oneJob, rejectsRequest, sweepReq } from './util.js';

type DeadLetterExt = NonNullable<FailRequest['deadLetter']>;

/** Add one job, claim it and fail it for good with `ext`; the scope must hold no other waiting job. */
async function deadLetter(env: TestEnv, s: Scope, ext: DeadLetterExt = {}, over: Partial<NewJob> = {}): Promise<{ job: JobRecord; now: number }> {
  const { job, token } = await claimed(env, s, { maxAttempts: 1, ...over });
  const res = await env.store.fail(s, { id: job.id, token, error: 'boom', deadLetter: ext });
  assert.ok(res.ok && res.state === 'failed', 'the job fails for good');
  return { job, now: res.now };
}

/** Claim the best waiting job and fail it for good; returns the fail's store time. */
async function failNext(env: TestEnv, s: Scope, ext: DeadLetterExt): Promise<number> {
  const job = oneJob(await env.claim(s));
  const res = await env.store.fail(s, { id: job.id, token: job.token, error: 'boom', deadLetter: ext });
  assert.ok(res.ok && res.state === 'failed');
  return res.now;
}

const redrive = (env: TestEnv, s: Scope, req: RedriveRequest): Promise<RedriveOutcome[]> => env.store.redrive(s, req);
const deadLetters = (env: TestEnv, s: Scope, over: Record<string, unknown> = {}): Promise<string[]> =>
  env.store.list(s, { state: 'failed', deadLetter: {}, orderBy: 'deadLetterAt', offset: 0, limit: 100, order: 'asc', ...over }).then((r) => r.map((j) => j.id));
const crash = async (env: TestEnv, s: Scope, maxCrashes: number, over: object = { deadLetter: {} }) => {
  await env.elapse(env.leaseMs + 1);
  return env.store.sweep(s, sweepReq({ maxCrashes, ...over }));
};

export const dlqGroup: ConformanceGroup = {
  name: 'dlq',
  mode: 'fake',
  register(t) {
    t.test('dlq: fail with no attempts left sets state failed and deadLetter reason exhausted atomically', async (env) => {
      const s = env.scope();
      const a = await deadLetter(env, s, { keepMs: 5000 });
      const rec = await get(env, s, a.job.id);
      assert.deepEqual([rec.state, rec.deadLetter, rec.retainUntil, rec.finishedAt], ['failed', { at: a.now, reason: 'exhausted' }, a.now + 5000, a.now]);
      const b = await deadLetter(env, s, { reason: 'unrecoverable' });
      const recB = await get(env, s, b.job.id);
      assert.deepEqual([recB.deadLetter, recB.retainUntil], [{ at: b.now, reason: 'unrecoverable' }, null]);
      // a retrying fail with no attempts left is final, and marked with the reason it carries
      const c = await claimed(env, s, { maxAttempts: 1 });
      const res = await env.store.fail(s, { id: c.job.id, token: c.token, error: 'e', retryInMs: 1000, deadLetter: { reason: 'retryRejected' } });
      assert.ok(res.ok && res.state === 'failed');
      assert.deepEqual((await get(env, s, c.job.id)).deadLetter, { at: res.now, reason: 'retryRejected' });
      // a retry is not a dead letter
      const d = await claimed(env, s, { maxAttempts: 2 });
      const retried = await env.store.fail(s, { id: d.job.id, token: d.token, error: 'e', retryInMs: 60_000, deadLetter: {} });
      assert.ok(retried.ok && retried.state === 'delayed');
      assert.equal((await get(env, s, d.job.id)).deadLetter, null);
      // a final fail without the field comes from a previous-release pod
      const ls = env.scope();
      const l = await claimed(env, ls);
      const legacy = await env.store.fail(ls, { id: l.job.id, token: l.token, error: 'e' });
      assert.ok(legacy.ok);
      assert.deepEqual((await get(env, ls, l.job.id)).deadLetter, { at: legacy.now, reason: 'legacy' });
      // readers never see the failed state without its marker
      const r = env.scope();
      const racing = await claimed(env, r, { maxAttempts: 1 });
      const pods = await env.pods(2);
      const reads = await Promise.all([
        pods[0]!.fail(r, { id: racing.job.id, token: racing.token, error: 'e', deadLetter: {} }),
        ...Array.from({ length: 10 }, () => pods[1]!.get(r, racing.job.id)),
      ]);
      for (const seen of reads.slice(1) as JobRecord[]) assert.equal(seen.state === 'failed', seen.deadLetter !== null, 'state and marker change together');
      for (const ext of [{ reason: 'crashLimit' }, { reason: 'legacy' }, { keepMs: -1 }, { keepMs: 1.5 }, { other: 1 }, true, null]) {
        await rejectsRequest(env.store.fail(s, { id: 'x', token: 1, error: 'e', deadLetter: ext } as never), JSON.stringify(ext));
      }
    });

    t.test('dlq: sweep over crash limit sets deadLetter reason crashLimit', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s, { maxAttempts: 10 });
      await crash(env, s, 2);
      const second = oneJob(await env.claim(s));
      const res = await crash(env, s, 2);
      assert.deepEqual(res.swept.map((j) => j.action), ['failed']);
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.deadLetter], ['failed', { at: res.now, reason: 'crashLimit' }]);
      const stale = await env.store.complete(s, { id: job.id, token: second.token, result: null });
      assert.equal(stale.ok, false, 'a stale worker cannot complete a swept job');
      assert.deepEqual(await get(env, s, job.id), rec, 'the dead letter is unchanged');
      // attempts used up before the crash limit: exhausted
      const e = env.scope();
      const used = await claimed(env, e, { maxAttempts: 1 });
      const swept = await crash(env, e, 3);
      assert.deepEqual((await get(env, e, used.job.id)).deadLetter, { at: swept.now, reason: 'exhausted' });
      // a failing sweep without the field comes from a previous-release pod
      const l = env.scope();
      const old = await claimed(env, l, { maxAttempts: 1 });
      const legacy = await crash(env, l, 3, {});
      assert.deepEqual((await get(env, l, old.job.id)).deadLetter, { at: legacy.now, reason: 'legacy' });
      for (const ext of [{ reason: 'exhausted' }, { keepMs: -1 }, true]) {
        await rejectsRequest(env.store.sweep(s, sweepReq({ deadLetter: ext } as never)), JSON.stringify(ext));
      }
    });

    t.test('dlq: dead-lettered job is never claimed', async (env) => {
      const s = env.scope();
      await deadLetter(env, s);
      await deadLetter(env, s, false);
      const [w] = await env.addJobs(s, 1);
      const res = await env.claim(s, { limit: 10 });
      assert.deepEqual(res.jobs.map((j) => j.id), [w!.id]);
    });

    t.test('dlq: redrive moves failed to waiting and clears deadLetter', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s, { maxAttempts: 3 });
      await crash(env, s, 3);
      const second = oneJob(await env.claim(s));
      assert.ok((await env.store.setProgress(s, { id: job.id, token: second.token, progress: 'p' })).ok);
      assert.ok((await env.store.setProgress(s, { id: job.id, token: second.token, progress: 'b', field: 'batchProgress' })).ok);
      assert.ok((await env.store.fail(s, { id: job.id, token: second.token, error: 'boom', deadLetter: { keepMs: 5000 } })).ok);
      const dead = await get(env, s, job.id);
      assert.deepEqual([dead.attempt, dead.crashCount, dead.retainUntil !== null], [2, 1, true]);
      assert.deepEqual([dead.progress?.value, dead.batchProgress?.value], ['p', 'b'], 'failing keeps the progress the redrive must clear');
      const out = await redrive(env, s, { ids: [job.id], priority: 7, limit: 1 });
      assert.deepEqual(out, [{ id: job.id, status: 'redriven', state: 'waiting', viaDeadLetter: true }]);
      const rec = await get(env, s, job.id);
      assert.deepEqual(
        [rec.state, rec.deadLetter, rec.retainUntil, rec.finishedAt, rec.progress, rec.batchProgress, rec.redriveCount, rec.lastError],
        ['waiting', null, null, null, null, null, 1, 'boom'],
      );
      assert.deepEqual([rec.attempt, rec.crashCount, rec.priority, rec.seq, rec.token, rec.maxAttempts], [0, 0, 7, job.seq, second.token, 3]);
      assert.ok(rec.rev > dead.rev, 'the redrive bumps rev');
      const next = oneJob(await env.claim(s));
      assert.deepEqual([next.id, next.attempt], [job.id, 1]);
      const rows = (await env.store.getAttempts(s, { id: job.id })).attempts;
      assert.deepEqual(rows.map((r) => [r.outcome, r.cycle]), [['crashed', 0], ['failed', 0], ['running', 1]]);
    });

    t.test('dlq: redrive with resetAttempts false keeps attempt and crashCount', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s, { maxAttempts: 2 });
      await crash(env, s, 3);
      const second = oneJob(await env.claim(s));
      assert.ok((await env.store.fail(s, { id: job.id, token: second.token, error: 'e', deadLetter: {} })).ok);
      await redrive(env, s, { ids: [job.id], resetAttempts: false, limit: 1 });
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.attempt, rec.crashCount, rec.redriveCount], ['waiting', 2, 1, 1]);
      const third = oneJob(await env.claim(s));
      assert.equal(third.attempt, 3);
      const res = await env.store.fail(s, { id: job.id, token: third.token, error: 'e', retryInMs: 0, deadLetter: {} });
      assert.ok(res.ok && res.state === 'failed', 'one more failing attempt fails it again');
      assert.deepEqual((await get(env, s, job.id)).deadLetter, { at: res.now, reason: 'exhausted' });
    });

    t.test('dlq: redrive of a non-failed job is skipped not-failed', async (env) => {
      const s = env.scope();
      const [w] = await env.addJobs(s, 1, { name: 'w' });
      const active = await claimed(env, s, { name: 'a' }, { names: ['a'] });
      const done = await claimed(env, s, { name: 'c' }, { names: ['c'] });
      assert.ok((await env.store.complete(s, { id: done.job.id, token: done.token, result: null })).ok);
      const ids = [w!.id, active.job.id, done.job.id];
      const before = await Promise.all(ids.map((id) => get(env, s, id)));
      const out = await redrive(env, s, { ids, limit: 3 });
      assert.deepEqual(out, ids.map((id) => ({ id, status: 'skipped', reason: 'not-failed' })));
      assert.deepEqual(await Promise.all(ids.map((id) => get(env, s, id))), before, 'skipped jobs are unchanged, rev included');
      assert.deepEqual(await redrive(env, s, { ids: ['unknown'], limit: 1 }), [{ id: 'unknown', status: 'skipped', reason: 'not-found' }]);
      const f = env.scope();
      const { job } = await deadLetter(env, f);
      assert.deepEqual(await redrive(env, f, { ids: [job.id, job.id], limit: 2 }), [
        { id: job.id, status: 'redriven', state: 'waiting', viaDeadLetter: true },
        { id: job.id, status: 'skipped', reason: 'not-failed' },
      ]);
      assert.equal((await get(env, f, job.id)).redriveCount, 1);
    });

    t.race('dlq: concurrent redrives of one job produce exactly one redriven', async (env) => {
      const s = env.scope();
      const { job } = await deadLetter(env, s);
      const [a, b] = await env.pods(2);
      const req = { ids: [job.id], limit: 1 };
      const out = (await Promise.all([a!.redrive(s, req), b!.redrive(s, req)])).flat();
      assert.deepEqual(out.map((o) => o.status).sort(), ['redriven', 'skipped']);
      assert.equal((await get(env, s, job.id)).redriveCount, 1);
    });

    t.test('dlq: redrive of an id held by another job is skipped duplicate-id', async (env) => {
      const s = env.scope();
      const id = newId();
      const { job } = await deadLetter(env, s, {}, { id, uniqueWhile: 'pending' });
      const [again] = await env.addJobs(s, 1, { id });
      assert.notEqual(again!.seq, job.seq, 'a new job holds the id');
      assert.deepEqual(await redrive(env, s, { ids: [`${id}#${job.seq}`], limit: 1 }), [{ id: `${id}#${job.seq}`, status: 'skipped', reason: 'duplicate-id' }]);
      assert.deepEqual(await redrive(env, s, { ids: [id], limit: 1 }), [{ id, status: 'skipped', reason: 'not-failed' }]);
      assert.deepEqual(await deadLetters(env, s), [`${id}#${job.seq}`], 'a superseded dead letter is listed under its history key');
    });

    t.test('dlq: redrive with delay yields delayed and correct counts', async (env) => {
      const s = env.scope();
      const { job } = await deadLetter(env, s);
      const now = await env.store.now();
      assert.deepEqual(await redrive(env, s, { ids: [job.id], delayMs: 1000, limit: 1 }), [{ id: job.id, status: 'redriven', state: 'delayed', viaDeadLetter: true }]);
      const counts = await env.store.counts(s);
      assert.deepEqual([counts.delayed, counts.failed, counts.waiting], [1, 0, 0]);
      assert.ok((await get(env, s, job.id)).runAt >= now + 1000, 'runAt is the redrive time plus delayMs');
      await env.elapse(1000);
      assert.equal((await env.store.counts(s)).waiting, 1);
    });

    t.test('dlq: fail with deadLetter false leaves a plain failed job', async (env) => {
      const s = env.scope();
      const { job } = await deadLetter(env, s, false);
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.deadLetter], ['failed', null]);
      assert.deepEqual(await deadLetters(env, s), []);
      assert.deepEqual(await redrive(env, s, { filter: {}, limit: 10 }), [], 'a filter redrive takes dead letters only');
      assert.deepEqual(await redrive(env, s, { ids: [job.id], limit: 1 }), [{ id: job.id, status: 'redriven', state: 'waiting', viaDeadLetter: false }]);
    });

    t.test('dlq: list filters by reason, age and name in dead-letter order', async (env) => {
      const s = env.scope();
      // five jobs in seq order, failed third, first, fifth and second together, then fourth: priorities make the claims take them so
      const names = ['a', 'b', 'a', 'c', 'd'];
      const priorities = [4, 2, 5, 1, 3];
      const jobs = await Promise.all(names.map((name, i) => env.addJobs(s, 1, { name, priority: priorities[i]!, maxAttempts: 1 }).then((r) => r[0]!)));
      jobs.sort((x, y) => x.seq - y.seq);
      const [j1, j2, j3, j4, j5] = jobs.map((j) => j.id) as [string, string, string, string, string];
      await failNext(env, s, { reason: 'exhausted' });
      await env.elapse(1000);
      await failNext(env, s, { reason: 'unrecoverable' });
      await env.elapse(1000);
      await failNext(env, s, { reason: 'exhausted' });
      await failNext(env, s, { reason: 'retryRejected' });
      await env.elapse(1000);
      await failNext(env, s, { reason: 'unrecoverable' });
      assert.deepEqual(await deadLetters(env, s), [j3, j1, j2, j5, j4], 'by dead-letter time, then seq');
      assert.deepEqual(await deadLetters(env, s, { order: 'desc' }), [j4, j5, j2, j1, j3]);
      assert.deepEqual(await deadLetters(env, s, { offset: 1, limit: 2 }), [j1, j2]);
      assert.deepEqual(await deadLetters(env, s, { deadLetter: { reason: 'unrecoverable' } }), [j1, j4]);
      assert.deepEqual(await deadLetters(env, s, { deadLetter: { olderThanMs: 2000 } }), [j3, j1]);
      assert.deepEqual(await deadLetters(env, s, { name: 'a' }), [j3, j1]);
      const [named, plain] = [...(await env.addJobs(s, 1, { name: 'a' })), ...(await env.addJobs(s, 1))];
      const waiting = (name: string | null) => env.store.list(s, { state: 'waiting', name, offset: 0, limit: 10, order: 'asc' }).then((r) => r.map((j) => j.id));
      assert.deepEqual([await waiting('a'), await waiting(null)], [[named!.id], [plain!.id]]);
      const base = { state: 'failed', offset: 0, limit: 10, order: 'asc' };
      for (const req of [
        { ...base, state: 'waiting', deadLetter: {} }, { ...base, orderBy: 'deadLetterAt' }, { ...base, deadLetter: { reason: 'nope' } },
        { ...base, deadLetter: { olderThanMs: -1 } }, { ...base, deadLetter: { x: 1 } }, { ...base, deadLetter: true }, { ...base, name: 5 },
      ]) await rejectsRequest(env.store.list(s, req as never), JSON.stringify(req));
    }, { fakeClock: true });

    t.test('dlq: redrive by filter takes the oldest dead letters up to limit', async (env) => {
      const s = env.scope();
      const ids: string[] = [];
      for (const reason of ['exhausted', 'unrecoverable', 'exhausted', 'unrecoverable', 'exhausted'] as const) {
        ids.push((await deadLetter(env, s, { reason })).job.id);
        await env.elapse(1000);
      }
      await deadLetter(env, s, false);
      const redriven = (out: RedriveOutcome[]) => out.map((o) => (assert.equal(o.status, 'redriven'), o.id));
      assert.deepEqual(redriven(await redrive(env, s, { filter: { olderThanMs: 4500 }, limit: 10 })), [ids[0]], 'only dead letters old enough');
      assert.deepEqual(redriven(await redrive(env, s, { filter: { reason: 'unrecoverable' }, limit: 10 })), [ids[1], ids[3]]);
      assert.deepEqual(redriven(await redrive(env, s, { filter: {}, limit: 1 })), [ids[2]]);
      assert.deepEqual(redriven(await redrive(env, s, { filter: {}, limit: 2 })), [ids[4]]);
      assert.deepEqual(await redrive(env, s, { filter: {}, limit: 2 }), [], 'nothing left to redrive');
      const ok = { ids: ['a'], limit: 1 };
      for (const req of [
        { limit: 1 }, { ids: ['a'], filter: {}, limit: 1 }, { ...ok, limit: 0 }, { ...ok, limit: 1001 }, { ids: ['a', 'b'], limit: 1 },
        { ids: [''], limit: 1 }, { ids: 'a', limit: 1 }, { ...ok, delayMs: -1 }, { ...ok, priority: 1.5 }, { ...ok, resetAttempts: 'yes' },
        { ...ok, other: 1 }, { filter: { reason: 'nope' }, limit: 1 }, { filter: { olderThanMs: -1 }, limit: 1 }, { filter: { x: 1 }, limit: 1 },
      ]) await rejectsRequest(env.store.redrive(s, req as never), JSON.stringify(req));
    }, { fakeClock: true });

    t.test('dlq: a superseded dead letter stays a dead letter until it is removed', async (env) => {
      const s = env.scope();
      // keepMs 0: its retainUntil has passed, yet retention never deletes it once it is superseded
      const { job: old } = await deadLetter(env, s, { keepMs: 0 });
      const key = `${old.id}#${old.seq}`;
      assert.equal((await env.store.add(s, [env.job({ id: old.id })]))[0]!.status, 'added', 'a new job takes the id');
      assert.equal((await env.store.stats(s, {})).deadLetters, 1, 'stats counts it');
      assert.deepEqual(await deadLetters(env, s), [key], 'the dead-letter list shows it under its history key');
      assert.deepEqual(await env.store.list(s, { state: 'failed', offset: 0, limit: 10, order: 'asc' }), [], 'a plain list does not');
      const skipped = [{ id: key, status: 'skipped', reason: 'duplicate-id' }];
      assert.deepEqual(await redrive(env, s, { ids: [key], limit: 1 }), skipped, 'redrive by its key');
      assert.deepEqual(await redrive(env, s, { filter: {}, limit: 10 }), [], 'a filter passes it by, so it never fills a page');
      assert.equal((await get(env, s, old.id)).state, 'waiting', 'the live job is not touched');
      // the live job finishes and retention trims it: the dead letter stays
      const live = oneJob(await env.claim(s));
      assert.ok((await env.store.complete(s, { id: live.id, token: live.token, result: null })).ok);
      assert.deepEqual(await env.store.clean(s, { state: 'completed', keepLast: 0, limit: 10 }), { removed: 1, remaining: false });
      const next = (await claimed(env, s, { id: old.id })).job;
      assert.ok((await env.store.complete(s, { id: next.id, token: next.token, result: null, retention: { retainMs: 0 } })).ok);
      assert.deepEqual(await env.store.clean(s, { state: 'completed', retainExpired: true, limit: 10 }), { removed: 1, remaining: false });
      assert.equal((await env.store.clean(s, { state: 'failed', retainExpired: true, olderThanMs: 0, limit: 10 })).removed, 0);
      assert.equal((await env.store.clean(s, { state: 'failed', keepLast: 0, limit: 10 })).removed, 0);
      assert.deepEqual(await deadLetters(env, s), [key], 'deleting the live job, keepLast and retainExpired leave it');
      assert.equal((await env.store.stats(s, {})).deadLetters, 1);
      // remove by its key deletes it with its attempt records
      assert.deepEqual(await env.store.remove(s, { id: key }), { removed: true, previousState: 'failed' });
      assert.deepEqual(await deadLetters(env, s), []);
      assert.deepEqual((await env.store.getAttempts(s, { id: key })).attempts, []);
      assert.deepEqual(await env.store.remove(s, { id: key }), { removed: false, reason: 'not-found' });
      // an age-mode clean of failed jobs deletes one too
      const other = (await deadLetter(env, s, {})).job;
      await env.store.add(s, [env.job({ id: other.id })]);
      assert.deepEqual(await deadLetters(env, s), [`${other.id}#${other.seq}`]);
      assert.deepEqual(await env.store.clean(s, { state: 'failed', olderThanMs: 0, limit: 10 }), { removed: 1, remaining: false });
      assert.deepEqual(await deadLetters(env, s), []);
      assert.equal((await env.store.stats(s, {})).deadLetters, 0);
      assert.equal((await get(env, s, other.id)).state, 'waiting', 'the live job of that id stays');
    });
  },
};
