import assert from 'node:assert/strict';
import type { NamespaceScope, RegisterWorkerRequest, Scope, WorkerRecord } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { rejectsRequest } from './util.js';

/** A full registration for scope `s`; `over` replaces fields. */
const reg = (s: Scope, over: Partial<RegisterWorkerRequest> = {}): RegisterWorkerRequest => ({
  workerId: 'w1', queues: [s.queue], names: [null, 'a'], concurrency: 2, sureqVersion: '0.3.0', formatVersion: 1, heartbeatIntervalMs: 1000,
  host: 'h1', pid: 42, labels: { zone: 'a' }, scheduler: false, ...over,
});

const ns = (s: Scope): NamespaceScope => ({ namespace: s.namespace });

async function listed(env: TestEnv, s: Scope, queue?: string): Promise<WorkerRecord[]> {
  return (await env.store.listWorkers(ns(s), queue === undefined ? {} : { queue })).workers;
}

async function one(env: TestEnv, s: Scope, workerId: string): Promise<WorkerRecord> {
  const rec = (await listed(env, s)).find((w) => w.workerId === workerId);
  assert.ok(rec, `worker ${workerId} is listed`);
  return rec;
}

export const workersGroup: ConformanceGroup = {
  name: 'workers',
  mode: 'fake',
  register(t) {
    t.test('workers: register then list returns the record with store-time startedAt', async (env) => {
      const s = env.scope();
      const t0 = await env.store.now();
      const req = reg(s);
      const res = await env.store.registerWorker(ns(s), req);
      assert.equal(res.startedAt, res.now);
      assert.ok(res.startedAt >= t0, 'startedAt is store time');
      const rec = await one(env, s, 'w1');
      assert.deepEqual(rec, { ...req, activeJobs: 0, status: 'running', startedAt: res.startedAt, lastHeartbeatAt: res.startedAt });
      assert.deepEqual(await listed(env, s, 'other'), []);
      assert.deepEqual((await listed(env, s, s.queue)).map((w) => w.workerId), ['w1']);
      const w2 = reg(s, { workerId: 'w2', queues: ['other'] });
      delete w2.names;
      await env.store.registerWorker(ns(s), w2);
      assert.deepEqual((await listed(env, s)).map((w) => w.workerId).sort(), ['w1', 'w2']);
      assert.deepEqual((await listed(env, s, s.queue)).map((w) => w.workerId), ['w1']);
      assert.equal((await one(env, s, 'w2')).names, null, 'names left out are stored as null');
      assert.deepEqual(await listed(env, env.scope(undefined, 'other')), [], 'records are per namespace');
      await rejectsRequest(env.store.registerWorker(ns(s), reg(s, { workerId: '' })), 'an empty workerId');
      await rejectsRequest(env.store.registerWorker(ns(s), reg(s, { queues: 'q' as never })), 'queues not an array');
      await rejectsRequest(env.store.registerWorker(ns(s), reg(s, { pid: 1.5 })), 'a fractional pid');
      await rejectsRequest(env.store.registerWorker(ns(s), { ...reg(s), extra: 1 } as never), 'an unknown field');
    });

    t.test('workers: heartbeat updates lastHeartbeatAt, activeJobs and status', async (env) => {
      const s = env.scope();
      const { startedAt } = await env.store.registerWorker(ns(s), reg(s));
      await env.elapse(500);
      const res = await env.store.heartbeatWorker(ns(s), { workerId: 'w1', activeJobs: 3, concurrency: 4, status: 'paused', scheduler: true });
      assert.deepEqual(res, { ok: true });
      const rec = await one(env, s, 'w1');
      assert.ok(rec.lastHeartbeatAt - startedAt >= 500, 'lastHeartbeatAt moves with store time');
      assert.deepEqual([rec.activeJobs, rec.concurrency, rec.status, rec.scheduler, rec.startedAt], [3, 4, 'paused', true, startedAt]);
      const gone = await env.store.heartbeatWorker(ns(s), { workerId: 'nobody', activeJobs: 0, concurrency: 1, status: 'running', scheduler: false });
      assert.deepEqual(gone, { ok: false });
      assert.equal((await listed(env, s)).length, 1, 'a heartbeat for an unknown id creates nothing');
    }, { fakeClock: true });

    t.test('workers: unregister removes the record', async (env) => {
      const s = env.scope();
      await env.store.registerWorker(ns(s), reg(s));
      await env.store.registerWorker(ns(s), reg(s, { workerId: 'w2' }));
      await env.store.unregisterWorker(ns(s), { workerId: 'w1' });
      assert.deepEqual((await listed(env, s)).map((w) => w.workerId), ['w2']);
      await env.store.unregisterWorker(ns(s), { workerId: 'w1' });
      assert.deepEqual((await listed(env, s)).map((w) => w.workerId), ['w2'], 'unregistering again changes nothing');
    });

    t.test('workers: list returns store now so staleness uses one clock', async (env) => {
      const s = env.scope();
      await env.store.registerWorker(ns(s), reg(s));
      await env.elapse(100);
      await env.store.registerWorker(ns(s), reg(s, { workerId: 'w2' }));
      await env.elapse(100);
      const before = await env.store.now();
      const res = await env.store.listWorkers(ns(s), {});
      const after = await env.store.now();
      assert.ok(res.now >= before && res.now <= after, 'now is read during the call');
      for (const w of res.workers) assert.ok(res.now >= w.lastHeartbeatAt, `now is not before ${w.workerId}'s heartbeat`);
    });

    t.test('workers: cleanup deletes records older than the cutoff', async (env) => {
      const s = env.scope();
      // a cutoff of three 500 ms intervals: 1500 ms
      for (const id of ['a', 'b', 'c']) await env.store.registerWorker(ns(s), reg(s, { workerId: id, heartbeatIntervalMs: 500 }));
      await env.elapse(1000);
      await env.store.heartbeatWorker(ns(s), { workerId: 'b', activeJobs: 0, concurrency: 1, status: 'running', scheduler: false });
      await env.elapse(1000);
      assert.deepEqual(await env.store.purgeWorkers(ns(s), { staleIntervals: 3, limit: 10 }), { removed: 2 });
      assert.deepEqual((await listed(env, s)).map((w) => w.workerId), ['b']);
      const s2 = env.scope(undefined, 'second');
      for (const id of ['d', 'e', 'f', 'g']) await env.store.registerWorker(ns(s2), reg(s2, { workerId: id, heartbeatIntervalMs: 500 }));
      await env.elapse(2000);
      assert.deepEqual(await env.store.purgeWorkers(ns(s2), { staleIntervals: 3, limit: 3 }), { removed: 3 });
      assert.deepEqual(await env.store.purgeWorkers(ns(s2), { staleIntervals: 3, limit: 3 }), { removed: 1 });
      assert.deepEqual(await listed(env, s2), []);
      for (const req of [{ staleIntervals: -1, limit: 1 }, { staleIntervals: 1.5, limit: 1 }, { staleForMs: 1000, limit: 1 }]) {
        await rejectsRequest(env.store.purgeWorkers(ns(s), req as never), JSON.stringify(req));
      }
    }, { fakeClock: true });

    t.test('workers: cleanup judges each record by its own heartbeat interval', async (env) => {
      const s = env.scope();
      await env.store.registerWorker(ns(s), reg(s, { workerId: 'fast', heartbeatIntervalMs: 100 }));
      await env.store.registerWorker(ns(s), reg(s, { workerId: 'slow', heartbeatIntervalMs: 10_000 }));
      await env.elapse(5000);
      // ten intervals: 1 s for the fast worker, 100 s for the slow one, which is still within them
      assert.deepEqual(await env.store.purgeWorkers(ns(s), { staleIntervals: 10, limit: 10 }), { removed: 1 });
      assert.deepEqual((await listed(env, s)).map((w) => w.workerId), ['slow']);
      await env.elapse(96_000);
      assert.deepEqual(await env.store.purgeWorkers(ns(s), { staleIntervals: 10, limit: 10 }), { removed: 1 });
      assert.deepEqual(await listed(env, s), []);
    }, { fakeClock: true });
  },
};
