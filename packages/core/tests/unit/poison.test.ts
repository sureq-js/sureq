import { describe, expect, it, vi } from 'vitest';
import type { QueueEvents } from '../../src/events/types.js';
import type { Job } from '../../src/job/job.js';
import type { QueueOptions } from '../../src/queue/options.js';
import type { SweepRequest } from '../../src/store/contract.js';
import { killClaim, live, twoPods } from '../helpers/pods.js';

type Stalled = QueueEvents<Job>['stalled'];
type Failed = QueueEvents<Job>['failed'];

/**
 * Pod B sweeps but never claims the `poison` job (it only handles `other`); each round a worker
 * claims it through the store and dies, and the store clock passes its lease.
 */
async function poisonWorld(queue: QueueOptions = {}) {
  const w = twoPods({ name: 'p', queue: { defaultJobOptions: { maxAttempts: 10 }, ...queue } });
  const sweep = vi.spyOn(w.store, 'sweep');
  const stalled: Stalled[] = [];
  const failed: Failed[] = [];
  w.b.on('stalled', (e) => void stalled.push(e));
  w.b.on('failed', (e) => void failed.push(e));
  w.b.process({ other: () => {} }, live);
  const { job } = await w.b.add({}, { name: 'poison' });
  const crash = async () => {
    await killClaim(w.store, 'p', { names: ['poison'] });
    w.clock.t += 30_001;
    await vi.advanceTimersByTimeAsync(600);
    return w.b.getJob(job.id);
  };
  return { ...w, job, crash, stalled, failed, sweep };
}

describe('poison-pill limit', () => {
  it('poison: job whose worker is killed 3 times ends failed with PoisonPillError', async () => {
    const w = await poisonWorld();
    try {
      expect(await w.crash()).toMatchObject({ state: 'waiting', crashCount: 1 });
      expect(await w.crash()).toMatchObject({ state: 'waiting', crashCount: 2 });
      const end = (await w.crash())!;
      expect(end).toMatchObject({ state: 'failed', crashCount: 3, attempt: 3 });
      expect(end.error).toMatchObject({ name: 'PoisonPillError', code: 'POISON_PILL' });
      expect(w.failed).toHaveLength(1);
      expect(w.failed[0]).toMatchObject({ reason: 'unrecoverable', error: { code: 'POISON_PILL' } });
    } finally {
      await w.teardown();
    }
  });

  it('poison: stalled event reports crashCount and action', async () => {
    const w = await poisonWorld();
    try {
      for (let i = 0; i < 3; i++) await w.crash();
      expect(w.stalled.map(({ job, ...rest }) => ({ id: job.id, ...rest }))).toEqual([
        { id: w.job.id, crashCount: 1, action: 'requeued', previousWorkerId: expect.stringMatching(/^dead-/) },
        { id: w.job.id, crashCount: 2, action: 'requeued', previousWorkerId: expect.stringMatching(/^dead-/) },
        { id: w.job.id, crashCount: 3, action: 'failed', previousWorkerId: expect.stringMatching(/^dead-/) },
      ]);
      expect(new Set(w.stalled.map((e) => e.previousWorkerId)).size).toBe(3);
      expect(w.stalled[2]!.job.state).toBe('failed');
    } finally {
      await w.teardown();
    }
  });

  it('poison: the crash limit wins over attempts, and attempts end the job when crashes are left', async () => {
    const both = await poisonWorld({ defaultJobOptions: { maxAttempts: 3 } });
    try {
      for (let i = 0; i < 3; i++) await both.crash();
      expect((await both.b.getJob(both.job.id))!.error).toMatchObject({ code: 'POISON_PILL' });
    } finally {
      await both.teardown();
    }
    const attempts = await poisonWorld({ defaultJobOptions: { maxAttempts: 3 }, maxCrashes: 5 });
    try {
      for (let i = 0; i < 3; i++) await attempts.crash();
      expect(await attempts.b.getJob(attempts.job.id)).toMatchObject({ state: 'failed', crashCount: 3, error: { code: 'JOB_STALLED' } });
      expect(attempts.failed[0]).toMatchObject({ reason: 'attempts-exhausted', error: { code: 'JOB_STALLED' } });
    } finally {
      await attempts.teardown();
    }
  });

  it('poison: sweep request maxCrashes decides the limit', async () => {
    const w = await poisonWorld({ maxCrashes: 1 });
    try {
      expect(await w.crash()).toMatchObject({ state: 'failed', crashCount: 1, error: { code: 'POISON_PILL' } });
      expect(w.sweep.mock.calls[0]![1]).toMatchObject({ maxCrashes: 1 });
    } finally {
      await w.teardown();
    }
  });

  it('poison: the stored poison error reports the job\'s id and crash count', async () => {
    const w = await poisonWorld();
    try {
      for (let i = 0; i < 3; i++) await w.crash();
      const fields = { jobId: w.job.id, crashCount: 3, maxCrashes: 3 };
      expect((await w.b.getJob(w.job.id))!.error).toMatchObject({ name: 'PoisonPillError', props: fields });
      expect(w.failed[0]!.error).toMatchObject({ name: 'PoisonPillError', props: fields });
      const sent = JSON.parse((w.sweep.mock.calls[0]![1] as SweepRequest).poisonError as string) as Record<string, Record<string, unknown>>;
      for (const key of ['jobId', 'crashCount']) {
        expect(sent).not.toHaveProperty(key);
        expect(sent['props']).not.toHaveProperty(key);
      }
    } finally {
      await w.teardown();
    }
  });

  it('poison: crashCount survives a later normal failure', async () => {
    const w = twoPods({ name: 'p', queue: { defaultJobOptions: { maxAttempts: 2, backoff: { type: 'fixed', delay: 0 } } } });
    try {
      const { job } = await w.b.add({});
      await killClaim(w.store, 'p');
      w.clock.t += 30_001;
      const failed = vi.fn();
      w.b.on('failed', failed);
      w.b.process(() => {
        throw new Error('normal failure');
      }, live);
      await vi.advanceTimersByTimeAsync(700);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'failed', attempt: 2, crashCount: 1, error: { message: 'normal failure' } });
    } finally {
      await w.teardown();
    }
  });
});
