import { describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';

describe('lost wake-up', () => {
  it('worker: an add landing during an empty claim is picked up without waiting a full poll', async () => {
    useFakeTime();
    try {
      // The second claim reads an empty queue, then its answer is held back while a job is added.
      let claims = 0;
      let answer: (() => void) | undefined;
      const store = new MemoryStore({
        clock: () => Date.now(),
        faults: { after: (op) => (op === 'claim' && ++claims === 2 ? new Promise<void>((r) => (answer = r)) : undefined) },
      });
      const q = new Queue('wake', { store, logger: silent, random: () => 0.5 });
      const ran = vi.fn();
      q.process(ran, { pollMin: 60_000, pollMax: 60_000, pollJitter: 0, notify: false });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(answer).toBeDefined();
      await q.add({ n: 1 });
      answer!();
      await vi.advanceTimersByTimeAsync(100);
      expect(ran).toHaveBeenCalledTimes(1);
      const closing = q.close({ timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(10_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});
