import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterError, JobRejectedError } from '../../src/errors/catalog.js';
import type { FilterFn } from '../../src/queue/filter.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('filter on schedules', () => {
  it('filter: upsertSchedule filters the template once at upsert', async () => {
    useFakeTime();
    const clock = { t: 5_000_000 };
    const raw = new MemoryStore({ clock: () => clock.t });
    const spy = spyStore(raw);
    let verdict: () => ReturnType<FilterFn> = () => true;
    const filter = vi.fn<FilterFn>(() => verdict());
    const q = new Queue('filtered', { store: spy.store, logger: silent, filter, random: () => 0.5, scheduler: { tickMs: 100 } });
    const def = { every: '1s', overlap: 'allow' as const, template: { name: 'report', data: { n: 1 }, opts: { priority: 2 } } };
    await q.upsertSchedule('k', def);
    expect(filter.mock.calls).toEqual([[{ n: 1 }, { queue: 'filtered', name: 'report', id: null, opts: { priority: 2 }, operation: 'schedule' }]]);
    q.startScheduler();
    for (let i = 0; i < 5; i++) {
      clock.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(raw.dump().jobs).toHaveLength(5);
    expect(filter).toHaveBeenCalledTimes(1);
    await q.stopScheduler();
    const stored = await q.getSchedule('k');
    const puts = () => spy.calls.filter((c) => c.op === 'putSchedule').length;
    const before = puts();
    verdict = () => 'no reports';
    const rejected = await q.upsertSchedule('k', { ...def, template: { ...def.template, data: { n: 2 } } }).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(JobRejectedError);
    expect(rejected).toMatchObject({ operation: 'schedule' });
    expect(puts()).toBe(before);
    verdict = () => {
      throw new TypeError('filter bug');
    };
    await expect(q.upsertSchedule('k', { ...def, template: { ...def.template, data: { n: 3 } } })).rejects.toBeInstanceOf(FilterError);
    expect(await q.getSchedule('k')).toEqual(stored);
    vi.useRealTimers();
    await q.close();
  });
});
