import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, Queue } from '@sureq/core';
import { next, silent } from '../helpers/harness.js';
import { live, twoPods } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';

describe('attempt trail (regression)', () => {
  it('regression: finished jobs keep their attempt trail', async () => {
    const q = new Queue('trail', { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 } });
    const w = q.process((job) => {
      if (job.attempt === 1) throw new TypeError('first try');
      return 'ok';
    }, poll(5));
    const completed = next(w, 'completed');
    const { job } = await q.add(1);
    await completed;
    const done = await q.getJob(job.id);
    expect(done).toMatchObject({ state: 'completed', attempt: 2 });
    const rows = await done!.getAttempts();
    expect(rows.map((r) => [r.attempt, r.outcome, r.error?.message ?? null])).toEqual([[1, 'failed', 'first try'], [2, 'completed', null]]);
    await q.close();
  });

  it('regression: stale completion after reclaim shows two attempts', async () => {
    const w = twoPods({ name: 'stale' });
    try {
      const a = w.pod({ freezable: true });
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const { job } = await w.b.add({});
      const first = a.queue.process(async () => {
        await gate;
        return 'A';
      }, { ...poll(50), random: () => 0.5 });
      await vi.advanceTimersByTimeAsync(10);
      const claimed = (await w.store.get(w.scope, job.id))!;
      expect(claimed.state).toBe('active');
      a.view!.freeze();
      open();
      await vi.advanceTimersByTimeAsync(10);
      w.clock.t += 30_001;
      w.b.process(() => 'B', live);
      await vi.advanceTimersByTimeAsync(600);
      a.view!.unfreeze();
      await vi.advanceTimersByTimeAsync(10);
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'completed', result: 'B', attempt: 2 });
      const rows = (await w.b.getAttempts(job.id)).attempts;
      expect(rows.map((r) => [r.attempt, r.outcome, r.workerId])).toEqual([[1, 'crashed', first.id], [2, 'completed', expect.any(String)]]);
      expect(rows[0]!.token).toBe(claimed.token);
      expect(rows[1]!.token).toBeGreaterThan(claimed.token);
      expect(rows[0]!.error).toMatchObject({ name: 'LeaseExpired', props: { workerId: first.id } });
    } finally {
      await w.teardown();
    }
  });
});
