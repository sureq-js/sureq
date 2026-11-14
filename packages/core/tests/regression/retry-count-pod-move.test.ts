import { describe, expect, it } from 'vitest';
import { MemoryStore, Queue } from '@sureq/core';
import { next, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

describe('retry count across a crash (regression)', () => {
  it('attempts: regression retry count survives crash and pod move', async () => {
    const c = { t: 1_000_000 };
    const store = new MemoryStore({ clock: () => c.t });
    const podA = new Queue('move', { store, logger: silent, defaultJobOptions: { backoff: 1000 } });
    const workerA = podA.process(() => {
      throw new TypeError('attempt 1 broke');
    }, { ...poll(5) });
    const retrying = next(workerA, 'retrying');
    const { job } = await podA.add(1, { maxAttempts: 3 });
    await retrying;
    // Crash: pod A is never used or closed gracefully again. Only the store remembers the attempt.
    void workerA.close();
    const podB = new Queue('move', { store, logger: silent });
    const seen: number[] = [];
    const workerB = podB.process((_job, ctx) => void seen.push(ctx.attempt), { ...poll(5) });
    const completed = next(workerB, 'completed');
    c.t += 1000;
    await completed;
    expect(seen).toEqual([2]);
    const final = (await podB.getJob(job.id))!;
    expect(final).toMatchObject({ state: 'completed', attempt: 2 });
    expect(final.failedReason!.message).toBe('attempt 1 broke');
    await podB.close();
  });
});
