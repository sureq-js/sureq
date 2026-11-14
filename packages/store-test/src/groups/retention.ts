import assert from 'node:assert/strict';
import type { CleanRequest, CleanResult, CompleteRequest, JobRecord, NewJob, Scope } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, get, listAll, oneJob, rejectsRequest, sweepReq } from './util.js';

type Extras = Omit<CompleteRequest, 'id' | 'token' | 'result'>;
const DAY = 86_400_000;

/** Add, claim (with history, as core claims) and complete one job with the given complete-request extras; the scope must hold no other waiting job. */
async function done(env: TestEnv, s: Scope, over: Extras = {}, job: Partial<NewJob> = {}): Promise<{ job: JobRecord; now: number }> {
  const a = await claimed(env, s, job);
  const res = await env.store.complete(s, { id: a.job.id, token: a.token, result: 'r', ...over });
  assert.ok(res.ok, 'the job completes');
  return { job: a.job, now: res.now };
}

const clean = (env: TestEnv, s: Scope, req: CleanRequest): Promise<CleanResult> => env.store.clean(s, req);
const ids = async (env: TestEnv, s: Scope, state: 'completed' | 'failed' | 'cancelled'): Promise<string[]> => (await listAll(env.store, s, state)).map((r) => r.id);

/** Claim the best waiting job and complete it plainly; returns the job. */
async function completeNext(env: TestEnv, s: Scope): Promise<JobRecord> {
  const job = oneJob(await env.claim(s));
  assert.ok((await env.store.complete(s, { id: job.id, token: job.token, result: 'r' })).ok);
  return job;
}

export const retentionGroup: ConformanceGroup = {
  name: 'retention',
  mode: 'fake',
  register(t) {
    t.test('retention: keep none with resultGrace 0 deletes record and attempt history at completion', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      const req = { id: a.job.id, token: a.token, result: 'r', retention: { discard: true } };
      assert.deepEqual((await env.store.complete(s, req)).ok, true);
      assert.equal(await env.store.get(s, a.job.id), null);
      assert.deepEqual((await env.store.getAttempts(s, { id: a.job.id })).attempts, []);
      assert.equal((await env.store.counts(s)).completed, 0);
      const again = await env.store.complete(s, req);
      assert.ok(again.ok && again.repeated === true, 'a repeat answers from the tombstone');
      const f = await claimed(env, s, { maxAttempts: 1 });
      assert.ok((await env.store.fail(s, { id: f.job.id, token: f.token, error: 'e', deadLetter: false, retention: { discard: true } })).ok);
      assert.equal(await env.store.get(s, f.job.id), null);
      const [c] = await env.addJobs(s, 1);
      assert.ok((await env.store.cancel(s, { id: c!.id, retention: { discard: true } })).ok);
      assert.equal(await env.store.get(s, c!.id), null);
      assert.deepEqual(await env.store.counts(s), { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 });
      for (const retention of [{ discard: true, retainMs: 1 }, { discard: false }, { retainMs: -1 }, { retainMs: 1.5 }, { other: 1 }, true]) {
        await rejectsRequest(env.store.complete(s, { id: 'x', token: 1, result: null, retention } as never), JSON.stringify(retention));
      }
    });

    t.test('retention: keep none with the default grace keeps a result-only record for resultGrace, then the pass removes it', async (env) => {
      const s = env.scope();
      const { job, now } = await done(env, s, { retention: { retainMs: 30_000 } });
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.result, rec.retainUntil], ['r', now + 30_000]);
      const rows = (await env.store.getAttempts(s, { id: job.id })).attempts;
      assert.deepEqual(rows.map((r) => r.outcome), ['completed'], 'the attempt closes as usual during the grace');
      assert.deepEqual(await clean(env, s, { state: 'completed', retainExpired: true, limit: 10 }), { removed: 0, remaining: false });
      await env.elapse(30_000);
      assert.deepEqual(await clean(env, s, { state: 'completed', retainExpired: true, limit: 10 }), { removed: 1, remaining: false });
      assert.equal(await env.store.get(s, job.id), null);
      assert.deepEqual((await env.store.getAttempts(s, { id: job.id })).attempts, [], 'the record goes with the job');
    });

    t.test('retention: uniqueWhile retained is exempt from count trimming and uses retainedAge', async (env) => {
      const s = env.scope();
      for (let i = 0; i < 3; i++) await done(env, s);
      const kept = await done(env, s, { retention: { retainMs: 7 * DAY } }, { uniqueWhile: 'retained' });
      assert.deepEqual(await clean(env, s, { state: 'completed', keepLast: 0, limit: 10 }), { removed: 3, remaining: false });
      assert.deepEqual(await ids(env, s, 'completed'), [kept.job.id]);
      assert.equal((await get(env, s, kept.job.id)).retainUntil, kept.now + 604_800_000);
    });

    t.test('retention: dead letters ignore retention.failed and honour deadLetter.keep', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s, { maxAttempts: 1 });
      const ra = await env.store.fail(s, { id: a.job.id, token: a.token, error: 'e', deadLetter: {}, retention: { retainMs: 1 } });
      const b = await claimed(env, s, { maxAttempts: 1 });
      const rb = await env.store.fail(s, { id: b.job.id, token: b.token, error: 'e', deadLetter: { keepMs: 5000 }, retention: { retainMs: 1 } });
      assert.ok(ra.ok && rb.ok);
      assert.equal((await get(env, s, a.job.id)).retainUntil, null);
      const dead = await get(env, s, b.job.id);
      assert.equal(dead.retainUntil, dead.deadLetter!.at + 5000);
      assert.deepEqual(await clean(env, s, { state: 'failed', keepLast: 0, limit: 10 }), { removed: 0, remaining: false });
      await env.elapse(5000);
      assert.deepEqual(await clean(env, s, { state: 'failed', retainExpired: true, limit: 10 }), { removed: 1, remaining: false });
      assert.deepEqual(await ids(env, s, 'failed'), [a.job.id]);
    });

    t.test('retention: age sets retainUntil from store time', async (env) => {
      const s = env.scope();
      await env.skewPodClock(3_600_000, async () => {
        const c = await done(env, s, { retention: { retainMs: 5000 } });
        assert.equal((await get(env, s, c.job.id)).retainUntil, c.now + 5000);
        const f = await claimed(env, s, { maxAttempts: 1 });
        const rf = await env.store.fail(s, { id: f.job.id, token: f.token, error: 'e', deadLetter: false, retention: { retainMs: 5000 } });
        assert.ok(rf.ok && rf.state === 'failed');
        assert.equal((await get(env, s, f.job.id)).retainUntil, rf.now + 5000);
        const [x] = await env.addJobs(s, 1);
        assert.ok((await env.store.cancel(s, { id: x!.id, retention: { retainMs: 5000 } })).ok);
        const cancelled = await get(env, s, x!.id);
        assert.equal(cancelled.retainUntil, cancelled.finishedAt! + 5000);
        await claimed(env, s, { maxAttempts: 1 });
        await env.elapse(env.leaseMs + 1);
        const swept = await env.store.sweep(s, sweepReq({ deadLetter: false, retention: { retainMs: 5000 } }));
        assert.equal(swept.swept[0]?.action, 'failed');
        assert.equal((await get(env, s, swept.swept[0]!.id)).retainUntil, swept.now + 5000);
        const r = await claimed(env, s, { maxAttempts: 2 });
        const retry = await env.store.fail(s, { id: r.job.id, token: r.token, error: 'e', retryInMs: 1000, retention: { retainMs: 5000 } });
        assert.ok(retry.ok && retry.state === 'delayed');
        assert.equal((await get(env, s, r.job.id)).retainUntil, null, 'a retry is not a finish');
      });
      const ks = env.scope();
      const keep = '{"completed":"1h"}';
      const [k] = await env.addJobs(ks, 1, { keep });
      assert.equal((await get(env, ks, k!.id)).keep, keep);
      assert.equal((await env.store.list(ks, { state: 'waiting', offset: 0, limit: 10, order: 'asc' }))[0]?.keep, keep);
      assert.equal(oneJob(await env.claim(ks)).keep, keep);
      await rejectsRequest(env.store.add(ks, [env.job({ keep: 5 as never })]));
    });

    t.test('retention: pass deletes jobs with retainUntil in the past in pages', async (env) => {
      const s = env.scope();
      for (let i = 0; i < 5; i++) await done(env, s, { retention: { retainMs: 1000 } });
      await env.elapse(1000);
      const page = { state: 'completed', retainExpired: true, limit: 2 } as const;
      assert.deepEqual(await clean(env, s, page), { removed: 2, remaining: true });
      assert.deepEqual(await clean(env, s, page), { removed: 2, remaining: true });
      assert.deepEqual(await clean(env, s, page), { removed: 1, remaining: false });
      assert.equal((await env.store.counts(s)).completed, 0);
    });

    t.test('retention: count keeps the newest N by finishedAt then seq', async (env) => {
      const s = env.scope();
      // ids in seq order, whatever order the claims took them in
      const finish = async (n: number): Promise<string[]> => {
        await env.addJobs(s, n);
        const out: JobRecord[] = [];
        for (let i = 0; i < n; i++) out.push(await completeNext(env, s));
        await env.elapse(1);
        return out.sort((a, b) => a.seq - b.seq).map((r) => r.id);
      };
      const [t0] = await finish(1);
      const [t1] = await finish(1);
      const [t2] = await finish(1);
      const [t3a, t3b] = await finish(2);
      assert.deepEqual(await clean(env, s, { state: 'completed', keepLast: 3, limit: 10 }), { removed: 2, remaining: false });
      for (const id of [t0!, t1!]) assert.equal(await env.store.get(s, id), null);
      assert.deepEqual((await ids(env, s, 'completed')).sort(), [t2!, t3a!, t3b!].sort());
      assert.deepEqual(await clean(env, s, { state: 'completed', keepLast: 1, limit: 10 }), { removed: 2, remaining: false });
      assert.deepEqual(await ids(env, s, 'completed'), [t3b!]);
      for (const req of [
        { state: 'completed', keepLast: -1, limit: 1 }, { state: 'completed', keepLast: 1, retainExpired: true, limit: 1 },
        { state: 'completed', name: 'a', excludeNames: ['b'], limit: 1 }, { state: 'completed', excludeNames: [1], limit: 1 },
        { state: 'completed', retainExpired: 'yes', limit: 1 }, { state: 'delayed', retainExpired: true, limit: 1 },
      ]) {
        await rejectsRequest(clean(env, s, req as never), JSON.stringify(req));
      }
    });

    t.test('retention: age and count together remove a job when either is exceeded', async (env) => {
      const s = env.scope();
      for (let i = 0; i < 4; i++) {
        await done(env, s, { retention: { retainMs: 10_000 } });
        await env.elapse(1);
      }
      await env.elapse(10_000);
      const fresh = await done(env, s, { retention: { retainMs: 10_000 } });
      assert.deepEqual(await clean(env, s, { state: 'completed', keepLast: 3, limit: 10 }), { removed: 2, remaining: false });
      assert.equal((await env.store.counts(s)).completed, 3);
      assert.deepEqual(await clean(env, s, { state: 'completed', retainExpired: true, limit: 10 }), { removed: 2, remaining: false });
      assert.deepEqual(await ids(env, s, 'completed'), [fresh.job.id]);
    });

    t.test('retention: expiry uses store time when pod clock is skewed', async (env) => {
      const s = env.scope();
      await done(env, s, { retention: { retainMs: 60_000 } });
      const pass = { state: 'completed', retainExpired: true, limit: 10 } as const;
      await env.skewPodClock(3_600_000, async () => {
        assert.deepEqual(await clean(env, s, pass), { removed: 0, remaining: false }, 'a pod an hour ahead expires nothing');
        await env.elapse(59_999);
        assert.deepEqual(await clean(env, s, pass), { removed: 0, remaining: false });
      });
      await env.elapse(1);
      assert.deepEqual(await clean(env, s, pass), { removed: 1, remaining: false });
    });

    t.test('retention: count trimming spares jobs that finished within the given age', async (env) => {
      const s = env.scope();
      for (let i = 0; i < 5; i++) await done(env, s);
      assert.deepEqual(await clean(env, s, { state: 'completed', keepLast: 1, olderThanMs: 30_000, limit: 10 }), { removed: 0, remaining: false });
      await env.elapse(30_000);
      assert.deepEqual(await clean(env, s, { state: 'completed', keepLast: 1, olderThanMs: 30_000, limit: 10 }), { removed: 4, remaining: false });
    });

    t.test('retention: records without retainUntil age from finishedAt when olderThanMs is given', async (env) => {
      const s = env.scope();
      const legacy = await done(env, s);
      const ahead = await done(env, s, { retention: { retainMs: 365 * DAY } });
      const own = await done(env, s, {}, { keep: '{"completed":true}' });
      const named = await done(env, s, {}, { name: 'mine' });
      const d = await claimed(env, s, { maxAttempts: 1 });
      assert.ok((await env.store.fail(s, { id: d.job.id, token: d.token, error: 'e', deadLetter: {} })).ok);
      await env.elapse(5000);
      const sweep = { retainExpired: true, olderThanMs: 5000, excludeNames: ['mine'], limit: 10 };
      assert.deepEqual(await clean(env, s, { state: 'completed', retainExpired: true, limit: 10 }), { removed: 0, remaining: false }, 'without olderThanMs nothing has expired');
      assert.deepEqual(await clean(env, s, { state: 'failed', ...sweep }), { removed: 0, remaining: false }, 'a dead letter stays');
      assert.deepEqual(await clean(env, s, { state: 'completed', ...sweep }), { removed: 1, remaining: false });
      assert.equal(await env.store.get(s, legacy.job.id), null);
      assert.deepEqual((await ids(env, s, 'completed')).sort(), [ahead.job.id, own.job.id, named.job.id].sort());
    });

    t.test('retention: clean deletes the superseded records of a reused id, and retainExpired expires them by their own retainUntil', async (env) => {
      const s = env.scope();
      const attempts = async (id: string): Promise<number> => (await env.store.getAttempts(s, { id })).attempts.length;
      // a reused id whose old record expires while the new job still waits
      const first = await done(env, s, { retention: { retainMs: 1000 } }, { id: 'r' });
      await env.addJobs(s, 1, { id: 'r' });
      const old = `r#${first.job.seq}`;
      assert.equal(await attempts(old), 1, 'the old record keeps its attempt');
      await env.elapse(1000);
      assert.deepEqual(await clean(env, s, { state: 'completed', retainExpired: true, limit: 10 }), { removed: 1, remaining: false });
      assert.equal(await attempts(old), 0);
      assert.ok(await env.store.get(s, 'r'), 'the waiting job is untouched');
      // deleting the live job takes the superseded record of its id along
      const second = await completeNext(env, s);
      await env.addJobs(s, 1, { id: 'r' });
      const third = await completeNext(env, s);
      assert.equal(await attempts(`r#${second.seq}`), 1);
      assert.deepEqual(await clean(env, s, { state: 'completed', limit: 10 }), { removed: 1, remaining: false });
      assert.equal(await env.store.get(s, 'r'), null);
      assert.deepEqual([await attempts('r'), await attempts(`r#${second.seq}`)], [0, 0]);
      assert.equal(third.id, 'r');
    });

    t.test('retention: count with a name or excluded names counts only those jobs', async (env) => {
      const s = env.scope();
      for (const name of ['a', 'a', 'a', 'b', 'b', 'b']) await done(env, s, {}, { name });
      const names = async (): Promise<string[]> => (await listAll(env.store, s, 'completed')).map((r) => r.name!).sort();
      assert.deepEqual(await clean(env, s, { state: 'completed', keepLast: 1, name: 'a', limit: 10 }), { removed: 2, remaining: false });
      assert.deepEqual(await names(), ['a', 'b', 'b', 'b']);
      assert.deepEqual(await clean(env, s, { state: 'completed', keepLast: 1, excludeNames: ['a'], limit: 10 }), { removed: 2, remaining: false });
      assert.deepEqual(await names(), ['a', 'b']);
    });
  },
};
