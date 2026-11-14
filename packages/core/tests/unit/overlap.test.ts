import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import type { OverlapPolicy } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

const T0 = 5_000_000;
let names = 0;
const open: Queue[] = [];

/** One pod with a worker whose handler holds each job until `release(id)`; the store clock is `clock.t`. */
function setup(opts: { overlap?: OverlapPolicy; maxQueued?: number; pods?: number; handler?: (job: Job) => Promise<unknown> } = {}) {
  useFakeTime();
  const clock = { t: T0 };
  const store = new MemoryStore({ clock: () => clock.t });
  const name = `overlap${++names}`;
  const scope = { namespace: 'default', queue: name };
  const gates = new Map<string, () => void>();
  const order: number[] = [];
  let activeNow = 0;
  let maxActive = 0;
  const pods = Array.from({ length: opts.pods ?? 1 }, () => {
    const q = new Queue(name, { store, logger: silent, random: () => 0.5, scheduler: { tickMs: 100 } });
    open.push(q);
    return q;
  });
  const q = pods[0]!;
  const handler = opts.handler ?? (async (job: Job) => {
    order.push(job.schedule!.scheduledFor);
    activeNow++;
    maxActive = Math.max(maxActive, activeNow);
    await new Promise<void>((r) => gates.set(job.id, r));
    activeNow--;
  });
  const worker = q.process(handler, { concurrency: 10, ...poll(10) });
  const events: Array<[string, unknown]> = [];
  for (const e of ['scheduleFired', 'scheduleSkipped', 'scheduleQueued'] as const) q.on(e, (p) => void events.push([e, p]));
  const step = async (ms = 1000) => {
    clock.t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const release = async (id?: string) => {
    const key = id ?? [...gates.keys()][0]!;
    gates.get(key)?.();
    gates.delete(key);
    await vi.advanceTimersByTimeAsync(20);
  };
  const jobs = () => store.dump().jobs.filter((j) => j.scheduleKey === 'k').sort((a, b) => a.scheduledFor! - b.scheduledFor!);
  const rec = async () => (await store.getSchedule(scope, { key: 'k' }))!;
  const upsert = () => q.upsertSchedule('k', {
    every: '1s', template: { data: 1 }, ...(opts.overlap && { overlap: opts.overlap }), ...(opts.maxQueued && { maxQueued: opts.maxQueued }),
  });
  const of = (e: string) => events.filter(([n]) => n === e).map(([, p]) => p);
  return { clock, store, scope, q, pods, worker, step, release, jobs, rec, upsert, of, gates, order, max: () => maxActive };
}

afterEach(async () => {
  const qs = open.splice(0);
  for (const q of qs) await q.stopScheduler();
  vi.useRealTimers();
  await Promise.all(qs.map((q) => q.close({ timeoutMs: 100 })));
  vi.restoreAllMocks();
});

describe('overlap policy', () => {
  it('overlap: default policy is skip', async () => {
    const { upsert, rec } = setup();
    await upsert();
    expect([(await rec()).overlap, (await rec()).maxQueued]).toEqual(['skip', 10]);
  });

  it('overlap: skip drops a tick while previous run is active and fires the next free tick', async () => {
    const s = setup();
    await s.upsert();
    await s.step();
    expect(s.jobs()).toHaveLength(1);
    for (let i = 0; i < 3; i++) await s.step();
    expect(s.jobs()).toHaveLength(1);
    expect(s.of('scheduleSkipped')).toEqual([2, 3, 4].map((i) => ({ key: 'k', scheduledFor: T0 + 1000 * i, reason: 'overlap' })));
    await s.release();
    await s.step();
    expect(s.jobs().map((j) => j.scheduledFor)).toEqual([T0 + 1000, T0 + 5000]);
  });

  it('overlap: skip treats waiting and retrying previous runs as unfinished', async () => {
    const s = setup({ handler: async () => {
      throw new Error('again');
    } });
    s.worker.pause();
    await s.q.upsertSchedule('k', { every: '1s', template: { data: 1, opts: { backoff: '10s', maxAttempts: 3 } } });
    await s.step();
    await s.step();
    expect(s.jobs().map((j) => j.state)).toEqual(['waiting']);
    expect(s.of('scheduleSkipped')).toHaveLength(1);
    s.worker.resume();
    await vi.advanceTimersByTimeAsync(50);
    expect(s.jobs().map((j) => j.state)).toEqual(['delayed']);
    await s.step();
    expect(s.jobs()).toHaveLength(1);
    expect(s.of('scheduleSkipped')).toHaveLength(2);
  });

  it('overlap: queue runs ticks one after another in tick order and loses none', async () => {
    const s = setup({ overlap: 'queue' });
    await s.upsert();
    await s.step();
    for (let i = 0; i < 3; i++) await s.step();
    expect(s.of('scheduleQueued')).toEqual([2, 3, 4].map((i) => ({ key: 'k', scheduledFor: T0 + 1000 * i })));
    for (let i = 0; i < 4; i++) {
      await s.release();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(s.order).toEqual([1, 2, 3, 4].map((i) => T0 + 1000 * i));
    expect(s.max()).toBe(1);
    expect(s.jobs()).toHaveLength(4);
  });

  it('overlap: queue never runs two at once', async () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const s = setup({ overlap: 'queue', maxQueued: 50 });
    await s.upsert();
    for (let i = 0; i < 20; i++) {
      await s.step();
      if (rand() < 0.5 && s.gates.size > 0) await s.release();
    }
    while (s.gates.size > 0) {
      await s.release();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(s.max()).toBe(1);
    expect(s.order).toEqual([...s.order].sort((a, b) => a - b));
    expect(s.order).toHaveLength(20);
  });

  it('overlap: queue drops with backlog-full beyond maxQueued and emits scheduleSkipped', async () => {
    const s = setup({ overlap: 'queue', maxQueued: 2 });
    await s.upsert();
    for (let i = 0; i < 5; i++) await s.step();
    expect(s.of('scheduleQueued')).toHaveLength(2);
    expect(s.of('scheduleSkipped')).toEqual([4, 5].map((i) => ({ key: 'k', scheduledFor: T0 + 1000 * i, reason: 'backlog-full' })));
    expect((await s.rec()).queuedTicks).toEqual([T0 + 2000, T0 + 3000]);
  });

  it('overlap: allow fires every tick even while previous runs', async () => {
    const s = setup({ overlap: 'allow' });
    await s.upsert();
    for (let i = 0; i < 3; i++) await s.step();
    expect(s.max()).toBe(3);
    expect(s.jobs().map((j) => j.state)).toEqual(['active', 'active', 'active']);
  });

  it('overlap: finished, failed, cancelled or removed previous run does not block', async () => {
    for (const route of ['complete', 'fail', 'cancel', 'remove'] as const) {
      const s = setup({ handler: async () => {
        if (route === 'fail') throw new Error('no');
      } });
      if (route === 'cancel' || route === 'remove') s.worker.pause();
      await s.q.upsertSchedule('k', { every: '1s', template: { data: 1, opts: { maxAttempts: 1 } } });
      await s.step();
      const [first] = s.jobs();
      if (route === 'cancel') await s.q.cancel(first!.id);
      if (route === 'remove') await s.q.remove(first!.id);
      await vi.advanceTimersByTimeAsync(50);
      await s.step();
      expect(s.of('scheduleFired'), route).toHaveLength(2);
      for (const q of open.splice(0)) await q.close({ timeoutMs: 100 });
    }
  });

  it('overlap: backlog is drained before a newly due tick', async () => {
    const s = setup({ overlap: 'queue' });
    await s.upsert();
    await s.step();
    await s.step();
    expect((await s.rec()).queuedTicks).toEqual([T0 + 2000]);
    await s.release();
    await s.step();
    expect(s.jobs().map((j) => j.scheduledFor)).toEqual([T0 + 1000, T0 + 2000]);
    expect((await s.rec()).queuedTicks).toEqual([T0 + 3000]);
  });

  it('overlap: backlog survives pause and drains after resume', async () => {
    const s = setup({ overlap: 'queue' });
    await s.upsert();
    for (let i = 0; i < 3; i++) await s.step();
    await s.q.pauseSchedule('k');
    await s.release();
    for (let i = 0; i < 3; i++) await s.step();
    expect(s.jobs()).toHaveLength(1);
    expect((await s.rec()).queuedTicks).toEqual([T0 + 2000, T0 + 3000]);
    await s.q.resumeSchedule('k');
    await vi.advanceTimersByTimeAsync(200);
    await s.release();
    await vi.advanceTimersByTimeAsync(200);
    expect(s.order).toEqual([T0 + 1000, T0 + 2000, T0 + 3000]);
  });

  it('overlap: two pods draining the backlog start exactly one run', async () => {
    const s = setup({ overlap: 'queue', pods: 2 });
    await s.upsert();
    await s.step();
    await s.step();
    s.pods[1]!.startScheduler();
    await s.release();
    await vi.advanceTimersByTimeAsync(200);
    expect(s.jobs().map((j) => j.scheduledFor)).toEqual([T0 + 1000, T0 + 2000]);
  });

  it('overlap: changing policy via upsert applies from next tick and keeps queuedTicks', async () => {
    const s = setup({ overlap: 'queue' });
    await s.upsert();
    for (let i = 0; i < 3; i++) await s.step();
    await s.q.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    expect((await s.rec()).queuedTicks).toEqual([T0 + 2000, T0 + 3000]);
    await s.step();
    expect(s.jobs().map((j) => j.scheduledFor)).toEqual([T0 + 1000, T0 + 4000]);
    await s.release();
    await s.release();
    // between ticks, with the previous run finished, the oldest backlog tick goes
    await vi.advanceTimersByTimeAsync(200);
    expect(s.jobs().map((j) => j.scheduledFor)).toEqual([T0 + 1000, T0 + 2000, T0 + 4000]);
    expect((await s.rec()).queuedTicks).toEqual([T0 + 3000]);
  });

  it('overlap: invalid value throws InvalidOptionError bad-overlap', async () => {
    const { q } = setup();
    await expect(q.upsertSchedule('k', { every: '1s', overlap: 'never' as never, template: { data: 1 } })).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(q.upsertSchedule('k', { every: '1s', overlap: 'never' as never, template: { data: 1 } })).rejects.toMatchObject({ issues: [{ reason: 'bad-overlap' }] });
  });
});
