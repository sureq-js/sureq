import { afterEach, describe, expect, it } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';

const open: Queue[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((q) => q.close()));
});

describe('regression', () => {
  it('regression: counts and drained are correct after drain and clean', async () => {
    for (const empty of [(q: Queue) => q.drain(), (q: Queue) => q.clean('waiting', 0)]) {
      const q = new Queue('drained', { store: new MemoryStore(), logger: silent });
      open.push(q);
      let drained = 0;
      q.on('drained', () => void drained++);
      await q.addBulk([{ data: 1 }, { data: 2 }, { data: 3 }]);
      await empty(q);
      expect(drained).toBe(1);
      expect(await q.getCounts()).toEqual({ waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 });
    }
  });
});
