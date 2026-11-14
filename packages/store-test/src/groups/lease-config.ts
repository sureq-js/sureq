import assert from 'node:assert/strict';
import type { ConformanceGroup } from './types.js';
import { sweepReq, oneJob } from './util.js';

export const leaseConfigGroup: ConformanceGroup = {
  name: 'lease-config',
  mode: 'fake',
  register(t) {
    t.test('lease-config: claim uses leaseMsByName for a named job and leaseMs otherwise', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 1, { name: 'a' });
      await env.addJobs(s, 1, { name: 'b' });
      await env.addJobs(s, 1);
      const res = await env.claim(s, { limit: 3, leaseMs: 1000, leaseMsByName: { a: 3000 } });
      const expiry = Object.fromEntries(res.jobs.map((j) => [String(j.name), j.lease!.expiresAt - res.now]));
      assert.deepEqual(expiry, { a: 3000, b: 1000, null: 1000 });
    });

    t.test('lease-config: lease expiry is computed from store time with the per-name duration', async (env) => {
      const s = env.scope();
      await env.addJobs(s, 1, { name: 'a' });
      const res = await env.claim(s, { leaseMs: 1000, leaseMsByName: { a: 3000 } });
      const job = oneJob(res);
      assert.equal(job.lease?.expiresAt, res.now + 3000);
      // The exact boundary needs a clock the suite can move by one millisecond.
      if (env.clock) {
        env.clock.advance(job.lease!.expiresAt - 1 - env.clock.now());
        assert.deepEqual((await env.store.sweep(s, sweepReq())).swept, [], 'not swept one millisecond before expiry');
        env.clock.advance(1);
      } else {
        await env.elapse(3000 + 50 * env.timeScale);
      }
      assert.deepEqual((await env.store.sweep(s, sweepReq())).swept.map((j) => j.id), [job.id]);
    });
  },
};
