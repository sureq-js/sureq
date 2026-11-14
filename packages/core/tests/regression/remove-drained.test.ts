import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, Queue } from '@sureq/core';
import { silent } from '../helpers/harness.js';

describe('remove keeps counts exact (regression)', () => {
  it('counts: remove of a queued job keeps counts exact and drained fires', async () => {
    const q = new Queue('rmd', { store: new MemoryStore(), logger: silent });
    const drained = vi.fn();
    q.on('drained', drained);
    const jobs = await Promise.all([1, 2, 3].map(async (i) => (await q.add(i)).job));
    await q.remove(jobs[0]!.id);
    await q.remove(jobs[1]!.id);
    expect((await q.getCounts()).waiting).toBe(1);
    expect(drained).not.toHaveBeenCalled();
    await q.remove(jobs[2]!.id);
    const { blocked, ...counts } = await q.getCounts();
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(blocked).toBe(0);
    expect(drained).toHaveBeenCalledOnce();
    await q.close();
  });
});
