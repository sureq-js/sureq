import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import { poll } from '../helpers/poll.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('two pods on one store', () => {
  it('worker: two queues on one store process 500 jobs with no duplicates', async () => {
    const store = new MemoryStore();
    const qa = new Queue('q', { store, logger: silent });
    const qb = new Queue('q', { store, logger: silent });
    const seen = new Map<string, number>();
    const handler = async (job: { id: string }) => {
      await new Promise((r) => setImmediate(r));
      seen.set(job.id, (seen.get(job.id) ?? 0) + 1);
    };
    let completed = 0;
    const all = new Promise<void>((resolve) => {
      for (const q of [qa, qb]) q.on('completed', () => void (++completed === 500 && resolve()));
    });
    // qb is never woken by qa's adds, so it polls quickly to take a share.
    qa.process(handler, { concurrency: 5 });
    qb.process(handler, { concurrency: 5, ...poll(5) });
    await qa.addBulk(Array.from({ length: 500 }, (_, i) => ({ data: i })));
    await all;
    await Promise.all([qa.close(), qb.close()]);
    expect(seen.size).toBe(500);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect((await store.counts(qa.internals.scope)).completed).toBe(500);
  });
});
