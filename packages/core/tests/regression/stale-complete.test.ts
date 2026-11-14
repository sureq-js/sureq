import { describe, expect, it, vi } from 'vitest';
import { live, twoPods } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';

describe('stale complete (regression)', () => {
  it("regression: stale complete after reclaim is rejected and only the new owner's result is stored", async () => {
    const w = twoPods({ name: 's' });
    try {
      const a = w.pod({ freezable: true });
      const completed = vi.fn();
      const leaseLost = vi.fn();
      a.queue.on('completed', completed);
      a.queue.on('leaseLost', leaseLost);
      w.b.on('completed', completed);
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const { job } = await w.b.add({});
      a.queue.process(async () => {
        await gate;
        return 'A';
      }, { ...poll(50), random: () => 0.5 });
      await vi.advanceTimersByTimeAsync(10);
      expect((await w.store.get(w.scope, job.id))!.state).toBe('active');
      // A's view of the store freezes; its handler finishes and its complete waits.
      a.view!.freeze();
      open();
      await vi.advanceTimersByTimeAsync(10);
      w.clock.t += 30_001;
      w.b.process(() => 'B', live);
      await vi.advanceTimersByTimeAsync(600);
      expect(completed).toHaveBeenCalledTimes(1);
      a.view!.unfreeze();
      await vi.advanceTimersByTimeAsync(10);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(leaseLost).toHaveBeenCalledTimes(1);
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'completed', result: 'B', attempt: 2 });
    } finally {
      await w.teardown();
    }
  });
});
