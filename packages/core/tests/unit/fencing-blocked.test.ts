import { describe, expect, it } from 'vitest';
import { blockedWorker } from '../helpers/pods.js';

describe('fencing of a blocked worker', () => {
  it('fencing: a worker blocked past lease expiry cannot commit and emits leaseLost', async () => {
    const w = await blockedWorker();
    try {
      expect(w.reclaimed).toMatchObject({ state: 'completed', attempt: 2, crashCount: 1 });
      expect(w.reclaimed.token).toBeGreaterThan(w.first.token);
      expect(w.events.leaseLostA).toHaveBeenCalledTimes(1);
      expect(w.events.leaseLostA.mock.calls[0]![0]).toMatchObject({ job: { id: w.job.id }, token: w.first.token });
      expect(w.events.leaseLostA.mock.calls[0]![0].reason).toBe('superseded');
      expect(w.events.completedA).not.toHaveBeenCalled();
      expect(w.events.failedA).not.toHaveBeenCalled();
      expect(await w.a.getJob(w.job.id)).toMatchObject({ state: 'completed', result: 'B', attempt: 2, crashCount: 1 });
      expect(w.events.completed).toHaveBeenCalledTimes(1);
    } finally {
      await w.teardown();
    }
  });
});
