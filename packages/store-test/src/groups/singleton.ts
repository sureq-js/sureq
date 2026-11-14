import assert from 'node:assert/strict';
import type { JobRecord, Scope, Store } from '@sureq/core';
import { newId, type TestEnv } from '../harness.js';
import { addOne, addedJob, dup } from './dedup.js';
import type { ConformanceGroup } from './types.js';
import { get, listAll, oneJob, STATES, sweepReq } from './util.js';

/** Every job of the scope, live states only. */
async function pending(store: Store, s: Scope): Promise<JobRecord[]> {
  return [...(await listAll(store, s, 'waiting')), ...(await listAll(store, s, 'delayed'))];
}

/** At most one waiting or delayed job holds each key, and every holder carries its key. */
async function oneHolderPerKey(store: Store, s: Scope): Promise<void> {
  const seen = new Set<string>();
  for (const job of await pending(store, s)) {
    if (!job.singletonHeld) continue;
    assert.ok(job.singletonKey !== null, 'a holder has a key');
    assert.ok(!seen.has(job.singletonKey), `key ${job.singletonKey} has one holder`);
    seen.add(job.singletonKey);
  }
}

/** Return a claimed job to waiting or delayed by `route`. */
async function giveBack(env: TestEnv, s: Scope, job: JobRecord, route: 'retry' | 'sweep' | 'release'): Promise<void> {
  if (route === 'retry') assert.equal((await env.store.fail(s, { id: job.id, token: job.token, error: 'e', retryInMs: 1000 })).ok, true);
  if (route === 'release') {
    const res = await env.store.release(s, { id: job.id, token: job.token, refundAttempt: false, handlerStarted: false });
    assert.equal(res.ok, true);
  }
  if (route === 'sweep') {
    await env.elapse(env.leaseMs + 1);
    assert.deepEqual((await env.store.sweep(s, sweepReq())).swept.map((j) => j.id), [job.id]);
  }
}

export const singletonGroup: ConformanceGroup = {
  name: 'singleton',
  mode: 'fake',
  register(t) {
    t.test('singleton: second add with same key while waiting returns the first with added false', async (env) => {
      const s = env.scope();
      const first = addedJob(await addOne(env, s, { singletonKey: 'k' }));
      assert.equal(first.singletonHeld, true);
      assert.deepEqual(dup(await addOne(env, s, { singletonKey: 'k' })), { action: 'ignored', by: 'singletonKey', existingState: 'waiting', id: first.id });
      assert.equal((await env.store.counts(s)).waiting, 1);
    });

    t.test('singleton: delayed job holds the key', async (env) => {
      const s = env.scope();
      const first = addedJob(await addOne(env, s, { singletonKey: 'k', delayMs: 60_000 }));
      assert.deepEqual(dup(await addOne(env, s, { singletonKey: 'k', onDuplicate: 'reject' })), {
        action: 'rejected', by: 'singletonKey', existingState: 'delayed', id: first.id,
      });
    });

    t.test('singleton: key is free once the holder is active, and a new job can queue', async (env) => {
      const s = env.scope();
      const first = addedJob(await addOne(env, s, { singletonKey: 'k' }));
      const claimedJob = oneJob(await env.claim(s));
      assert.deepEqual([claimedJob.id, claimedJob.singletonHeld], [first.id, false]);
      const second = addedJob(await addOne(env, s, { singletonKey: 'k' }));
      assert.equal(second.singletonHeld, true);
      assert.equal(dup(await addOne(env, s, { singletonKey: 'k' })).id, second.id, 'the second job holds the key');
    });

    t.test('singleton: key is free after completed, failed, cancelled and removed', async (env) => {
      for (const route of ['completed', 'failed', 'cancelled', 'removed'] as const) {
        const s = env.scope();
        const first = addedJob(await addOne(env, s, { singletonKey: 'k', maxAttempts: 1 }));
        if (route === 'cancelled' || route === 'removed') {
          const res = route === 'cancelled' ? (await env.store.cancel(s, { id: first.id })).ok : (await env.store.remove(s, { id: first.id })).removed;
          assert.equal(res, true);
        } else {
          const job = oneJob(await env.claim(s));
          const res = route === 'completed'
            ? await env.store.complete(s, { id: job.id, token: job.token, result: null })
            : await env.store.fail(s, { id: job.id, token: job.token, error: 'e' });
          assert.equal(res.ok, true);
        }
        assert.equal(addedJob(await addOne(env, s, { singletonKey: 'k' })).singletonHeld, true, `${route}: the key is free`);
      }
    });

    t.race('singleton: concurrent adds of the same key create exactly one job', async (env) => {
      const pods = await env.pods(env.concurrency);
      const s = env.scope();
      const outs = (await Promise.all(pods.map((p) => p.add(s, [env.job({ singletonKey: 'k' })])))).map((o) => o[0]!);
      assert.equal(outs.filter((o) => o.status === 'added').length, 1, 'exactly one add wins');
      for (const o of outs) if (o.status !== 'added') assert.equal(dup(o).by, 'singletonKey');
      const counts = await env.store.counts(s);
      assert.equal(STATES.reduce((n, st) => n + counts[st], 0), 1);
    });

    t.race('singleton: claim racing a conflicting add never loses or duplicates a holder', async (env) => {
      const pods = await env.pods(env.concurrency);
      const s = env.scope();
      await addOne(env, s, { singletonKey: 'k' });
      const adds = pods.map((p) => p.add(s, [env.job({ singletonKey: 'k' })]));
      const [res, ...outs] = await Promise.all([env.claim(s, { limit: 10 }), ...adds]);
      const added = outs.filter((o) => o[0]!.status === 'added').length;
      const held = (await listAll(env.store, s, 'waiting')).filter((j) => j.singletonHeld).length;
      assert.ok(held <= 1, 'at most one holder');
      const counts = await env.store.counts(s);
      assert.equal(STATES.reduce((n, st) => n + counts[st], 0), 1 + added, 'every added job exists');
      assert.ok(res.jobs.every((j) => !j.singletonHeld), 'a claimed job holds nothing');
    });

    t.test('singleton: returning job (retry, sweep, release) is requeued with singletonHeld false when the key is held, and re-acquires it when free', async (env) => {
      for (const route of ['retry', 'sweep', 'release'] as const) {
        const s = env.scope();
        const a = addedJob(await addOne(env, s, { singletonKey: 'k' }));
        const claimedA = oneJob(await env.claim(s));
        const b = addedJob(await addOne(env, s, { singletonKey: 'k' }));
        await giveBack(env, s, claimedA, route);
        const recA = await get(env, s, a.id);
        assert.ok(recA.state === 'waiting' || recA.state === 'delayed', `${route}: A is requeued, never dropped`);
        assert.equal(recA.singletonHeld, false, `${route}: A does not hold the key`);
        assert.equal((await get(env, s, b.id)).singletonHeld, true, `${route}: B still holds the key`);
        await oneHolderPerKey(env.store, s);

        const s2 = env.scope();
        addedJob(await addOne(env, s2, { singletonKey: 'k' }));
        const alone = oneJob(await env.claim(s2));
        await giveBack(env, s2, alone, route);
        assert.equal((await get(env, s2, alone.id)).singletonHeld, true, `${route}: A re-takes the free key`);
      }
      // a waiting non-holder does not take the key when the holder is claimed
      const s = env.scope();
      addedJob(await addOne(env, s, { singletonKey: 'k' }));
      const a = oneJob(await env.claim(s));
      const holder = addedJob(await addOne(env, s, { singletonKey: 'k', priority: 5 }));
      await giveBack(env, s, a, 'release');
      const b = oneJob(await env.claim(s, { limit: 1 }));
      const rest = await listAll(env.store, s, 'waiting');
      assert.deepEqual([b.id, b.singletonHeld], [holder.id, false], 'the holder is claimed');
      assert.deepEqual(rest.map((j) => j.singletonHeld), [false], 'the waiting non-holder did not take the key');
      assert.equal(addedJob(await addOne(env, s, { singletonKey: 'k' })).singletonHeld, true);
    });

    t.race('singleton: at most one holder exists per key under concurrent adds and returns', async (env, i) => {
      const pods = await env.pods(env.concurrency);
      const s = env.scope();
      const keys = ['k0', 'k1', 'k2'];
      for (let round = 0; round < 3; round++) {
        const adds = pods.map((p, n) => p.add(s, [env.job({ singletonKey: keys[(n + i + round) % 3]! })]));
        const claim = env.claim(s, { limit: 2 });
        const [res] = await Promise.all([claim, ...adds]);
        await Promise.all(
          res.jobs.map((j, n) =>
            n % 2 === 0
              ? env.store.release(s, { id: j.id, token: j.token, refundAttempt: true, handlerStarted: false })
              : env.store.fail(s, { id: j.id, token: j.token, error: 'e', retryInMs: 10 }),
          ),
        );
        await oneHolderPerKey(env.store, s);
      }
    });

    t.test('singleton: replace by id with a changed key is applied when free and refused when held', async (env) => {
      const s = env.scope();
      const a = addedJob(await addOne(env, s, { singletonKey: 'k1' }));
      const moved = await addOne(env, s, { id: a.id, singletonKey: 'k2', onDuplicate: 'replace' });
      assert.equal(dup(moved).action, 'replaced');
      assert.deepEqual([(await get(env, s, a.id)).singletonKey, (await get(env, s, a.id)).singletonHeld], ['k2', true]);
      const other = addedJob(await addOne(env, s, { singletonKey: 'k1' }));
      assert.equal(other.singletonHeld, true, 'the old key is free');
      const before = await get(env, s, a.id);
      assert.deepEqual(dup(await addOne(env, s, { id: a.id, singletonKey: 'k1', data: '"x"', onDuplicate: 'replace' })), {
        action: 'ignored', by: 'singletonKey', existingState: 'waiting', id: other.id,
      });
      assert.deepEqual(await get(env, s, a.id), before, 'a refused replace writes nothing');
      await addOne(env, s, { id: a.id, data: '"y"', onDuplicate: 'replace' });
      assert.deepEqual([(await get(env, s, a.id)).singletonKey, (await get(env, s, a.id)).singletonHeld], ['k2', true], 'no key keeps the key');
      await addOne(env, s, { id: a.id, singletonKey: null, onDuplicate: 'replace' });
      assert.deepEqual([(await get(env, s, a.id)).singletonKey, (await get(env, s, a.id)).singletonHeld], [null, false]);
      assert.equal(addedJob(await addOne(env, s, { singletonKey: 'k2' })).singletonHeld, true, 'null released the key');
    });

    t.test('singleton: id conflict wins over singleton conflict', async (env) => {
      const s = env.scope();
      const a = addedJob(await addOne(env, s, { id: newId() }));
      addedJob(await addOne(env, s, { singletonKey: 'k' }));
      assert.deepEqual(dup(await addOne(env, s, { id: a.id, singletonKey: 'k' })), { action: 'ignored', by: 'id', existingState: 'waiting', id: a.id });
    });
  },
};
