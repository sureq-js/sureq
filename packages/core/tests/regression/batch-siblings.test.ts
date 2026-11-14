import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskFailure } from '../../src/worker/batch.js';
import { addAll, batchSetup, closeBatchQueues, gate, ids } from '../helpers/batch.js';

afterEach(closeBatchQueues);

describe('batch siblings (regression)', () => {
  it('regression: batch-result: failing one task does not fail its batch', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(5));
    const w = s.run({ batchSize: 5 }, async () => [1, 2, new TaskFailure(new Error('third')), 4, 5]);
    const seen: string[] = [];
    for (const e of ['completed', 'failed', 'retrying'] as const) w.on(e, (p) => void seen.push(`${e}:${p.job.id}`));
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.sort()).toEqual(['completed:j1', 'completed:j2', 'completed:j4', 'completed:j5', 'retrying:j3']);
    const jobs = await Promise.all(ids(5).map(async (id) => (await s.q.getJob(id))!));
    expect(jobs.map((j) => j.attempt)).toEqual([1, 1, 1, 1, 1]);
    expect(jobs.map((j) => j.state)).toEqual(['completed', 'completed', 'delayed', 'completed', 'completed']);
  });

  it('regression: batch-cancel: cancelling one task does not fail its batch', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(5));
    const g = gate();
    const w = s.run({ batchSize: 5 }, async () => {
      await g.p;
      return [1, 2, 3, 4, 5];
    });
    const seen: string[] = [];
    for (const e of ['completed', 'failed', 'retrying'] as const) w.on(e, (p) => void seen.push(`${e}:${p.job.id}`));
    await vi.advanceTimersByTimeAsync(100);
    await s.q.cancel('j2');
    g.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.sort()).toEqual(['completed:j1', 'completed:j3', 'completed:j4', 'completed:j5']);
    const jobs = await Promise.all(ids(5).map(async (id) => (await s.q.getJob(id))!));
    expect(jobs.map((j) => j.state)).toEqual(['completed', 'cancelled', 'completed', 'completed', 'completed']);
    expect(jobs.map((j) => j.attempt)).toEqual([1, 1, 1, 1, 1]);
  });
});
