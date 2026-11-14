import { describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';

describe('hung store call', () => {
  it('sweeper: a hung sweep surfaces a stalled warning in health', async () => {
    useFakeTime();
    try {
      // Every sweep waits forever; every other operation, now() included, answers at once.
      const store = new MemoryStore({ clock: () => Date.now(), faults: { before: (op) => (op === 'sweep' ? new Promise(() => {}) : undefined) } });
      const q = new Queue('hung', { store, logger: silent, storeCallTimeout: '1h', random: () => 0.5 });
      const errors = vi.fn();
      q.on('error', errors);
      q.process(() => 'ok', { sweepInterval: 1000 });
      await vi.advanceTimersByTimeAsync(5 * 1000 + 1500);
      const health = await q.health();
      expect(health.warnings.map((w) => w.code)).toContain('SWEEP_STALLED');

      // At the deadline the hung sweep is reported as a store failure instead of waiting for ever.
      expect(errors).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(errors.mock.calls.map((c) => c[0])).toContainEqual(
        expect.objectContaining({ source: 'store', error: expect.objectContaining({ code: 'STORE_UNAVAILABLE', operation: 'sweep' }) }),
      );
      const closing = q.close({ timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(10_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});
