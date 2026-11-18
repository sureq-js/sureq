import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, QueueClosedError, ScheduleNotFoundError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { FireScheduleRequest, Scope } from '../../src/store/contract.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const T0 = 1_700_000_000_000;
const Z = Date.parse;
const MIN = 60_000;
let names = 0;

/** `pods` queues on one memory store whose clock is `clock.t`, with their schedule events. */
function setup(pods = 1) {
  const clock = { t: T0 };
  const raw = new MemoryStore({ clock: () => clock.t });
  const spy = spyStore(raw);
  const name = `mgmt${++names}`;
  const events: Array<[string, unknown]> = [];
  const queues = Array.from({ length: pods }, () => {
    const q = new Queue(name, { store: spy.store, logger: silent });
    for (const e of ['schedulePaused', 'scheduleResumed', 'scheduleDeleted'] as const) q.on(e, (p) => void events.push([e, p]));
    return q;
  });
  const ops = (op: string) => spy.calls.filter((c) => c.op === op).length;
  return { clock, raw, spy, queue: queues[0]!, queues, events, ops };
}

const every = (data: unknown = 1) => ({ every: '1m', template: { data } });
const keys = (page: { schedules: Array<{ key: string }> }) => page.schedules.map((s) => s.key);

afterEach(() => vi.restoreAllMocks());

describe('schedule management', () => {
  it('schedule-mgmt: list returns schedules ordered by key with a cursor', async () => {
    const { queue, spy } = setup();
    for (const k of ['c', 'a', 'e', 'b', 'd']) await queue.upsertSchedule(k, every());
    const one = await queue.listSchedules({ limit: 2 });
    const two = await queue.listSchedules({ limit: 2, cursor: one.nextCursor! });
    const three = await queue.listSchedules({ limit: 2, cursor: two.nextCursor! });
    expect([keys(one), keys(two), keys(three), three.nextCursor]).toEqual([['a', 'b'], ['c', 'd'], ['e'], null]);
    spy.calls.length = 0;
    expect(keys(await queue.listSchedules())).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(spy.calls.map((c) => [c.op, c.args[1]])).toEqual([['listSchedules', { limit: 100 }]]);
    for (const limit of [1001, 0]) await expect(queue.listSchedules({ limit })).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(queue.listSchedules({ state: 'off' as never })).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(queue.listSchedules({ cursor: '' })).rejects.toMatchObject({ issues: [{ path: 'cursor', code: 'invalid_value' }] });
  });

  it('schedule-mgmt: template data stored as bytes reads back parsed', async () => {
    const { queue, raw } = setup();
    await queue.upsertSchedule('k', every({ n: 1 }));
    const scope = { namespace: 'default', queue: queue.name };
    const { namespace: _n, queue: _q, rev, createdAt: _c, updatedAt: _u, ...rest } = (await raw.getSchedule(scope, { key: 'k' }))!;
    await raw.putSchedule(scope, { schedule: { ...rest, template: { ...rest.template, data: new TextEncoder().encode('{"n":2}') } }, expectedRev: rev });
    expect((await queue.getSchedule('k'))!.template.data).toEqual({ n: 2 });
  });

  it('schedule-mgmt: list filters by paused and active', async () => {
    const { queue } = setup();
    for (const k of ['a', 'b', 'c', 'd', 'e']) await queue.upsertSchedule(k, every({ k }));
    for (const k of ['b', 'd']) await queue.pauseSchedule(k);
    const paused = await queue.listSchedules({ state: 'paused' });
    expect([keys(paused), keys(await queue.listSchedules({ state: 'active' }))]).toEqual([['b', 'd'], ['a', 'c', 'e']]);
    expect(paused.schedules[0]!.template.data).toEqual({ k: 'b' });
  });

  it('schedule-mgmt: get returns null for unknown key', async () => {
    const { queue } = setup();
    expect(await queue.getSchedule('nope')).toBeNull();
    const { schedule } = await queue.upsertSchedule('k', every({ x: 1 }));
    expect(await queue.getSchedule('k')).toEqual(schedule);
    await expect(queue.getSchedule('')).rejects.toBeInstanceOf(InvalidOptionError);
  });

  it('schedule-mgmt: pause and resume are idempotent and emit events once', async () => {
    const { queue, events } = setup();
    await queue.upsertSchedule('k', every());
    const paused = await queue.pauseSchedule('k');
    expect(paused.paused).toBe(true);
    expect(await queue.pauseSchedule('k')).toEqual(paused);
    const resumed = await queue.resumeSchedule('k');
    expect(resumed.paused).toBe(false);
    expect(await queue.resumeSchedule('k')).toEqual(resumed);
    expect([await queue.deleteSchedule('k'), await queue.deleteSchedule('k')]).toEqual([true, false]);
    expect(events).toEqual([['schedulePaused', { key: 'k' }], ['scheduleResumed', { key: 'k' }], ['scheduleDeleted', { key: 'k' }]]);
  });

  it('schedule-mgmt: resume recomputes nextRunAt after store now and does not fire missed ticks', async () => {
    const { queue, clock, raw } = setup();
    const { schedule } = await queue.upsertSchedule('k', every());
    await queue.pauseSchedule('k');
    clock.t += 365 * 24 * 3_600_000 + 10_000;
    const resumed = await queue.resumeSchedule('k');
    const since = clock.t - schedule.anchorAt!;
    expect(resumed.nextRunAt).toBe(schedule.anchorAt! + Math.ceil(since / MIN) * MIN);
    expect(resumed.nextRunAt).toBeGreaterThan(clock.t);
    expect(resumed.nextRunAt - clock.t).toBeLessThanOrEqual(MIN);
    expect([resumed.runCount, resumed.queuedTicks]).toEqual([0, []]);
    expect(raw.dump().jobs).toEqual([]);
  });

  it('schedule-mgmt: delete is idempotent and returns false when absent', async () => {
    const { queue, events } = setup();
    expect(await queue.deleteSchedule('never')).toBe(false);
    await queue.upsertSchedule('k', every());
    expect(await queue.deleteSchedule('k')).toBe(true);
    expect(await queue.deleteSchedule('k')).toBe(false);
    expect(await queue.getSchedule('k')).toBeNull();
    expect(events).toEqual([['scheduleDeleted', { key: 'k' }]]);
  });

  it('schedule-mgmt: unknown key throws ScheduleNotFoundError for pause, resume and nextRuns', async () => {
    const { queue } = setup();
    for (const call of [() => queue.pauseSchedule('x'), () => queue.resumeSchedule('x'), () => queue.nextRuns('x')]) {
      const e = await call().then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(ScheduleNotFoundError);
      expect(e).toMatchObject({ code: 'SCHEDULE_NOT_FOUND', key: 'x' });
    }
  });

  it('schedule-mgmt: nextRuns returns n increasing instants for cron in tz', async () => {
    const { queue, clock } = setup();
    clock.t = Z('2026-03-06T00:00Z');
    await queue.upsertSchedule('k', { cron: '0 9 * * *', tz: 'America/New_York', template: { data: 1 } });
    expect(await queue.nextRuns('k', 3)).toEqual([Z('2026-03-06T14:00Z'), Z('2026-03-07T14:00Z'), Z('2026-03-08T13:00Z')]);
    expect(await queue.nextRuns('k')).toHaveLength(5);
    for (const n of [0, 101, 2.5]) await expect(queue.nextRuns('k', n)).rejects.toMatchObject({ code: 'INVALID_OPTION', issues: [{ path: 'n' }] });
  });

  it('every: nextRuns returns n grid points', async () => {
    const { queue, clock } = setup();
    const A = (await queue.upsertSchedule('k', { every: '30s', template: { data: 1 } })).schedule.anchorAt!;
    clock.t = A + 45_000;
    const runs = await queue.nextRuns('k', 4);
    expect(runs).toEqual([A + 60_000, A + 90_000, A + 120_000, A + 150_000]);
    for (const r of runs) expect((r - A) % 30_000).toBe(0);
  });

  it('schedule-mgmt: nextRuns for every follows the stored anchor grid', async () => {
    const { queue, clock } = setup();
    const A = (await queue.upsertSchedule('k', every())).schedule.anchorAt!;
    clock.t = A + 90_000;
    expect(await queue.nextRuns('k', 3)).toEqual([A + 120_000, A + 180_000, A + 240_000]);
  });

  it('schedule-mgmt: nextRuns works for a paused schedule and writes nothing', async () => {
    const { queue, clock, ops } = setup();
    await queue.upsertSchedule('k', every());
    clock.t += 5000;
    const before = await queue.nextRuns('k', 3);
    await queue.pauseSchedule('k');
    const puts = ops('putSchedule');
    expect(await queue.nextRuns('k', 3)).toEqual(before);
    expect(ops('putSchedule')).toBe(puts);
  });

  it('schedule-mgmt: previewSchedule validates without storing', async () => {
    const { store, calls } = spyStore(new MemoryStore({ clock: () => 1_000 }));
    const queue = new Queue('q', { store, logger: silent });
    try {
      await expect(queue.previewSchedule({ every: '1s' })).resolves.toEqual([2000, 3000, 4000, 5000, 6000]);
      await expect(queue.previewSchedule({ cron: '0 * * * *' }, 2)).resolves.toEqual([3_600_000, 7_200_000]);
      expect([...new Set(calls.map((c) => c.op))].sort()).toEqual(['now', 'open']);
      await expect(queue.previewSchedule({ cron: 'nope' })).rejects.toMatchObject({ code: 'INVALID_OPTION', issues: [{ reason: 'bad-cron' }] });
      for (const n of [0, 101, 1.5, '5']) await expect(queue.previewSchedule({ every: 1000 }, n as number)).rejects.toMatchObject({ issues: [{ path: 'n' }] });
      expect((await queue.listSchedules()).schedules).toEqual([]);
      expect(calls.some((c) => c.op === 'putSchedule')).toBe(false);
    } finally {
      await queue.close();
    }
    await expect(queue.previewSchedule({ every: 1000 })).rejects.toBeInstanceOf(QueueClosedError);
  });

  it('schedule-mgmt: nextRuns uses store time under a skewed pod clock', async () => {
    const { queue, clock } = setup();
    const A = (await queue.upsertSchedule('k', every())).schedule.anchorAt!;
    clock.t = A + 30_000;
    vi.spyOn(Date, 'now').mockReturnValue(clock.t + 3_600_000);
    expect(await queue.nextRuns('k', 2)).toEqual([A + MIN, A + 2 * MIN]);
  });

  it('schedule-mgmt: concurrent pause from two pods writes once', async () => {
    const { queues, events, raw } = setup(2);
    await queues[0]!.upsertSchedule('k', every());
    const scope = { namespace: 'default', queue: queues[0]!.name };
    const revBefore = (await raw.getSchedule(scope, { key: 'k' }))!.rev;
    const both = await Promise.all(queues.map((q) => q.pauseSchedule('k')));
    expect(both.map((s) => s.paused)).toEqual([true, true]);
    expect((await raw.getSchedule(scope, { key: 'k' }))!.rev).toBe(revBefore + 1);
    expect(events).toEqual([['schedulePaused', { key: 'k' }]]);
  });

  it('schedule-mgmt: a closed queue refuses the schedule methods', async () => {
    const { queue } = setup();
    await queue.close();
    for (const call of [
      () => queue.getSchedule('k'), () => queue.listSchedules(), () => queue.pauseSchedule('k'), () => queue.resumeSchedule('k'),
      () => queue.deleteSchedule('k'), () => queue.nextRuns('k'),
    ]) await expect(call()).rejects.toBeInstanceOf(QueueClosedError);
  });
});

/** Pods with schedulers (tickMs 100) on one memory store whose clock is `clock.t`; fake timers. */
function firing(pods = 1, over: Parameters<typeof spyStore>[1] = {}) {
  useFakeTime();
  const clock = { t: T0 };
  const raw = new MemoryStore({ clock: () => clock.t });
  const spy = spyStore(raw, over);
  const name = `fire${++names}`;
  const scope = { namespace: 'default', queue: name };
  const queues = Array.from({ length: pods }, () => new Queue(name, { store: spy.store, logger: silent, random: () => 0.5, scheduler: { tickMs: 100 } }));
  const jobs = () => raw.dump().jobs.filter((j) => j.scheduleKey === 'k');
  const step = async (ms = 1000) => {
    clock.t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const end = async () => {
    for (const q of queues) await q.stopScheduler();
    vi.useRealTimers();
    await Promise.all(queues.map((q) => q.close({ timeoutMs: 100 })));
  };
  return { clock, raw, scope, queue: queues[0]!, queues, jobs, step, end };
}

describe('schedule management while firing', () => {
  it('schedule-mgmt: pause stops firing and keeps already-created jobs running', async () => {
    const f = firing();
    const w = f.queue.process(() => undefined, poll(10));
    w.pause();
    await f.queue.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    await f.step();
    await f.step();
    expect(f.jobs()).toHaveLength(2);
    await f.queue.pauseSchedule('k');
    for (let i = 0; i < 5; i++) await f.step();
    expect(f.jobs()).toHaveLength(2);
    w.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.jobs().map((j) => j.state)).toEqual(['completed', 'completed']);
    await f.end();
  });

  it('schedule-mgmt: pause is visible to other pods on their next loop turn', async () => {
    const f = firing(2);
    const [a, b] = f.queues as [Queue, Queue];
    await b.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    a.startScheduler();
    await f.step();
    expect(f.jobs()).toHaveLength(1);
    await b.pauseSchedule('k');
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 3; i++) await f.step();
    expect(f.jobs()).toHaveLength(1);
    await f.end();
  });

  it('schedule-mgmt: resume keeps the overlap backlog', async () => {
    let release = () => {};
    const f = firing();
    f.queue.process(() => new Promise<void>((r) => (release = r)), poll(10));
    await f.queue.upsertSchedule('k', { every: '1s', overlap: 'queue', template: { data: 1 } });
    await f.step();
    await f.step();
    expect((await f.queue.getSchedule('k'))!.queuedTicks).toEqual([T0 + 2000]);
    await f.queue.pauseSchedule('k');
    expect((await f.queue.resumeSchedule('k')).queuedTicks).toEqual([T0 + 2000]);
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.jobs().map((j) => j.scheduledFor).sort()).toEqual([T0 + 1000, T0 + 2000]);
    release();
    await f.end();
  });

  it('schedule-mgmt: delete removes the schedule and leaves existing jobs', async () => {
    let release = () => {};
    const f = firing();
    let first = true;
    f.queue.process(() => (first ? ((first = false), new Promise<void>((r) => (release = r))) : undefined), { concurrency: 1, ...poll(10) });
    await f.queue.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    await f.step();
    await f.step();
    expect(f.jobs().map((j) => j.state).sort()).toEqual(['active', 'waiting']);
    expect(await f.queue.deleteSchedule('k')).toBe(true);
    release();
    for (let i = 0; i < 3; i++) await f.step();
    expect(f.jobs().map((j) => j.state)).toEqual(['completed', 'completed']);
    expect(await f.queue.getSchedule('k')).toBeNull();
    await f.end();
  });

  it('schedule-mgmt: delete racing a fire creates at most one job', async () => {
    for (let i = 0; i < 50; i++) {
      let open = () => {};
      let entered = () => {};
      const inFire = new Promise<void>((r) => (entered = r));
      const gate = new Promise<void>((r) => (open = r));
      const ref: { raw?: MemoryStore } = {};
      const f = firing(1, { fireSchedule: async (s: Scope, r: FireScheduleRequest) => {
        entered();
        await gate;
        return ref.raw!.fireSchedule(s, r);
      } });
      ref.raw = f.raw;
      await f.queue.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
      f.clock.t += 1000;
      f.queue.startScheduler();
      await inFire;
      if (i % 2 === 0) {
        await f.queue.deleteSchedule('k');
        open();
      } else {
        open();
        await f.queue.deleteSchedule('k');
      }
      await vi.advanceTimersByTimeAsync(50);
      expect(f.jobs().length).toBeLessThanOrEqual(1);
      for (let n = 0; n < 3; n++) await f.step();
      expect(f.jobs().length).toBeLessThanOrEqual(1);
      await f.end();
    }
  });

  it('schedule-mgmt: nextRuns matches the times the schedule then fires', async () => {
    const f = firing();
    f.queue.startScheduler();
    await f.queue.upsertSchedule('k', { cron: '*/5 * * * *', tz: 'Asia/Kolkata', overlap: 'allow', template: { data: 1 } });
    const want = await f.queue.nextRuns('k', 5);
    for (let i = 0; i < 6; i++) await f.step(5 * MIN);
    expect(f.jobs().map((j) => j.scheduledFor).sort().slice(0, 5)).toEqual(want);
    await f.end();
  });
});

