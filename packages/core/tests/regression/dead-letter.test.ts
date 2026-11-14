import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, Queue, UnrecoverableError } from '@sureq/core';
import { next, silent } from '../helpers/harness.js';
import { killClaim, live, twoPods } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';

describe('dead letters (regression)', () => {
  it('regression: poison pill ends in the DLQ and does not crash-loop', async () => {
    const w = twoPods({ name: 'poison', queue: { maxCrashes: 2, defaultJobOptions: { maxAttempts: 10 } } });
    try {
      // pod B sweeps but has no handler for the poison job; each round a worker claims it and dies
      w.b.process({ other: () => {} }, live);
      const { job } = await w.b.add({}, { name: 'poison' });
      for (let i = 0; i < 2; i++) {
        await killClaim(w.store, 'poison', { names: ['poison'] });
        w.clock.t += 30_001;
        await vi.advanceTimersByTimeAsync(600);
      }
      const dead = (await w.b.getJob(job.id))!;
      expect(dead).toMatchObject({ state: 'failed', crashCount: 2, attempt: 2, deadLetter: { reason: 'crashLimit' } });
      const handler = vi.fn();
      w.a.process({ poison: handler }, live);
      await vi.advanceTimersByTimeAsync(3 * 600);
      expect(handler).not.toHaveBeenCalled();
      expect(await w.b.getJob(job.id)).toMatchObject({ state: 'failed', attempt: 2, token: dead.token });
      expect(await w.b.countDeadLetters({ reason: 'crashLimit' })).toBe(1);
    } finally {
      await w.teardown();
    }
  });

  it('regression: UnrecoverableError goes to the DLQ after one attempt', async () => {
    const q = new Queue('perm', { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 } });
    const handler = vi.fn(() => Promise.reject(new UnrecoverableError('bad input')));
    const w = q.process(handler, poll(5));
    const dead = next(w, 'deadLettered');
    const { job } = await q.add(1, { maxAttempts: 5 });
    expect(await dead).toMatchObject({ reason: 'unrecoverable' });
    expect(await q.getJob(job.id)).toMatchObject({ state: 'failed', attempt: 1, deadLetter: { reason: 'unrecoverable' } });
    expect(handler).toHaveBeenCalledOnce();
    await q.close();
  });

  it('regression: failed job is still visible with error and history', async () => {
    const q = new Queue('visible', { store: new MemoryStore(), logger: silent, defaultJobOptions: { backoff: 0 } });
    const w = q.process((job) => Promise.reject(new TypeError(`try ${job.attempt}`)), poll(5));
    const dead = next(w, 'deadLettered');
    const { job } = await q.add(1, { maxAttempts: 3 });
    await dead;
    const failed = (await q.getJob(job.id))!;
    expect(failed).toMatchObject({ state: 'failed', error: { name: 'TypeError', message: 'try 3' }, failedReason: { message: 'try 3' } });
    expect(failed.deadLetter).toEqual({ at: failed.finishedAt, reason: 'exhausted' });
    expect((await failed.getAttempts()).map((r) => [r.attempt, r.outcome, r.error?.message])).toEqual([
      [1, 'failed', 'try 1'], [2, 'failed', 'try 2'], [3, 'failed', 'try 3'],
    ]);
    expect((await q.getDeadLetters()).jobs.map((j) => j.id)).toEqual([job.id]);
    await q.close();
  });
});
