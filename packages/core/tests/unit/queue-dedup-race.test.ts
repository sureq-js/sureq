import { describe, expect, it } from 'vitest';
import { MergeConflictError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';

type Data = { ids: number[] };
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const union = (e: Readonly<Job<Data>>, i: Readonly<Data>): Data => ({ ids: [...e.data.ids, ...i.ids] });
const PRODUCERS = 20;

describe('same id from many queues', () => {
  it.each(['ignore', 'replace', 'merge'] as const)('dedup: twenty queues adding one id at once create exactly one job (%s)', async (rule) => {
    const store = new MemoryStore();
    const queues = Array.from({ length: PRODUCERS }, () => new Queue<Data>('race', { store, logger: silent }));
    for (let round = 0; round < 50; round++) {
      const id = `same-${round}`;
      const onDuplicate = rule === 'merge' ? union : rule;
      const settled = await Promise.allSettled(queues.map((q, n) => q.add({ ids: [n] }, { id, onDuplicate })));
      const stored = (await queues[0]!.getJob(id))!;
      const ok = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
      expect(ok.filter((r) => r.added)).toHaveLength(1);
      if (rule !== 'merge') {
        expect(ok).toHaveLength(PRODUCERS);
        const action = rule === 'ignore' ? 'ignored' : 'replaced';
        expect(ok.filter((r) => !r.added).every((r) => r.duplicate?.action === action)).toBe(true);
        expect(stored.data.ids).toHaveLength(1);
        expect(stored.data.ids[0]).toBeLessThan(PRODUCERS);
      } else {
        expect(stored.data.ids.length, 'more than one merge landed').toBeGreaterThan(1);
        for (const [n, s] of settled.entries()) {
          if (s.status === 'fulfilled') expect(stored.data.ids.filter((x) => x === n)).toHaveLength(1);
          else {
            expect(s.reason).toBeInstanceOf(MergeConflictError);
            expect(stored.data.ids).not.toContain(n);
          }
        }
      }
      await queues[0]!.remove(id);
      const counts = await queues[0]!.getCounts();
      expect(counts.waiting + counts.delayed + counts.active).toBe(0);
    }
    await Promise.all(queues.map((q) => q.close()));
  });
});
