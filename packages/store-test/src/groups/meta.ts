import assert from 'node:assert/strict';
import type { EnsureNamespaceMetaRequest, JobRecord } from '@sureq/core';
import type { ConformanceGroup } from './types.js';
import { claimed, get, rejectsRequest, sweepReq } from './util.js';

const ensureReq = (current: number, minReadable: number, maxReadable: number, sureqVersion: string): EnsureNamespaceMetaRequest => ({
  current, minReadable, maxReadable, sureqVersion,
});

/** Fields a transition may change; every other field of a record must come back as it went in. */
const MOVING = new Set([
  'state', 'lease', 'token', 'attempt', 'rev', 'createdAt', 'startedAt', 'finishedAt', 'result', 'error', 'lastFinal', 'workerId', 'runAt',
  'singletonHeld', 'crashCount', 'cancelReason',
]);
const still = (rec: JobRecord): Record<string, unknown> => Object.fromEntries(Object.entries(rec).filter(([k]) => !MOVING.has(k)));

export const metaGroup: ConformanceGroup = {
  name: 'meta',
  mode: 'fake',
  register(t) {
    t.test('meta: ensureNamespaceMeta creates meta on an empty store and raises it monotonically', async (env) => {
      const ns = { namespace: env.scope().namespace };
      const other = { namespace: env.scope(undefined, 'other').namespace };
      assert.equal(await env.store.getNamespaceMeta(ns), null);
      assert.deepEqual(await env.store.ensureNamespaceMeta(ns, ensureReq(1, 1, 2, 'a')), { formatVersion: 1, created: true, raised: false });
      const first = await env.store.getNamespaceMeta(ns);
      assert.deepEqual([first?.formatVersion, first?.createdBy, first?.lastRaisedBy], [1, 'a', 'a']);
      await env.elapse(10);
      const at = await env.store.now();
      assert.deepEqual(await env.store.ensureNamespaceMeta(ns, ensureReq(2, 1, 2, 'b')), { formatVersion: 2, created: false, raised: true });
      const raised = await env.store.getNamespaceMeta(ns);
      assert.deepEqual([raised?.formatVersion, raised?.createdBy, raised?.lastRaisedBy], [2, 'a', 'b']);
      assert.ok(raised!.updatedAt >= at, 'updatedAt is store time');
      if (env.clock) assert.equal(raised!.updatedAt, at);
      assert.deepEqual(await env.store.ensureNamespaceMeta(ns, ensureReq(1, 1, 2, 'c')), { formatVersion: 2, created: false, raised: false });
      assert.deepEqual(await env.store.getNamespaceMeta(ns), raised);
      assert.equal(await env.store.getNamespaceMeta(other), null);
    });

    t.test('meta: ensureNamespaceMeta outside the readable range writes nothing', async (env) => {
      const ns = { namespace: env.scope().namespace };
      await env.store.ensureNamespaceMeta(ns, ensureReq(2, 1, 2, 'k'));
      const before = await env.store.getNamespaceMeta(ns);
      for (const req of [ensureReq(1, 1, 1, 'x'), ensureReq(3, 3, 3, 'y')]) {
        assert.deepEqual(await env.store.ensureNamespaceMeta(ns, req), { formatVersion: 2, created: false, raised: false });
        assert.deepEqual(await env.store.getNamespaceMeta(ns), before);
      }
      await rejectsRequest(env.store.ensureNamespaceMeta(ns, ensureReq(1, 2, 2, 'z')), 'minReadable above current');
      await rejectsRequest(env.store.ensureNamespaceMeta(ns, ensureReq(1.5, 1, 2, 'z')), 'a fractional version');
      assert.deepEqual(await env.store.getNamespaceMeta(ns), before);
    });

    t.race('meta: concurrent ensureNamespaceMeta on an empty store creates exactly one meta', async (env, i) => {
      const ns = { namespace: env.scope(undefined, `race${i}`).namespace };
      const pods = await env.pods(env.concurrency);
      const results = await Promise.all(pods.map((p, k) => p.ensureNamespaceMeta(ns, ensureReq(1, 1, 1, `p${k}`))));
      assert.equal(results.filter((r) => r.created).length, 1, 'exactly one pod creates the meta');
      for (const r of results) assert.equal(r.formatVersion, 1);
    });

    t.test('meta: claim skips records newer than maxFormat and leaves them unchanged', async (env) => {
      const s = env.scope();
      const [a, b, c] = [env.job(), env.job({ formatVersion: 2 }), env.job()];
      await env.store.add(s, [a, b, c]);
      const res = await env.claim(s, { maxFormat: 1, limit: 3 });
      assert.deepEqual(res.jobs.map((j) => j.id), [a.id, c.id]);
      const rec = await get(env, s, b.id);
      assert.deepEqual([rec.state, rec.rev, rec.token], ['waiting', 1, 0]);
      assert.deepEqual((await env.claim(s, { maxFormat: 2 })).jobs.map((j) => j.id), [b.id]);
    });

    t.test('meta: sweep skips records newer than maxFormat', async (env) => {
      const s = env.scope();
      const a = await claimed(env, s, {}, { maxFormat: 2 });
      const b = await claimed(env, s, { formatVersion: 2 }, { maxFormat: 2 });
      await env.elapse(env.leaseMs + 1);
      assert.deepEqual((await env.store.sweep(s, sweepReq({ maxFormat: 1 }))).swept.map((j) => j.id), [a.job.id]);
      const rec = await get(env, s, b.job.id);
      assert.deepEqual([rec.state, rec.lease], ['active', b.job.lease]);
      assert.deepEqual((await env.store.sweep(s, sweepReq({ maxFormat: 2 }))).swept.map((j) => j.id), [b.job.id]);
    });

    t.test('meta: counts include records newer than maxFormat', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 1);
      await env.addJobs(s, 1, { formatVersion: 2 });
      assert.equal((await env.store.counts(s)).waiting, 2);
    });

    t.test('meta: unknown fields on a record survive complete, fail, renew and progress', async (env) => {
      const s = env.scope();
      const full = (k: number) => env.job({
        name: `n${k}`, dataVersion: 7, backoff: '{"type":"fixed","delayMs":5}', timeout: '{"ms":60000}', idempotencyKey: `i${k}`,
        singletonKey: `s${k}`, formatVersion: 2, maxAttempts: 5,
      });
      const jobs = [full(1), full(2), full(3), full(4)];
      const added = new Map<string, JobRecord>();
      for (const out of await env.store.add(s, jobs)) {
        assert.equal(out.status, 'added');
        if (out.status === 'added') added.set(out.job.id, out.job);
      }
      const { jobs: running } = await env.claim(s, { limit: 3, names: ['n1', 'n2', 'n3'] });
      const [renewed, retried, released] = jobs.slice(0, 3).map((j) => running.find((r) => r.id === j.id)!);
      assert.ok(renewed && retried && released, 'the three jobs are claimed');
      assert.equal((await env.store.renew(s, { id: renewed.id, token: renewed.token, leaseMs: env.leaseMs })).ok, true);
      const unprogressed = await get(env, s, renewed.id);
      assert.equal((await env.store.setProgress(s, { id: renewed.id, token: renewed.token, progress: '{"n":1}' })).ok, true);
      const progressed = await get(env, s, renewed.id);
      assert.deepEqual({ ...progressed, progress: unprogressed.progress, rev: unprogressed.rev }, unprogressed, 'progress changes only progress and rev');
      assert.equal((await env.store.fail(s, { id: retried.id, token: retried.token, error: 'e', retryInMs: 0 })).ok, true);
      const again = (await env.claim(s, { names: ['n2'] })).jobs[0]!;
      assert.equal((await env.store.complete(s, { id: again.id, token: again.token, result: 'r' })).ok, true);
      assert.equal((await env.store.release(s, { id: released.id, token: released.token, refundAttempt: true, handlerStarted: false })).ok, true);
      assert.equal((await env.store.cancel(s, { id: jobs[3]!.id })).ok, true);
      for (const job of jobs) {
        const rec = await get(env, s, job.id);
        assert.deepEqual(still(job.id === renewed.id ? { ...rec, progress: added.get(job.id)!.progress } : rec), still(added.get(job.id)!), job.id);
      }
    });

    t.test('meta: a paused claim reports blocked only for jobs within maxFormat', async (env) => {
      const s = env.scope();
      await env.store.add(s, [env.job({ formatVersion: 2 })]);
      await env.store.setPaused(s, true);
      const newer = await env.claim(s, { maxFormat: 1 });
      assert.deepEqual([newer.jobs, newer.paused, newer.blocked], [[], false, undefined], 'a job this claim could not take is not held back');
      const readable = await env.claim(s, { maxFormat: 2 });
      assert.deepEqual([readable.paused, readable.blocked], [true, { reason: 'paused' }]);
      await env.store.add(s, [env.job()]);
      assert.deepEqual((await env.claim(s, { maxFormat: 1 })).blocked, { reason: 'paused' });
    });
  },
};
