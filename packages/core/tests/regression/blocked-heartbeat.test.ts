import { describe, expect, it } from 'vitest';
import { blockedWorker } from '../helpers/pods.js';

describe('blocked heartbeat (regression)', () => {
  it('regression: blocked heartbeat loses the lease, job reruns, stale result is rejected', async () => {
    const w = await blockedWorker();
    try {
      expect(w.reclaimed).toMatchObject({ state: 'completed', attempt: 2 });
      const after = await w.store.get(w.scope, w.job.id);
      // A's late result changed nothing and produced no event.
      expect(after).toEqual(w.reclaimed);
      expect(w.events.completedA).not.toHaveBeenCalled();
      expect(w.events.leaseLostA).toHaveBeenCalledTimes(1);
    } finally {
      await w.teardown();
    }
  });

  it('regression: blocking the event loop past the lease runs the job twice and only the second run commits', async () => {
    const w = await blockedWorker();
    try {
      expect(w.runs).toEqual(['A', 'B']);
      expect(await w.a.getJob(w.job.id)).toMatchObject({ state: 'completed', result: 'B' });
      expect(w.events.completed).toHaveBeenCalledTimes(1);
    } finally {
      await w.teardown();
    }
  });
});
