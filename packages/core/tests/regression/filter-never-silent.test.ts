import { describe, expect, it } from 'vitest';
import { JobRejectedError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';

type Data = { n: number; v: number };

/** A small seeded generator (mulberry32), so a failure replays. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('filter never drops a job silently', () => {
  it('regression: filter: rejected add is never silent', async () => {
    const random = seeded(42);
    const store = new MemoryStore();
    // Refuses about a third of the inputs, and merged values above 1000.
    const q = new Queue<Data>('r', { store, logger: silent, filter: (d, ctx) => (ctx.operation === 'merge' ? d.v <= 1000 : d.v % 3 !== 0) });
    const rejected: unknown[] = [];
    let duplicates = 0;
    q.on('rejected', (e) => void rejected.push(e));
    q.on('duplicate', () => void duplicates++);
    const merge = (j: Readonly<Job<Data>>, inc: Readonly<Data>): Data => ({ n: j.data.n, v: j.data.v + inc.v });
    await q.add({ n: -1, v: 1 }, { id: 'holder' });

    let n = 0;
    const input = () => {
      const i = n++;
      const r = random();
      // a tenth reuse an earlier id under 'ignore'; a few try to merge too much into the holder
      if (r < 0.05) return { data: { n: i, v: 2000 }, opts: { id: 'holder', onDuplicate: merge } };
      const v = Math.floor(random() * 300) * 3 + (r < 0.4 ? 0 : 1);
      return { data: { n: i, v }, opts: r < 0.15 && i > 0 ? { id: `id-${Math.floor(random() * i)}` } : { id: `id-${i}` } };
    };

    let added = 0;
    let refused = 0;
    let inputs = 0;
    let bulkRefused = 0;
    const addedIds = new Set<string>(['holder']);
    for (let call = 0; call < 10; call++) {
      const items = Array.from({ length: 20 }, input);
      const out = await q.addBulk(items);
      inputs += items.length;
      expect(out).toHaveLength(items.length);
      for (const o of out) {
        if (!o.ok) {
          expect(o.error).toBeInstanceOf(JobRejectedError);
          refused++;
          bulkRefused++;
        } else if (o.added) {
          added++;
          addedIds.add(o.job.id);
        }
      }
    }
    for (let i = 0; i < 50; i++) {
      const { data, opts } = input();
      inputs++;
      try {
        const r = await q.add(data, opts);
        if (r.added) {
          added++;
          addedIds.add(r.job.id);
        }
      } catch (e) {
        expect(e).toBeInstanceOf(JobRejectedError);
        refused++;
      }
    }

    expect(bulkRefused).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(bulkRefused);
    expect(rejected).toHaveLength(refused);
    expect(added + refused + duplicates).toBe(inputs);
    const stored = [...(await q.getJobs('waiting', { limit: 1000 }))].map((j) => j.id).sort();
    expect(stored).toEqual([...addedIds].sort());
    await q.close();
  });
});
