import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseLostError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import { live, twoPods } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';

let teardown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await teardown?.();
  teardown = undefined;
});

describe('progress across pods', () => {
  it('regression: progress survives a pod move and is readable from another queue instance', async () => {
    const w = twoPods({ name: 'pm' });
    teardown = w.teardown;
    const { queue: a, view } = w.pod({ freezable: true });
    let reported!: () => void;
    const progressed = new Promise<void>((r) => (reported = r));
    let resume!: () => void;
    const resumed = new Promise<void>((r) => (resume = r));
    let late: unknown;
    const { job } = await a.add({ n: 1 });
    a.process(async (_j, ctx) => {
      w.clock.t += 10_000;
      await ctx.progress(25, 100, 'resizing');
      reported();
      await resumed;
      late = await ctx.progress(90, 100).then(() => 'stored', (e: unknown) => e);
      return 'A';
    }, { ...poll(50), random: () => 0.5, sweepInterval: 3_600_000 });
    await vi.advanceTimersByTimeAsync(10);
    await progressed;
    // Pod A stops answering: no heartbeat reaches the store.
    view!.freeze();
    const seen = (await w.b.getJob(job.id))!.progress;
    expect(seen).toMatchObject({ kind: 'counter', n: 25, total: 100, message: 'resizing', percent: 25, etaMs: 30_000 });
    expect(seen).toMatchObject({ etaAt: (seen as { updatedAt: number }).updatedAt + 30_000 });

    w.clock.t += 31_000;
    const onB: Array<Job['progress']> = [];
    let finishB!: () => void;
    const holdB = new Promise<void>((r) => (finishB = r));
    w.b.process(async (j) => {
      onB.push(j.progress);
      await holdB;
      return 'B';
    }, live);
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(600);
    expect(onB).toEqual([null]);
    expect((await w.b.getJob(job.id))!).toMatchObject({ state: 'active', attempt: 2, progress: null });

    view!.unfreeze();
    resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(late).toBeInstanceOf(LeaseLostError);
    expect((await w.b.getJob(job.id))!.progress).toBeNull();
    finishB();
    await vi.advanceTimersByTimeAsync(100);
    expect((await w.b.getJob(job.id))!).toMatchObject({ state: 'completed', result: 'B', progress: null });
  });
});
