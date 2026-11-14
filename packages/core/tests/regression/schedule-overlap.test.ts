import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('schedule overlap (regression)', () => {
  it('regression: overlap: cron run still going when next tick fires does not pile up', async () => {
    useFakeTime();
    const clock = { t: 5_000_000 };
    const store = new MemoryStore({ clock: () => clock.t });
    const q = new Queue('pile', { store, logger: silent, random: () => 0.5, scheduler: { tickMs: 100 } });
    q.process(() => new Promise((r) => setTimeout(r, 5000)), { concurrency: 10, ...poll(10) });
    await q.upsertSchedule('k', { every: '1s', template: { data: 1 } });
    const unfinished = () => store.dump().jobs.filter((j) => ['waiting', 'delayed', 'active'].includes(j.state)).length;
    let most = 0;
    for (let i = 0; i < 20; i++) {
      clock.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      most = Math.max(most, unfinished());
    }
    expect(most).toBe(1);
    expect(store.dump().jobs.length).toBeGreaterThan(2);
    await q.stopScheduler();
    vi.useRealTimers();
    await q.close({ timeoutMs: 100 });
  });
});
