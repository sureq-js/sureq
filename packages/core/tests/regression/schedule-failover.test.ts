import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreUnavailableError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import type { FireScheduleRequest, Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { freezable } from '../helpers/pods.js';
import { spyStore } from '../helpers/spy-store.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function world() {
  useFakeTime();
  const clock = { t: 5_000_000 };
  const store = new MemoryStore({ clock: () => clock.t });
  const scope: Scope = { namespace: 'default', queue: 'failover' };
  const pods: Queue[] = [];
  const pod = (s: Store = store) => {
    const q = new Queue('failover', { store: s, logger: silent, random: () => 0.5, scheduler: { tickMs: 100 } });
    pods.push(q);
    return q;
  };
  const step = async (ms = 1000) => {
    clock.t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const ticks = () => store.dump().jobs.map((j) => j.scheduledFor!).sort((a, b) => a - b);
  const end = async () => {
    for (const q of pods) await q.stopScheduler();
    vi.useRealTimers();
    await Promise.all(pods.map((q) => q.close({ timeoutMs: 100 })));
  };
  return { clock, store, scope, pod, step, ticks, end };
}

describe('schedule failover (regression)', () => {
  it('regression: a schedule fires each tick once when the firing pod dies mid-fire', async () => {
    const w = world();
    const view = freezable(w.store);
    let first = true;
    const dying = w.pod(spyStore(view, {
      fireSchedule: async (s: Scope, r: FireScheduleRequest) => {
        const res = await view.fireSchedule(s, r);
        if (first) {
          first = false;
          view.freeze();
          throw new StoreUnavailableError('pod died', { operation: 'fireSchedule', retryable: true, outcomeUnknown: true });
        }
        return res;
      },
    }).store);
    const others = [w.pod(), w.pod()];
    const { schedule } = await others[0]!.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    dying.startScheduler();
    await w.step();
    for (const q of others) q.startScheduler();
    for (let i = 1; i < 10; i++) await w.step();
    expect(w.ticks()).toEqual(Array.from({ length: 10 }, (_, i) => schedule.nextRunAt + 1000 * i));
    view.unfreeze();
    await w.end();
  });

  it('regression: after downtime of many periods a schedule fires one catch-up job, then resumes', async () => {
    const w = world();
    const q = w.pod();
    const { schedule } = await q.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    w.clock.t += 50_000;
    w.pod().startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.ticks()).toEqual([schedule.nextRunAt]);
    for (let i = 0; i < 3; i++) await w.step();
    expect(w.ticks()).toEqual([schedule.nextRunAt, ...[51, 52, 53].map((n) => schedule.anchorAt! + 1000 * n)]);
    await w.end();
  });
});
