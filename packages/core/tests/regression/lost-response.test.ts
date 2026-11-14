import { describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { clientFor } from '../../src/store/client.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { withLostResponses } from '../helpers/lost-response.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

describe('lost finalising response (regression)', () => {
  it('regression: a complete whose response was lost is repeated with the same token and neither reruns the job nor burns an attempt', async () => {
    useFakeTime();
    try {
      const inner = new MemoryStore({ clock: () => Date.now() });
      const spy = spyStore(withLostResponses(inner, 'complete', 1));
      clientFor(spy.store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
      const q = new Queue('lost', { store: spy.store, logger: silent });
      const errors = vi.fn();
      const leaseLost = vi.fn();
      const completed = vi.fn();
      q.on('error', errors);
      q.on('leaseLost', leaseLost);
      q.on('completed', completed);
      const handler = vi.fn(() => 'ok');
      q.process(handler, { ...poll(50), sweepInterval: 3_600_000 });
      const { job } = await q.add(1);
      await vi.advanceTimersByTimeAsync(500);
      const tokens = spy.calls.filter((c) => c.op === 'complete').map((c) => (c.args[1] as { token: number }).token);
      expect(tokens).toHaveLength(2);
      expect(tokens[1]).toBe(tokens[0]);
      expect(await q.getJob(job.id)).toMatchObject({ state: 'completed', attempt: 1, result: 'ok' });
      expect(handler).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
      expect(leaseLost).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      await q.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
