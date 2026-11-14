import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import type { JobContext } from '../../src/worker/context.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('throwing handler slot (regression)', () => {
  it('concurrency: regression throwing handler does not lose a slot', async () => {
    const store = new MemoryStore();
    const q = new Queue('slots', { store, logger: silent });
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
    await q.addBulk(Array.from({ length: 100 }, (_, i) => ({ data: i, opts: { maxAttempts: 1 } })));
    await vi.waitFor(
      async () => {
        const c = await store.counts(q.internals.scope);
        expect(c.completed + c.failed).toBe(100);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(() => expect(w.inFlight).toBe(0));
    expect((await store.counts(q.internals.scope)).completed).toBe(20);
    await q.close();
  });
});
