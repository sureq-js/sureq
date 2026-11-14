import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, Queue } from '@sureq/core';
import { next, silent } from '../helpers/harness.js';

describe('cancel keeps counts exact (regression)', () => {
  it('regression: cancel keeps counts correct and fires drained', async () => {
    const q = new Queue('cxd', { store: new MemoryStore(), logger: silent, pollMin: 20, pollMax: 20 });
    const drained = vi.fn();
    q.on('drained', drained);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = q.process(() => gate);
    const started = next(w, 'active');
    const { job: active } = await q.add('a');
    await started;
    await w.pause();
    const { job: waiting } = await q.add('w');
    const { job: delayed } = await q.add('d', { delay: '1h' });
    for (const job of [waiting, delayed, active]) await q.cancel(job.id);
    const { blocked, cancelled, ...rest } = await q.getCounts();
    expect(cancelled).toBe(3);
    expect(blocked).toBe(0);
    expect(Object.values(rest).every((n) => n === 0)).toBe(true);
    expect(drained).toHaveBeenCalledOnce();
    open();
    await q.close();
    expect(drained).toHaveBeenCalledOnce();
  });
});
