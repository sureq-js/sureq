import { describe, expect, it, vi } from 'vitest';
import { killClaim, live, twoPods } from '../helpers/pods.js';

describe('sweeping pod dies (regression)', () => {
  it('regression: when the pod that was sweeping dies, another live pod reclaims the expired lease', async () => {
    const w = twoPods({ name: 'd' });
    try {
      const a = w.pod({ freezable: true });
      const { job } = await w.b.add({});
      a.queue.process(() => new Promise(() => {}), live);
      await vi.advanceTimersByTimeAsync(10);
      expect((await w.store.get(w.scope, job.id))!.workerId).not.toBeNull();
      a.view!.freeze();
      const b = w.pod({ freezable: true });
      b.queue.process(() => 'B', live);
      w.clock.t += 30_001;
      await vi.advanceTimersByTimeAsync(600);
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'completed', result: 'B', crashCount: 1 });

      // Now B dies too; a job a dead pod claimed is recovered by a new pod C.
      b.view!.freeze();
      const { job: second } = await w.b.add({});
      await killClaim(w.store, 'd');
      w.clock.t += 30_001;
      const c = w.pod();
      c.queue.process(() => 'C', live);
      await vi.advanceTimersByTimeAsync(600);
      expect(await w.b.getJob(second.id)).toMatchObject({ state: 'completed', result: 'C', crashCount: 1 });
    } finally {
      await w.teardown();
    }
  });
});
