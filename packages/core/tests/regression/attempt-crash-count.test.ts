import { describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { silent } from '../helpers/harness.js';
import { killClaim, live, twoPods } from '../helpers/pods.js';

describe('attempt and crashCount persistence (regression)', () => {
  it('regression: attempt and crashCount survive reopen and pod move', async () => {
    const w = twoPods({ name: 'm' });
    try {
      const { job } = await w.a.add({}, { name: 'work' });
      w.b.process({ other: () => {} }, live);
      for (let i = 0; i < 2; i++) {
        await killClaim(w.store, 'm', { names: ['work'] });
        w.clock.t += 30_001;
        await vi.advanceTimersByTimeAsync(600);
      }
      w.b.process({ work: () => 'done' }, live);
      await vi.advanceTimersByTimeAsync(200);
      const expected = { state: 'completed', attempt: 3, crashCount: 2, result: 'done' };
      const third = new Queue('m', { store: w.store, logger: silent });
      expect(await third.getJob(job.id)).toMatchObject(expected);
      await third.close();
      await w.store.close();
      await w.store.open();
      expect(await w.store.get(w.scope, job.id)).toMatchObject({ state: 'completed', attempt: 3, crashCount: 2 });
      expect(await w.a.getJob(job.id)).toMatchObject(expected);
    } finally {
      await w.teardown();
    }
  });
});
