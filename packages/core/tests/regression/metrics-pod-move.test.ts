import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetricsSnapshot } from '../../src/metrics/catalogue.js';
import { live, twoPods } from '../helpers/pods.js';

let teardown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await teardown?.();
  teardown = undefined;
});

const jobs = (snap: MetricsSnapshot) => Object.fromEntries(snap.samples.filter((s) => s.name === 'sureq_jobs').map((s) => [s.labels['state'], 'value' in s ? s.value : -1]));

describe('metrics across pods', () => {
  it('regression: state counts are identical before and after a pod is killed and replaced', async () => {
    const w = twoPods({ name: 'mv' });
    teardown = w.teardown;
    const { queue: a, view } = w.pod({ freezable: true });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    a.process({ ok: () => 'done', bad: () => Promise.reject(new Error('no')), slow: () => held.then(() => 'late') }, { ...live, concurrency: 10 });
    for (let i = 0; i < 3; i++) {
      await a.add(i, { name: 'ok' });
      await a.add(i, { name: 'bad', maxAttempts: 1 });
      await a.add(i, { name: 'slow' });
      await w.b.cancel((await w.b.add(i, { name: 'idle' })).job.id);
    }
    await vi.advanceTimersByTimeAsync(200);
    const before = jobs(await a.metrics());
    expect(before).toEqual({ waiting: 0, delayed: 0, active: 3, completed: 3, failed: 3, cancelled: 3 });
    expect(jobs(await w.b.metrics())).toEqual(before);

    // pod A is killed: its leases run out and pod C's sweeper takes its jobs back
    view!.freeze();
    w.clock.t += 31_000;
    const c = w.pod().queue;
    c.process({ idle: () => 1 }, live);
    await vi.advanceTimersByTimeAsync(1200);
    const after = jobs(await c.metrics());
    expect(after).toEqual({ ...before, active: 0, waiting: 3 });
    const counts = await c.getCounts();
    for (const state of ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const) expect(after[state], state).toBe(counts[state]);
    release();
  });
});
