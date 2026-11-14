import { describe, expect, it, vi } from 'vitest';
import type { QueueEvents } from '../../src/events/types.js';
import type { Job } from '../../src/job/job.js';
import { killClaim, live, twoPods } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';

const LEASE = 30_000;

describe('stalled-job recovery (regression)', () => {
  it("regression: killed worker's job is recovered by another live pod without restart", async () => {
    const w = twoPods({ name: 'r', wallClock: true });
    try {
      const { job } = await w.a.add({});
      await killClaim(w.store, 'r');
      const claimedAt = Date.now();
      let doneAt: number | undefined;
      w.b.on('completed', () => void (doneAt ??= Date.now()));
      w.b.process(() => 'B', live);
      await vi.advanceTimersByTimeAsync(LEASE - 1);
      expect(doneAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1 + 500 * 1.2 + 50);
      expect(doneAt! - claimedAt).toBeGreaterThanOrEqual(LEASE);
      expect(doneAt! - claimedAt).toBeLessThanOrEqual(LEASE + 500 * 1.2 + 50);
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'completed', result: 'B', attempt: 2, crashCount: 1 });
    } finally {
      await w.teardown();
    }
  });

  it("regression: crashed worker's jobs are claimable by another live pod within leaseDuration plus sweepInterval", async () => {
    const w = twoPods({ name: 'r', wallClock: true });
    try {
      for (let i = 0; i < 5; i++) await w.a.add({ i });
      for (let i = 0; i < 5; i++) await killClaim(w.store, 'r');
      const ran: string[] = [];
      const swept: string[] = [];
      w.b.on('stalled', (e) => void swept.push(e.job.id));
      w.b.process((job) => void ran.push(job.id), { ...live, concurrency: 5 });
      await vi.advanceTimersByTimeAsync(LEASE - 1);
      expect(ran).toEqual([]);
      await vi.advanceTimersByTimeAsync(1 + 500 * 1.2);
      expect(ran).toHaveLength(5);
      expect((await w.b.getCounts()).completed).toBe(5);
      expect(ran).toEqual(swept);
    } finally {
      await w.teardown();
    }
  });

  it('regression: restarted pod does not claim or touch active jobs with live leases', async () => {
    const w = twoPods({ name: 'r', wallClock: true });
    try {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const { job } = await w.a.add({});
      w.a.process(() => gate, { ...poll(50), random: () => 0.5 });
      await vi.advanceTimersByTimeAsync(10);
      const before = (await w.store.get(w.scope, job.id))!;
      expect(before.state).toBe('active');
      const second = vi.fn();
      const stalled = vi.fn();
      w.b.on('stalled', stalled);
      w.b.process(second, live);
      for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(1000);
      expect(await w.store.get(w.scope, job.id)).toMatchObject({ state: 'active', attempt: before.attempt, token: before.token, crashCount: 0 });
      expect(second).not.toHaveBeenCalled();
      expect(stalled).not.toHaveBeenCalled();
      open();
      await vi.advanceTimersByTimeAsync(10);
      expect(await w.a.getJob(job.id)).toMatchObject({ state: 'completed', attempt: 1 });
    } finally {
      await w.teardown();
    }
  });

  it('regression: a job that kills its worker is failed after maxCrashes, not retried forever', async () => {
    const w = twoPods({ name: 'r', queue: { defaultJobOptions: { maxAttempts: 10 } } });
    try {
      const failed: Array<QueueEvents<Job>['failed']> = [];
      w.b.on('failed', (e) => void failed.push(e));
      const others = [(await w.b.add({}, { name: 'other' })).job.id, (await w.b.add({}, { name: 'other' })).job.id];
      const { job } = await w.b.add({}, { name: 'crash' });
      w.b.process({ other: () => 'ok' }, live);
      await vi.advanceTimersByTimeAsync(100);
      // Each claim of `crash` kills its worker: claimed through the store, never finished.
      for (let i = 0; i < 3; i++) {
        expect((await w.b.getJob(job.id))!.state).toBe('waiting');
        await killClaim(w.store, 'r', { names: ['crash'] });
        w.clock.t += 30_001;
        await vi.advanceTimersByTimeAsync(600);
      }
      w.clock.t += 60_000;
      await vi.advanceTimersByTimeAsync(5000);
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'failed', attempt: 3, crashCount: 3, error: { code: 'POISON_PILL' } });
      expect(failed.map((e) => e.job.id)).toEqual([job.id]);
      for (const id of others) expect(await w.b.getJob(id)).toMatchObject({ state: 'completed', result: 'ok' });
    } finally {
      await w.teardown();
    }
  });
});
