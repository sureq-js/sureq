import { describe, expect, it, vi } from 'vitest';
import { poll } from '../helpers/poll.js';
import { twoPods } from '../helpers/pods.js';

describe('killed pod and the worker registry (regression)', () => {
  it('regression: killed pod is gone from getWorkers while its leases are swept by lease expiry, not by the registry', async () => {
    const w = twoPods({ name: 'reg' });
    const tick = async (ms: number) => {
      for (let left = ms; left > 0; left -= 100) {
        w.clock.t += 100;
        await vi.advanceTimersByTimeAsync(100);
      }
    };
    try {
      const a = w.pod({ freezable: true });
      const { job } = await w.b.add({});
      const workerA = a.queue.process(() => new Promise(() => {}), { ...poll(50), heartbeatInterval: '1s', leaseDuration: '30s', random: () => 0.5 });
      await tick(100);
      const claimed = (await w.store.get(w.scope, job.id))!;
      expect(claimed.workerId).toBe(workerA.id);
      a.view!.freeze();
      const workerB = w.b.process(() => 'B', { ...poll(50), heartbeatInterval: '1s', sweepInterval: '1s', random: () => 0.5 });
      await tick(4000);
      expect((await w.b.getWorkers()).map((i) => i.workerId)).toEqual([workerB.id]);
      // A is no longer live, yet its job keeps A's lease until that lease expires.
      expect(await w.store.get(w.scope, job.id)).toMatchObject({ state: 'active', workerId: workerA.id, token: claimed.token });
      await tick(30_000);
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'completed', result: 'B', crashCount: 1 });
    } finally {
      await w.teardown();
    }
  });
});
