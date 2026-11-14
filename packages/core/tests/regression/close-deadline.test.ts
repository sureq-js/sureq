import { describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';

describe('close deadline', () => {
  it('worker: close deadline counts from the close call even with a claim in flight', async () => {
    useFakeTime();
    try {
      // The first claim takes the job; every later claim hangs.
      let claims = 0;
      const store = new MemoryStore({
        clock: () => Date.now(),
        faults: { before: (op) => (op === 'claim' && ++claims > 1 ? new Promise<void>(() => {}) : undefined) },
      });
      const q = new Queue('deadline', { store, logger: silent, storeCallTimeout: '1h', random: () => 0.5 });
      let abortedAt: number | undefined;
      await q.add({ n: 1 });
      const w = q.process((_job, ctx) => new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          abortedAt = Date.now();
          resolve();
        });
      }), { concurrency: 2, pollMin: 10, pollMax: 10 });
      await vi.advanceTimersByTimeAsync(50);
      expect(w.inFlight).toBe(1);
      expect(claims).toBeGreaterThan(1);
      const closedAt = Date.now();
      const closing = w.close({ timeoutMs: 1000 });
      // The abort follows the deadline by one timer tick.
      await vi.advanceTimersByTimeAsync(1001);
      expect(abortedAt).toBeDefined();
      expect(abortedAt! - closedAt).toBeLessThanOrEqual(1001);
      await vi.advanceTimersByTimeAsync(10_000);
      await closing;
      await q.close({ timeoutMs: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
