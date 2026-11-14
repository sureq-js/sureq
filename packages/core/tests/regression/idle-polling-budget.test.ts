import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('idle polling budget (regression)', () => {
  it('regression: idle workers back off and stay under the claim-rate budget', async () => {
    vi.useFakeTimers();
    const spy = spyStore(new MemoryStore());
    const q = new Queue('idle', { store: spy.store, logger: silent });
    const workers = Array.from({ length: 10 }, () => q.process(() => {}));
    await vi.advanceTimersByTimeAsync(60_000);
    const claims = spy.calls.filter((c) => c.op === 'claim').length;
    // Ten workers at one claim per pollMax (5 s) plus jitter, plus the initial ramp from pollMin.
    expect(claims).toBeLessThanOrEqual((10 * 60) / 5 * 1.3 + 10 * 5);
    expect(claims).toBeGreaterThanOrEqual(10 * 12);
    await Promise.all(workers.map((w) => w.close()));
    await q.close();
  });
});
