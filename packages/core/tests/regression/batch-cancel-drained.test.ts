import { afterEach, describe, expect, it, vi } from 'vitest';
import { addAll, batchSetup, closeBatchQueues, ids } from '../helpers/batch.js';

afterEach(closeBatchQueues);

describe('batch cancel and drained (regression)', () => {
  it('regression: batch-cancel: drained fires after cancelling held jobs', async () => {
    const s = batchSetup();
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 5, batchDelay: '1h' });
    const drained = vi.fn();
    s.q.on('drained', drained);
    await vi.advanceTimersByTimeAsync(100);
    for (const id of ids(3)) await s.q.cancel(id);
    await vi.advanceTimersByTimeAsync(100);
    expect(drained).toHaveBeenCalledTimes(1);
    expect(w.batch.held).toBe(0);
    await expect(w.batch.flush()).resolves.toBe(0);
    expect(s.calls).toEqual([]);
  });
});
