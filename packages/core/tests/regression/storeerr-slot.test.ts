import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, Queue } from '@sureq/core';
import type { JobContext } from '@sureq/core';
import { failing } from '../helpers/faults.js';
import { silent } from '../helpers/harness.js';

describe('slots under store and handler failures (regression)', () => {
  it('storeerr: regression throwing handler does not lose a slot', async () => {
    // Every 7th complete write fails once; the bounded write retry absorbs it.
    const store = new MemoryStore({ faults: failing((op, n) => (op === 'complete' && n % 7 === 0 ? new TypeError('blip') : undefined)) });
    const q = new Queue('slots', { store, logger: silent });
    q.on('error', () => {});
    const ways: Array<(ctx: JobContext) => unknown> = [
      () => {
        throw new TypeError('sync');
      },
      () => Promise.reject(new TypeError('async')),
      () => Promise.reject('a string'),
      (ctx) => ctx.fail(new TypeError('x'), { retry: false }),
      () => 'ok',
    ];
    const w = q.process((job, ctx) => ways[(job.data as number) % 5]!(ctx), { concurrency: 2 });
    const throwing = () => {
      throw new TypeError('listener');
    };
    w.on('completed', throwing);
    w.on('failed', throwing);
    await q.addBulk(Array.from({ length: 100 }, (_, i) => ({ data: i, opts: { maxAttempts: 1 } })));
    await vi.waitFor(
      async () => {
        const c = await q.getCounts();
        expect(c.completed + c.failed).toBe(100);
      },
      { timeout: 15_000, interval: 20 },
    );
    await vi.waitFor(() => expect(w.inFlight).toBe(0));
    await q.close();
  }, 20_000);
});
