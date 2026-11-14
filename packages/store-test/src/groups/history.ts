import assert from 'node:assert/strict';
import type { JobRecord, Scope, StoredAttempt } from '@sureq/core';
import { newId, type TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, get, oneJob, rejectsRequest, sweepReq } from './util.js';

const rows = async (env: TestEnv, s: Scope, id: string): Promise<StoredAttempt[]> => (await env.store.getAttempts(s, { id })).attempts;
const only = async (env: TestEnv, s: Scope, id: string): Promise<StoredAttempt> => {
  const all = await rows(env, s, id);
  assert.equal(all.length, 1, `job ${id} has one attempt record`);
  return all[0]!;
};

export const historyGroup: ConformanceGroup = {
  name: 'history',
  mode: 'fake',
  register(t) {
    t.test('history: claim opens a running record with startedAt, workerId, token and waitMs', async (env) => {
      const s = env.scope();
      const [added] = await env.addJobs(s, 1, { delayMs: 500 });
      await env.elapse(700);
      const res = await env.claim(s, { history: { max: 50, host: 'h1' } });
      const job = oneJob(res);
      const row = await only(env, s, job.id);
      const { waitMs, ...rest } = row;
      assert.deepEqual(rest, {
        formatVersion: 1, jobId: added!.id, outcome: 'running', attempt: 1, cycle: 0, token: job.token, workerId: 'w1', host: 'h1',
        startedAt: res.now, lastRenewAt: res.now, finishedAt: null, durationMs: null, error: null, endedBy: null, batchId: null, heldMs: null,
      });
      assert.equal(waitMs, res.now - added!.runAt);
      if (env.clock) assert.equal(waitMs, 200);
      for (const history of [{ maxx: 1 }, { max: 0 }, { max: 1.5 }, { max: 1, host: 1 }, 'on']) {
        await rejectsRequest(env.claim(s, { history } as never), JSON.stringify(history));
      }
      await rejectsRequest(env.store.complete(s, { id: job.id, token: job.token, result: null, history: { max: 1, host: 'h' } } as never), 'host on a closer');
    });

    t.test('history: complete, fail, cancel, sweep and release close the record with the right outcome', async (env) => {
      const s = env.scope();
      const [c, f, x, sw, r, g] = await Promise.all(['c', 'f', 'x', 's', 'r', 'g'].map(async (name) => {
        await env.addJobs(s, 1, { name });
        return oneJob(await env.claim(s, { names: [name] }));
      }));
      await env.elapse(20);
      const renewed = await env.store.renew(s, { id: sw!.id, token: sw!.token, leaseMs: env.leaseMs });
      assert.ok(renewed.ok);
      await env.elapse(30);
      assert.ok((await env.store.complete(s, { id: c!.id, token: c!.token, result: 'r' })).ok);
      assert.ok((await env.store.fail(s, { id: f!.id, token: f!.token, error: 'e1' })).ok);
      assert.ok((await env.store.fail(s, { id: g!.id, token: g!.token, error: 'e2', retryInMs: 0 })).ok);
      assert.ok((await env.store.cancel(s, { id: x!.id })).ok);
      assert.ok((await env.store.release(s, { id: r!.id, token: r!.token, refundAttempt: true, handlerStarted: true, reason: 'shutdown' })).ok);
      await env.elapse(env.leaseMs + 1);
      const swept = await env.store.sweep(s, sweepReq());
      assert.deepEqual(swept.swept.map((j) => j.id), [sw!.id]);
      const expect: Array<[string, StoredAttempt['outcome'], StoredAttempt['endedBy'], string | null]> = [
        [c!.id, 'completed', 'worker', null], [f!.id, 'failed', 'worker', 'e1'], [g!.id, 'failed', 'worker', 'e2'],
        [x!.id, 'cancelled', 'cancel', null], [sw!.id, 'crashed', 'sweeper', null], [r!.id, 'released', 'shutdown', null],
      ];
      for (const [id, outcome, endedBy, error] of expect) {
        const row = await only(env, s, id);
        assert.deepEqual([row.outcome, row.endedBy, row.error], [outcome, endedBy, error], id);
        assert.ok(row.finishedAt !== null && row.durationMs === row.finishedAt - row.startedAt, `${id}: durationMs is finishedAt - startedAt`);
      }
      const crashed = await only(env, s, sw!.id);
      assert.equal(crashed.finishedAt, swept.now);
      assert.equal(crashed.lastRenewAt, (renewed as { now: number }).now);
    });

    t.race('history: record and job state change atomically', async (env) => {
      const s = env.scope();
      const ids = (await env.addJobs(s, 20)).map((j) => j.id);
      const [a, b] = await env.pods(2);
      let done = false;
      const worker = async (): Promise<void> => {
        try {
          for (;;) {
            const [job] = (await a!.claim(s, { workerId: 'w1', limit: 1, leaseMs: env.leaseMs, claimId: newId() })).jobs;
            if (!job) return;
            assert.ok((await a!.complete(s, { id: job.id, token: job.token, result: null })).ok);
          }
        } finally {
          done = true;
        }
      };
      const reader = async (): Promise<void> => {
        while (!done) {
          for (const id of ids) {
            const before = await b!.get(s, id);
            const { attempts } = await b!.getAttempts(s, { id });
            if (before?.state === 'active') {
              assert.ok(attempts.some((r) => r.token === before.token), `active job ${id} token ${before.token} has its record`);
            }
            const open = attempts.find((r) => r.outcome === 'running');
            if (!open) continue;
            const after = await b!.get(s, id);
            assert.ok(after, `job ${id} exists`);
            const consistent = (after.state === 'active' && after.token === open.token) || ['completed', 'failed', 'cancelled'].includes(after.state);
            assert.ok(consistent, `a running record of ${id} (token ${open.token}) is followed by state ${after.state} token ${after.token}`);
          }
          // WHY: a store that answers in microtasks would otherwise starve a writer waiting on the event loop.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      };
      await Promise.all([worker(), reader()]);
    });

    t.test('history: rejected stale complete does not modify a crashed record', async (env) => {
      const s = env.scope();
      const first = await claimed(env, s);
      await env.elapse(env.leaseMs + 1);
      await env.store.sweep(s, sweepReq());
      const crashed = await only(env, s, first.job.id);
      assert.equal(crashed.outcome, 'crashed');
      const second = oneJob(await env.claim(s, { workerId: 'w2' }));
      assert.equal((await env.store.complete(s, { id: first.job.id, token: first.token, result: 'stale' })).ok, false);
      const [old, fresh] = await rows(env, s, first.job.id);
      assert.deepEqual(old, crashed);
      assert.deepEqual([fresh?.token, fresh?.outcome], [second.token, 'running']);
      assert.ok((await env.store.complete(s, { id: second.id, token: second.token, result: 'ok' })).ok);
      const after = await rows(env, s, first.job.id);
      assert.deepEqual(after[0], crashed);
      assert.deepEqual([after[1]?.token, after[1]?.outcome], [second.token, 'completed']);
    });

    t.test('history: a repeated finalising call or a recovered claim adds no record', async (env) => {
      const s = env.scope();
      const [c, f, r] = (await env.addJobs(s, 3)) as [JobRecord, JobRecord, JobRecord];
      const claim = await env.claim(s, { limit: 3, claimId: 'same' });
      assert.equal((await env.claim(s, { limit: 3, claimId: 'same' })).recovered, true, 'the repeat recovers the claim');
      const token = (id: string) => claim.jobs.find((j) => j.id === id)!.token;
      const write = [
        () => env.store.complete(s, { id: c.id, token: token(c.id), result: null }),
        () => env.store.fail(s, { id: f.id, token: token(f.id), error: 'e' }),
        () => env.store.release(s, { id: r.id, token: token(r.id), refundAttempt: false, handlerStarted: true }),
      ];
      for (const call of write) {
        assert.ok((await call()).ok);
        const again = await call();
        assert.ok(again.ok && again.repeated, 'the repeat is answered');
      }
      for (const id of [c.id, f.id, r.id]) assert.equal((await rows(env, s, id)).length, 1, `${id} has one record`);
    });

    t.test('history: records are deleted with the job', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s);
      await env.store.complete(s, { id: a.job.id, token: a.token, result: null });
      assert.equal((await rows(env, s, a.job.id)).length, 1);
      assert.deepEqual(await env.store.remove(s, { id: a.job.id }), { removed: true, previousState: 'completed' });
      assert.deepEqual(await env.store.getAttempts(s, { id: a.job.id }), { attempts: [], truncated: 0, nextCursor: null });
      const id = `x-${a.job.id}`;
      const [first] = await env.store.add(s, [env.job({ id, uniqueWhile: 'pending' })]);
      assert.equal(first?.status, 'added');
      const seq = (first as { job: { seq: number } }).job.seq;
      const claim = oneJob(await env.claim(s));
      await env.store.complete(s, { id, token: claim.token, result: null });
      const [again] = await env.store.add(s, [env.job({ id, uniqueWhile: 'pending' })]);
      assert.equal(again?.status, 'added');
      assert.deepEqual((await rows(env, s, `${id}#${seq}`)).map((r) => [r.token, r.outcome]), [[claim.token, 'completed']]);
      assert.deepEqual(await rows(env, s, id), []);
    });

    t.test('history: waitMs and durationMs use store time under pod clock skew', async (env) => {
      const s = env.scope();
      const [added] = await env.addJobs(s, 1);
      await env.elapse(100);
      let claim: { now: number; token: number } | undefined;
      await env.skewPodClock(3_600_000, async () => {
        const res = await env.claim(s);
        claim = { now: res.now, token: oneJob(res).token };
      });
      await env.elapse(250);
      let finishedAt = 0;
      await env.skewPodClock(-3_600_000, async () => {
        const res = await env.store.complete(s, { id: added!.id, token: claim!.token, result: null });
        assert.ok(res.ok);
        finishedAt = res.now;
      });
      const row = await only(env, s, added!.id);
      assert.deepEqual([row.startedAt, row.finishedAt], [claim!.now, finishedAt]);
      assert.equal(row.waitMs, claim!.now - added!.runAt);
      assert.equal(row.durationMs, finishedAt - claim!.now);
      if (env.clock) assert.deepEqual([row.waitMs, row.durationMs], [100, 250]);
      else assert.ok(row.durationMs! < 3_600_000, 'durationMs is not shifted by the pod clock');
    });

    t.test('history: false on claim and closers writes no record', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s, {}, { history: false });
      assert.ok((await env.store.complete(s, { id: a.job.id, token: a.token, result: null, history: false })).ok);
      assert.deepEqual(await env.store.getAttempts(s, { id: a.job.id }), { attempts: [], truncated: 0, nextCursor: null });
    });

    t.test('history: cap drops the oldest closed record and keeps the running one', async (env) => {
      const s = env.scope();
      const history = { max: 3 };
      const [job] = await env.addJobs(s, 1, { maxAttempts: 10 });
      const tokens: number[] = [];
      for (let i = 0; i < 4; i++) {
        const claim = oneJob(await env.claim(s, { history }));
        tokens.push(claim.token);
        if (i < 3) assert.ok((await env.store.fail(s, { id: job!.id, token: claim.token, error: 'e', retryInMs: 0, history })).ok);
      }
      const res = await env.store.getAttempts(s, { id: job!.id });
      assert.deepEqual(res.attempts.map((r) => r.token), tokens.slice(1));
      assert.deepEqual(res.attempts.map((r) => r.outcome), ['failed', 'failed', 'running']);
      assert.equal(res.truncated, 1);
      const rec = await get(env, s, job!.id);
      assert.deepEqual([rec.attemptsTruncated, rec.attempt, rec.crashCount], [1, 4, 0]);
    });

    t.test('history: closer with no open record inserts one', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s, {}, { history: false });
      assert.deepEqual(await rows(env, s, a.job.id), []);
      assert.ok((await env.store.complete(s, { id: a.job.id, token: a.token, result: null, history: { max: 50 } })).ok);
      const row = await only(env, s, a.job.id);
      assert.deepEqual(
        [row.outcome, row.endedBy, row.token, row.startedAt, row.workerId, row.host, row.attempt],
        ['completed', 'worker', a.token, a.job.startedAt, 'w1', null, 1],
      );
      assert.equal(row.durationMs, row.finishedAt! - row.startedAt);
      assert.equal(row.waitMs, Math.max(0, a.job.startedAt! - a.job.runAt));
    });

    t.test('history: pages by token with a cursor', async (env) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1, { maxAttempts: 10 });
      const tokens: number[] = [];
      for (let i = 0; i < 5; i++) {
        const claim = oneJob(await env.claim(s));
        tokens.push(claim.token);
        assert.ok((await env.store.fail(s, { id: job!.id, token: claim.token, error: 'e', retryInMs: 0 })).ok);
      }
      const pages: number[][] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await env.store.getAttempts(s, { id: job!.id, limit: 2, ...(cursor !== undefined && { cursor }) });
        pages.push(page.attempts.map((r) => r.token));
        if (page.nextCursor === null) break;
        assert.equal(page.nextCursor, String(page.attempts.at(-1)!.token));
        cursor = page.nextCursor;
      }
      assert.deepEqual(pages, [tokens.slice(0, 2), tokens.slice(2, 4), tokens.slice(4)]);
      for (const bad of [{ limit: 0 }, { limit: 1001 }, { cursor: 'x' }, { cursor: 3 }, { other: 1 }]) {
        await rejectsRequest(env.store.getAttempts(s, { id: job!.id, ...bad } as never), JSON.stringify(bad));
      }
    });

    t.test('history: cancel without history closes the open record and adds none', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s, {}, { history: { max: 50 } });
      assert.deepEqual(await env.store.cancel(s, { id: a.job.id }), { ok: true, previousState: 'active' });
      const row = await only(env, s, a.job.id);
      assert.deepEqual([row.outcome, row.endedBy, row.token], ['cancelled', 'cancel', a.token]);
      // a job claimed without a record gets none from such a cancel
      const b = await claimed(env, s, {}, { history: false });
      assert.deepEqual(await env.store.cancel(s, { id: b.job.id }), { ok: true, previousState: 'active' });
      assert.deepEqual(await rows(env, s, b.job.id), []);
      // and no cap is applied: the workers keep 60 records, more than the default cap of 50, and all of them stay
      const keep = { max: 60 };
      const c = await claimed(env, s, { maxAttempts: 100 }, { history: keep });
      for (let token = c.token, i = 0; i < 51; i++) {
        assert.ok((await env.store.fail(s, { id: c.job.id, token, error: 'e', retryInMs: 0, history: keep })).ok);
        token = oneJob(await env.claim(s, { history: keep })).token;
      }
      assert.deepEqual(await env.store.cancel(s, { id: c.job.id }), { ok: true, previousState: 'active' });
      const all = await env.store.getAttempts(s, { id: c.job.id, limit: 100 });
      assert.deepEqual([all.attempts.length, all.truncated, all.attempts.at(-1)!.outcome], [52, 0, 'cancelled']);
    });
  },
};
