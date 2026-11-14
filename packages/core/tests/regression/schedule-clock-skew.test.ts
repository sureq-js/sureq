import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';

const HOUR = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('schedule clock skew (regression)', () => {
  it('regression: pod clocks disagree schedule fires once at store time', async () => {
    useFakeTime();
    const clock = { t: 1_700_000_000_000 };
    const store = new MemoryStore({ clock: () => clock.t });
    // Pod wall clocks: every read lands an hour ahead or an hour behind the store, alternately.
    let skew = HOUR;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.t + (skew = -skew));
    const pods = [0, 1].map(() => new Queue('skew-sched', { store, logger: silent, random: () => 0.5, scheduler: { tickMs: 100 } }));
    const { schedule } = await pods[0]!.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    for (const q of pods) q.startScheduler();
    for (let i = 0; i < 20; i++) {
      clock.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
    }
    const ticks = store.dump().jobs.map((j) => j.scheduledFor).sort((a, b) => a! - b!);
    expect(ticks).toEqual(Array.from({ length: 20 }, (_, i) => schedule.nextRunAt + 1000 * i));
    for (const q of pods) await q.stopScheduler();
    vi.useRealTimers();
    await Promise.all(pods.map((q) => q.close()));
  });
});
