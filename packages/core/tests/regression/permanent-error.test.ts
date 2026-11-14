import { describe, expect, it } from 'vitest';
import { MemoryStore, Queue, UnrecoverableError } from '@sureq/core';
import type { JobContext } from '@sureq/core';
import { next, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

describe('permanent errors (regression)', () => {
  it('unrecoverable: regression permanent error runs the handler exactly once', async () => {
    const throwers: Array<(ctx: JobContext) => never> = [
      () => {
        throw new UnrecoverableError('bad');
      },
      (ctx) => ctx.fail(new TypeError('x'), { retry: false }),
    ];
    for (const thrower of throwers) {
      const q = new Queue('perm', { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 } });
      let calls = 0;
      const w = q.process((_job, ctx) => {
        calls++;
        return thrower(ctx);
      }, { ...poll(5) });
      const failed = next<{ reason: string }>(w, 'failed');
      await q.add(1, { maxAttempts: 5 });
      expect((await failed).reason).toBe('unrecoverable');
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toBe(1);
      await q.close();
    }
  });
});
