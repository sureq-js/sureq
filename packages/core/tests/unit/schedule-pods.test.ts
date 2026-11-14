import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreUnavailableError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import type { FireScheduleRequest, Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { freezable } from '../helpers/pods.js';
import { spyStore } from '../helpers/spy-store.js';

const HOUR = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('many pods', () => {
  it('schedule: twenty pods fire each tick exactly once', { timeout: 30_000 }, async () => {
    useFakeTime();
    const clock = { t: 5_000_000 };
    const store = new MemoryStore({ clock: () => clock.t });
    const scope: Scope = { namespace: 'default', queue: 'twenty' };
    // Pod wall clocks: every read lands an hour ahead or an hour behind the store, alternately.
    let skew = HOUR;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.t + (skew = -skew));
    const pod = (s: Store) => new Queue('twenty', { store: s, logger: silent, random: () => 0.5, scheduler: { tickMs: 100 } });
    // Pod D dies right after its first fire lands: the store applied it, D never hears back.
    const viewD = freezable(store);
    let first = true;
    const d = pod(spyStore(viewD, {
      fireSchedule: async (s: Scope, r: FireScheduleRequest) => {
        const res = await viewD.fireSchedule(s, r);
        if (!first) return res;
        first = false;
        viewD.freeze();
        throw new StoreUnavailableError('pod died', { operation: 'fireSchedule', retryable: true, outcomeUnknown: true });
      },
    }).store);
    // Pod E freezes between two turns at step 10.
    const viewE = freezable(store);
    const e = pod(viewE);
    const others = Array.from({ length: 18 }, () => pod(store));
    const pods = [d, e, ...others];
    let fired = 0;
    for (const q of pods) q.on('scheduleFired', () => void fired++);
    const { schedule } = await others[0]!.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    const step = async () => {
      clock.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
    };
    d.startScheduler();
    await step();
    expect(viewD.frozen).toBe(true);
    for (const q of [e, ...others]) q.startScheduler();
    for (let i = 2; i <= 30; i++) {
      if (i === 10) viewE.freeze();
      await step();
    }
    const ids = store.dump().jobs.map((j) => j.id).sort();
    expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => `sched:k:${schedule.nextRunAt + 1000 * i}`).sort());
    expect((await store.getSchedule(scope, { key: 'k' }))!.runCount).toBe(30);
    expect(fired).toBe(29);
    viewD.unfreeze();
    viewE.unfreeze();
    for (const q of pods) await q.stopScheduler();
    vi.useRealTimers();
    await Promise.all(pods.map((q) => q.close({ timeoutMs: 100 })));
  });
});
