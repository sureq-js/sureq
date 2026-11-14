import { describe, expect, it } from 'vitest';
import { MemoryStore, Queue } from '@sureq/core';
import { next, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

describe('retry limit (regression)', () => {
  it('attempts: regression retry limit is not off by one', async () => {
    for (const maxAttempts of [3, 1]) {
      const q = new Queue('limit', { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 } });
      const lastSeenOn: number[] = [];
      let calls = 0;
      const w = q.process((_job, ctx) => {
        calls++;
        if (ctx.isLastAttempt) lastSeenOn.push(calls);
        throw new TypeError('always');
      }, { ...poll(5) });
      const failed = next<{ reason: string }>(w, 'failed');
      const { job } = await q.add(1, { maxAttempts });
      expect((await failed).reason).toBe('attempts-exhausted');
      expect(calls).toBe(maxAttempts);
      expect((await q.getJob(job.id))!.attempt).toBe(maxAttempts);
      expect(lastSeenOn).toEqual([maxAttempts]);
      await q.close();
    }
  });
});
