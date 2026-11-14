import { afterEach, describe, expect, it, vi } from 'vitest';
import { addAll, batchSetup, closeBatchQueues, gate, ids, steady } from '../helpers/batch.js';
import { silent } from '../helpers/harness.js';
import { Pod, rng } from '../helpers/pods.js';

afterEach(closeBatchQueues);

describe('batch crash (regression)', () => {
  it('regression: batch: buffered jobs survive a crash', async () => {
    for (let round = 0; round < 5; round++) {
      if (round > 0) await closeBatchQueues();
      const random = rng(round + 1);
      const s = batchSetup();
      await addAll(s.q, ids(6));
      const runs = new Map<string, number>();
      const count = (list: readonly { id: string }[]) => list.forEach(({ id }) => runs.set(id, (runs.get(id) ?? 0) + 1));
      const a = new Pod(s.inner, 'b', { logger: silent, leaseDuration: '3s' });
      const g = gate();
      const holding = random() < 0.5;
      a.queue.processBatch(async (batch) => {
        count(batch.jobs);
        await g.p;
      }, { ...steady, batchSize: 3, batchDelay: holding ? '1h' : 0 });
      await vi.advanceTimersByTimeAsync(10 + Math.floor(random() * 500));
      a.kill();
      s.run({ ...steady, batchSize: 3, sweepInterval: 500 }, async (batch) => void count(batch.jobs));
      await vi.advanceTimersByTimeAsync(10_000);
      const jobs = await Promise.all(ids(6).map(async (id) => (await s.q.getJob(id))!));
      expect(jobs.map((j) => j.state), `round ${round} (${holding ? 'holding' : 'running'})`).toEqual(ids(6).map(() => 'completed'));
      expect([...runs.values()].every((n) => n <= 2), `round ${round}: runs per job`).toBe(true);
      expect(runs.size).toBe(6);
      a.view.unfreeze();
      g.open();
      await a.queue.close({ timeoutMs: 100 });
    }
  });
});
