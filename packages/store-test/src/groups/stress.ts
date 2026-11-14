import assert from 'node:assert/strict';
import type { ConformanceGroup } from './types.js';
import { claimAll } from './util.js';

/** Jobs per stress test; `SUREQ_STRESS_JOBS` raises it for a release run. */
const jobs = (): number => Number(process.env['SUREQ_STRESS_JOBS'] ?? 10_000);
const CHUNK = 1000;

/** Opt-in: many claimers and adders on one scope at a size no other group reaches. Never counts toward conformance. */
export const stressGroup: ConformanceGroup = {
  name: 'stress',
  mode: 'fake',
  optIn: true,
  register(t) {
    t.test(
      'stress: every job is claimed exactly once across simultaneous claimers',
      async (env) => {
        const s = env.scope();
        const n = jobs();
        const added = new Set<string>();
        for (let i = 0; i < n; i += CHUNK) for (const job of await env.addJobs(s, Math.min(CHUNK, n - i))) added.add(job.id);
        const pods = await env.pods(env.concurrency);
        // claimAll fails on any id claimed twice
        const claimed = await claimAll(pods, s, Math.min(100, env.caps.limits.maxClaimLimit), env.leaseMs * 1000);
        assert.equal(claimed.length, n, 'every job is claimed');
        assert.deepEqual(claimed.filter((id) => !added.has(id)), [], 'only added jobs are claimed');
        const counts = await env.store.counts(s);
        assert.deepEqual([counts.waiting, counts.active], [0, n]);
      },
      { timeoutMs: 600_000 },
    );

    t.test(
      'stress: concurrent adds of the same ids create exactly one job each',
      async (env) => {
        const s = env.scope();
        const n = Math.min(jobs(), 10_000);
        const ids = Array.from({ length: n }, (_, i) => `same-${i}`);
        const pods = await env.pods(env.concurrency);
        const added = new Map<string, number>();
        await Promise.all(
          pods.map(async (p) => {
            for (let i = 0; i < n; i += CHUNK) {
              const outcomes = await p.add(s, ids.slice(i, i + CHUNK).map((id) => env.job({ id, onDuplicate: 'ignore' })));
              for (const o of outcomes) if (o.status === 'added') added.set(o.job.id, (added.get(o.job.id) ?? 0) + 1);
            }
          }),
        );
        assert.equal(added.size, n, 'every id was added once');
        assert.ok([...added.values()].every((c) => c === 1), 'no id was added twice');
        assert.equal((await env.store.counts(s)).waiting, n);
      },
      { timeoutMs: 600_000 },
    );
  },
};
