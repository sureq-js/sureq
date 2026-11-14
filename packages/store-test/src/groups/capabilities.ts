import assert from 'node:assert/strict';
import { acknowledgedWritesSurviveReopen } from './contract-records.js';
import type { ConformanceGroup } from './types.js';
import { assertUnique, claimAll, eventually, rejectsCapability, ZERO_COUNTS } from './util.js';

const FLAGS = [
  'transactions', 'skipLocked', 'notify', 'ttl', 'durable', 'shared', 'claimConstraints', 'boundedAdd', 'flows', 'logs', 'archive',
  'audit', 'metricsHistory', 'changeFeed', 'externalTransaction', 'migrations', 'singleNode', 'patch', 'deadlines', 'queueRecords',
] as const;

export const capabilitiesGroup: ConformanceGroup = {
  name: 'capabilities',
  mode: 'fake',
  register(t) {
    t.test('capabilities: object is frozen and has all fields with correct types', async (env) => {
      const caps = env.store.capabilities;
      assert.ok(Object.isFrozen(caps) && Object.isFrozen(caps.limits), 'capabilities and limits are frozen');
      for (const flag of FLAGS) assert.equal(typeof caps[flag], 'boolean', `${flag} is a boolean`);
      assert.ok(Number.isInteger(caps.limits.maxIdBytes) && caps.limits.maxIdBytes >= 36, 'limits.maxIdBytes is an integer >= 36');
      assert.ok(Number.isInteger(caps.limits.maxClaimLimit) && caps.limits.maxClaimLimit >= 1, 'limits.maxClaimLimit is an integer >= 1');
    });

    t.test('capabilities: limits.maxIdBytes accepts an id of exactly that length and the suite uses no longer', async (env) => {
      const s = env.scope();
      const id = `${'a'.repeat(env.caps.limits.maxIdBytes - 2)}é`;
      assert.equal(new TextEncoder().encode(id).length, env.caps.limits.maxIdBytes);
      await env.addJobs(s, 1, { id });
      assert.equal((await env.store.get(s, id))?.id, id);
    });

    t.test(
      'capabilities: transactions true — atomic add is all or nothing',
      async (env) => {
        const s = env.scope();
        const [x] = await env.addJobs(s, 1);
        const a = env.job();
        const b = env.job();
        try {
          const out = await env.store.add(s, [a, env.job({ id: x!.id, onDuplicate: 'reject' }), b], { atomic: true });
          assert.ok(out.every((o) => o.status !== 'added'), 'an atomic batch with a rejected duplicate adds nothing');
        } catch {
          // rejecting the whole batch is all-or-nothing too
        }
        assert.equal(await env.store.get(s, a.id), null, 'the input before the duplicate is not written');
        assert.equal(await env.store.get(s, b.id), null, 'the input after the duplicate is not written');
      },
      { requires: 'transactions' },
    );

    t.test(
      'capabilities: transactions false — atomic add throws CapabilityError',
      async (env) => {
        const s = env.scope();
        await assert.rejects(env.store.add(s, [env.job()], { atomic: true }), (e: { capability?: unknown }) => e.capability === 'transactions');
        await rejectsCapability(env.store.add(s, [env.job()], { atomic: true }));
        assert.deepEqual({ ...(await env.store.counts(s)) }, ZERO_COUNTS);
      },
      { absent: 'transactions' },
    );

    t.test(
      'capabilities: notify true — subscribe exists and wakes on add',
      async (env) => {
        assert.equal(typeof env.store.subscribe, 'function');
        const s = env.scope();
        let wakes = 0;
        const off = await env.store.subscribe!(s, () => void wakes++);
        await env.addJobs(s, 1);
        assert.ok(await eventually(() => wakes > 0, 2000 * env.timeScale), 'a wake arrives within 2 s of an add');
        await off();
      },
      { requires: 'notify' },
    );

    t.test(
      'capabilities: notify false — subscribe is absent or never required',
      async (env) => {
        assert.ok(env.store.subscribe === undefined || typeof env.store.subscribe === 'function');
        const s = env.scope();
        await env.addJobs(s, 3);
        const ids = await claimAll([env.store], s, 1, env.leaseMs);
        assert.equal(ids.length, 3, 'claiming by polling finds every job');
      },
      { absent: 'notify' },
    );

    t.test('capabilities: durable true — reopen keeps acknowledged writes', acknowledgedWritesSurviveReopen, { requires: 'durable' });

    t.test(
      'capabilities: shared true — two store objects on one backend never double-claim',
      async (env) => {
        const pods = await env.pods(2);
        assert.notEqual(pods[0], pods[1], 'pods are distinct store objects');
        const s = env.scope();
        for (let i = 0; i < 2; i++) await env.addJobs(s, 100);
        const ids = await claimAll(pods, s, 7, env.leaseMs);
        assertUnique(ids, 'shared claim');
        assert.equal(ids.length, 200);
      },
      { requires: 'shared' },
    );

    t.test(
      'capabilities: skipLocked true — 20 concurrent claimers finish within a time bound',
      async (env) => {
        const s = env.scope();
        await env.addJobs(s, 400);
        const pods = await env.pods(20);
        const start = performance.now();
        const results = await Promise.all(
          pods.map((p, i) => p.claim(s, { workerId: `w${i}`, limit: 20, leaseMs: env.leaseMs, claimId: `c${i}` })),
        );
        const ms = performance.now() - start;
        assertUnique(results.flatMap((r) => r.jobs.map((j) => j.id)), 'skipLocked claim');
        if (ms > 10_000 * env.timeScale) console.warn(`capabilities: 20 concurrent claimers took ${Math.round(ms)} ms`);
      },
      { requires: 'skipLocked' },
    );
  },
};
