import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, StoreRequestError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import { Queue } from '../../src/queue/queue.js';
import type { QueueOptions } from '../../src/queue/options.js';
import type { FireScheduleRequest, FireScheduleResult, Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { freezable } from '../helpers/pods.js';
import { spyStore } from '../helpers/spy-store.js';

const T0 = 5_000_000;
let names = 0;
const queues: Queue[] = [];

/** Pods on one memory store whose clock is `clock.t`, moved by hand; fake timers. */
function setup(opts: { queue?: QueueOptions; faults?: NonNullable<ConstructorParameters<typeof MemoryStore>[0]>['faults'] } = {}) {
  useFakeTime();
  const clock = { t: T0 };
  const store = new MemoryStore({ clock: () => clock.t, ...(opts.faults && { faults: opts.faults }) });
  const name = `tick${++names}`;
  const scope: Scope = { namespace: 'default', queue: name };
  const pod = (o: { queue?: QueueOptions; store?: Store } = {}) => {
    const q = new Queue(name, { logger: silent, random: () => 0.5, scheduler: { tickMs: 100 }, ...opts.queue, ...o.queue, store: o.store ?? store });
    queues.push(q);
    return q;
  };
  /** Fired jobs of schedule `k`, by tick. */
  const fired = () => store.dump().jobs.filter((j) => j.scheduleKey === 'k').sort((x, y) => x.scheduledFor! - y.scheduledFor!);
  const step = async (ms = 1000) => {
    clock.t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { clock, store, scope, pod, fired, step };
}

/** Fired jobs are never run here, so ticks overlap: `'allow'` unless a test says otherwise. */
const every = (e: number | string = '1s', over: object = {}) => ({ every: e, template: { data: { n: 1 } }, overlap: 'allow' as const, ...over });
/** Releases a test's hung store calls before teardown. */
const cleanups: Array<() => void> = [];
const events = (q: Queue, name: 'scheduleFired' | 'scheduleSkipped' | 'scheduleQueued') => {
  const seen: unknown[] = [];
  q.on(name, (p) => void seen.push(p));
  return seen;
};

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  const open = queues.splice(0);
  for (const q of open) await q.stopScheduler();
  vi.useRealTimers();
  await Promise.all(open.map((q) => q.close({ timeoutMs: 100 })));
  vi.restoreAllMocks();
});

describe('scheduler loop', () => {
  it('schedule-tick: 10 pods, 1000 ticks, exactly 1000 jobs', { timeout: 60_000 }, async () => {
    const { pod, fired, step, store, scope } = setup({ queue: { scheduler: { tickMs: 250 } } });
    const pods = Array.from({ length: 10 }, () => pod());
    const seen = pods.map((q) => events(q, 'scheduleFired'));
    await pods[0]!.upsertSchedule('k', every('1s', { overlap: 'allow' }));
    for (const q of pods) q.startScheduler();
    for (let i = 0; i < 1000; i++) await step();
    const jobs = fired();
    expect(jobs.map((j) => j.id)).toEqual(Array.from({ length: 1000 }, (_, i) => `sched:k:${T0 + 1000 * (i + 1)}`));
    expect((await store.getSchedule(scope, { key: 'k' }))!.runCount).toBe(1000);
    expect(seen.flat()).toHaveLength(1000);
  });

  it('schedule-tick: pod killed before fire, another pod fires the tick', async () => {
    const { pod, fired, step, store } = setup();
    const view = freezable(store);
    const a = pod({ store: view });
    const b = pod();
    await b.upsertSchedule('k', every());
    view.freeze();
    cleanups.push(() => view.unfreeze());
    a.startScheduler();
    b.startScheduler();
    await step();
    expect(fired()).toHaveLength(1);
  });

  it('schedule-tick: pod killed during fire leaves no lost and no double tick', async () => {
    let lost = 1;
    const faults = {
      after: (op: string) => {
        if (op === 'fireSchedule' && lost-- > 0) throw new StoreUnavailableError('answer lost', { operation: op, retryable: true, outcomeUnknown: true });
      },
    };
    const { pod, fired, step } = setup({ faults });
    const a = pod();
    const b = pod();
    const errors: ErrorEvent[] = [];
    a.on('error', (e) => void errors.push(e));
    await a.upsertSchedule('k', every());
    a.startScheduler();
    await step();
    b.startScheduler();
    for (let i = 0; i < 4; i++) await step();
    const jobs = fired();
    expect(jobs).toHaveLength(5);
    expect(new Set(jobs.map((j) => j.scheduledFor)).size).toBe(5);
    expect(errors.map((e) => e.context.operation)).toEqual(['fireSchedule']);
  });

  it('schedule-tick: fast pod clock does not fire early', async () => {
    const { pod, fired, clock } = setup();
    const q = pod();
    const seen = events(q, 'scheduleFired');
    await q.upsertSchedule('k', every());
    vi.spyOn(Date, 'now').mockImplementation(() => clock.t + 3_600_000);
    clock.t += 999;
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('schedule-tick: downtime of many periods fires one job then resumes', async () => {
    const { pod, fired, step, clock, store, scope } = setup();
    const q = pod();
    await q.upsertSchedule('k', every());
    q.startScheduler();
    await step();
    await q.stopScheduler();
    const old = (await store.getSchedule(scope, { key: 'k' }))!.nextRunAt;
    clock.t += 50_000;
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(fired().map((j) => j.scheduledFor)).toEqual([T0 + 1000, old]);
    expect((await store.getSchedule(scope, { key: 'k' }))!.nextRunAt).toBe(T0 + 52_000);
    await step();
    expect(fired().map((j) => j.scheduledFor)).toEqual([T0 + 1000, old, T0 + 52_000]);
  });

  it('every: downtime of ten periods fires one tick then resumes on the grid', async () => {
    const { pod, fired, step, clock, store, scope } = setup();
    const q = pod();
    await q.upsertSchedule('k', every());
    clock.t += 10_500;
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(fired().map((j) => j.scheduledFor)).toEqual([T0 + 1000]);
    expect((await store.getSchedule(scope, { key: 'k' }))!.nextRunAt).toBe(T0 + 11_000);
    await step();
    expect(fired().map((j) => j.scheduledFor)).toEqual([T0 + 1000, T0 + 11_000]);
  });

  it('every: period over 2^31 ms does not overflow the sleep', async () => {
    const { pod, fired, clock } = setup();
    const q = pod();
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => (delays.push(ms ?? 0), real(fn, ms))) as typeof setTimeout);
    const { schedule } = await q.upsertSchedule('k', every(2 ** 31 + 5000));
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired()).toEqual([]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_147_483_647);
    clock.t = schedule.nextRunAt;
    await vi.advanceTimersByTimeAsync(110);
    expect(fired().map((j) => j.scheduledFor)).toEqual([schedule.nextRunAt]);
  });

  it('schedule-tick: loop sleeps until nextDueAt capped at tickMs', async () => {
    for (const [random, factor] of [[() => 0.5, 1], [() => 0, 0.9], [() => 1, 1.1]] as const) {
      const { pod, clock } = setup();
      const spy = spyStore(new MemoryStore({ clock: () => clock.t }));
      const lists = () => spy.calls.filter((c) => c.op === 'listDueSchedules').map((c) => c.at);
      const q = pod({ store: spy.store, queue: { random, scheduler: { tickMs: 1000 } } });
      await q.upsertSchedule('k', every());
      clock.t += 700;
      const t0 = Date.now();
      q.startScheduler();
      await vi.advanceTimersByTimeAsync(400);
      expect(lists().map((at) => at - t0)).toEqual([0, 300 * factor]);
      await q.stopScheduler();
    }
    const { pod, clock } = setup();
    const spy = spyStore(new MemoryStore({ clock: () => clock.t }));
    const lists = () => spy.calls.filter((c) => c.op === 'listDueSchedules').map((c) => c.at);
    const q = pod({ store: spy.store, queue: { scheduler: { tickMs: 1000, batchSize: 2 } } });
    await q.upsertSchedule('k', every('10s'));
    const t0 = Date.now();
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(3500);
    expect(lists().map((at) => at - t0)).toEqual([0, 1000, 2000, 3000]);
    await q.stopScheduler();
    for (const k of ['a', 'b', 'c']) await q.upsertSchedule(k, every());
    clock.t += 1000;
    spy.calls.length = 0;
    const t1 = Date.now();
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(lists().slice(0, 2).map((at) => at - t1)).toEqual([0, 0]);
  });

  it('schedule-tick: upsert from another pod is noticed within tickMs', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const name = `tick${++names}`;
    const a = new Queue(name, { store, logger: silent, random: () => 0.5, scheduler: { tickMs: 500 } });
    const b = new Queue(name, { store, logger: silent });
    queues.push(a, b);
    a.startScheduler();
    await vi.advanceTimersByTimeAsync(230);
    const { schedule } = await b.upsertSchedule('k', every());
    let seenAt: number | undefined;
    a.on('scheduleFired', () => void (seenAt ??= Date.now()));
    await vi.advanceTimersByTimeAsync(2000);
    expect(seenAt! - schedule.nextRunAt).toBeGreaterThanOrEqual(0);
    expect(seenAt! - schedule.nextRunAt).toBeLessThanOrEqual(550);
  });

  it('schedule-tick: conflict loser does not create a job or emit scheduleFired', async () => {
    const { pod, fired, clock, store } = setup();
    let aFired = () => {};
    const aGate = new Promise<void>((r) => (aFired = r));
    const answers: FireScheduleResult[] = [];
    const sa = spyStore(store, { fireSchedule: async (s: Scope, r: FireScheduleRequest) => {
      const res = await store.fireSchedule(s, r);
      aFired();
      return res;
    } });
    const sb = spyStore(store, { fireSchedule: async (s: Scope, r: FireScheduleRequest) => {
      await aGate;
      const res = await store.fireSchedule(s, r);
      answers.push(res);
      return res;
    } });
    const a = pod({ store: sa.store });
    const b = pod({ store: sb.store });
    const seenB = events(b, 'scheduleFired');
    await a.upsertSchedule('k', every());
    // b's format check done too, so both pods list the same due record in the same turn
    await b.ready();
    clock.t += 1000;
    a.startScheduler();
    b.startScheduler();
    await vi.advanceTimersByTimeAsync(50);
    expect(answers).toEqual([{ outcome: 'conflict' }]);
    expect(sb.calls.filter((c) => c.op === 'getSchedule')).toHaveLength(1);
    expect(seenB).toEqual([]);
    expect(fired()).toHaveLength(1);
  });

  it('schedule-tick: a queue without a worker or startScheduler never fires', async () => {
    const { pod, fired, step } = setup();
    const plain = pod();
    await plain.upsertSchedule('k', every());
    await step();
    expect(fired()).toEqual([]);
    const off = pod({ queue: { scheduler: { enabled: false, tickMs: 100 } } });
    off.process(() => undefined);
    await step();
    expect(fired()).toEqual([]);
    off.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(fired()).toHaveLength(1);
  });

  it('schedule-tick: stopScheduler lets the in-flight fire finish', async () => {
    const { pod, fired, clock, store } = setup();
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const spy = spyStore(store, { fireSchedule: async (s: Scope, r: FireScheduleRequest) => {
      await gate;
      return store.fireSchedule(s, r);
    } });
    const q = pod({ store: spy.store });
    const seen = events(q, 'scheduleFired');
    await q.upsertSchedule('k', every());
    clock.t += 1000;
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    let stopped = false;
    const stopping = q.stopScheduler().then(() => void (stopped = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toBe(false);
    const lists = spy.calls.filter((c) => c.op === 'listDueSchedules').length;
    open();
    await stopping;
    expect(fired()).toHaveLength(1);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy.calls.filter((c) => c.op === 'listDueSchedules')).toHaveLength(lists);
  });

  it('schedule-tick: close returns within its bound while a fire hangs', async () => {
    const { pod, clock, store } = setup();
    let release = () => {};
    const hung = new Promise<void>((r) => (release = r));
    cleanups.push(() => release());
    const spy = spyStore(store, { fireSchedule: async (s: Scope, r: FireScheduleRequest) => (await hung, store.fireSchedule(s, r)) });
    const q = pod({ store: spy.store });
    await q.upsertSchedule('k', every());
    clock.t += 1000;
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(spy.calls.some((c) => c.op === 'fireSchedule')).toBe(true);
    const start = performance.now();
    let done: number | undefined;
    void q.close({ timeoutMs: 100 }).then(() => void (done = performance.now()));
    await vi.advanceTimersByTimeAsync(5000);
    expect(done! - start).toBeLessThanOrEqual(100 + 2000 + 1000);
  });

  it('schedule-tick: the scheduler starts with the first worker and stops with the last', async () => {
    const { pod, clock } = setup();
    const spy = spyStore(new MemoryStore({ clock: () => clock.t }));
    const lists = () => spy.calls.filter((c) => c.op === 'listDueSchedules').length;
    const q = pod({ store: spy.store });
    await vi.advanceTimersByTimeAsync(500);
    expect(lists()).toBe(0);
    const w = q.process(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    expect(lists()).toBeGreaterThan(0);
    await w.close();
    let n = lists();
    await vi.advanceTimersByTimeAsync(500);
    expect(lists()).toBe(n);
    q.startScheduler();
    const w2 = q.process(() => undefined);
    await w2.close();
    n = lists();
    await vi.advanceTimersByTimeAsync(500);
    expect(lists()).toBeGreaterThan(n);
  });

  it('schedule-tick: health warns when the scheduler loop is stale', async () => {
    const { pod, store } = setup();
    let release = () => {};
    const hung = new Promise<void>((r) => (release = r));
    cleanups.push(() => release());
    const spy = spyStore(store, { listDueSchedules: async (s: Scope, r: { limit: number }) => (await hung, store.listDueSchedules(s, r)) });
    const q = pod({ store: spy.store });
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(400);
    expect((await q.health()).warnings).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    const h = await q.health();
    expect(h.warnings).toEqual([{ code: 'SCHEDULER_STALE', message: 'the scheduler has not finished a loop turn in 5 x tickMs' }]);
    expect([h.status, h.live]).toEqual(['degraded', true]);
  });

  it('schedule-tick: scheduler options are validated', () => {
    const make = (scheduler: unknown) => () => new Queue('opts', { scheduler: scheduler as never, logger: silent });
    for (const [scheduler, path] of [[{ tickMs: 99 }, 'scheduler.tickMs'], [{ batchSize: 0 }, 'scheduler.batchSize'], [{ batchSize: 1001 }, 'scheduler.batchSize']] as const) {
      expect(make(scheduler)).toThrow(InvalidOptionError);
      try {
        make(scheduler)();
      } catch (e) {
        expect((e as InvalidOptionError).issues.map((i) => i.path)).toEqual([path]);
      }
    }
    try {
      make({ tickMS: 100 })();
      expect.unreachable();
    } catch (e) {
      expect((e as InvalidOptionError).issues).toMatchObject([{ path: 'scheduler.tickMS', suggestion: 'tickMs' }]);
    }
  });

  it('schedule-tick: stop then start during a turn keeps one loop', async () => {
    const { pod, clock } = setup();
    const raw = new MemoryStore({ clock: () => clock.t });
    let hold: Promise<void> | undefined;
    let open = () => {};
    let inFlight = 0;
    let most = 0;
    let lists = 0;
    const spy = spyStore(raw, { listDueSchedules: async (s: Scope, r: { limit: number }) => {
      lists++;
      most = Math.max(most, ++inFlight);
      try {
        if (hold) await hold;
        return await raw.listDueSchedules(s, r);
      } finally {
        inFlight--;
      }
    } });
    const q = pod({ store: spy.store });
    hold = new Promise<void>((r) => (open = r));
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    let stopped = false;
    const stopping = q.stopScheduler().then(() => void (stopped = true));
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    hold = undefined;
    open();
    await stopping;
    lists = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(most).toBe(1);
    expect(lists).toBe(10);
    hold = new Promise<void>((r) => (open = r));
    await vi.advanceTimersByTimeAsync(100);
    let done = false;
    const last = q.stopScheduler().then(() => void (done = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    hold = undefined;
    open();
    await last;
    const n = lists;
    await vi.advanceTimersByTimeAsync(1000);
    expect(lists).toBe(n);
  });

  it('schedule-tick: a broken schedule does not hide a later store outage', async () => {
    let outage = false;
    const faults = {
      before: (op: string) => {
        if (outage && op === 'listDueSchedules') throw new StoreUnavailableError('down', { operation: op, retryable: true, outcomeUnknown: false });
      },
    };
    const { pod, store, scope, step } = setup({ faults });
    const q = pod();
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    await q.upsertSchedule('k', every());
    const { namespace: _n, queue: _q, rev, createdAt: _c, updatedAt: _u, ...rest } = (await store.getSchedule(scope, { key: 'k' }))!;
    // a template no queue can build a job from: written past upsert's checks
    await store.putSchedule(scope, { schedule: { ...rest, template: { name: null, data: '1', opts: { priority: 'high' } } }, expectedRev: rev });
    q.startScheduler();
    for (let i = 0; i < 3; i++) await step();
    expect(errors.map((e) => [e.source, e.context.operation])).toEqual([['internal', 'fireSchedule']]);
    outage = true;
    for (let i = 0; i < 3; i++) await step();
    outage = false;
    await step();
    expect(errors.map((e) => [e.source, e.context.operation])).toEqual([['internal', 'fireSchedule'], ['store', 'listDueSchedules']]);
  });

  it('schedule-tick: a schedule with no tick left is reported once, not every turn', async () => {
    const { pod, store, scope, step } = setup();
    const q = pod();
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    await q.upsertSchedule('k', every());
    const { namespace: _n, queue: _q, rev, createdAt: _c, updatedAt: _u, everyMs: _e, anchorAt: _a, ...rest } = (await store.getSchedule(scope, { key: 'k' }))!;
    // a cron that never matches, written past upsert's checks
    await store.putSchedule(scope, { schedule: { ...rest, kind: 'cron', cron: '0 0 30 2 *', tz: 'UTC' }, expectedRev: rev });
    q.startScheduler();
    for (let i = 0; i < 5; i++) await step();
    expect(errors.map((e) => [e.source, e.context.operation, e.error.message])).toEqual([['internal', 'fireSchedule', 'schedule "k" has no tick after the store time']]);
  });

  it('schedule-tick: a fire the store refuses for good is reported per schedule and does not hide a later outage', async () => {
    let outage = false;
    const faults = {
      before: (op: string) => {
        if (op === 'fireSchedule') throw new StoreRequestError('bad fire', { operation: op });
        if (outage && op === 'listDueSchedules') throw new StoreUnavailableError('down', { operation: op, retryable: true, outcomeUnknown: false });
      },
    };
    const { pod, step } = setup({ faults });
    const q = pod();
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    await q.upsertSchedule('k', every());
    q.startScheduler();
    for (let i = 0; i < 3; i++) await step();
    expect(errors.map((e) => [e.source, e.context.operation])).toEqual([['store', 'fireSchedule']]);
    outage = true;
    for (let i = 0; i < 2; i++) await step();
    expect(errors.map((e) => [e.source, e.context.operation])).toEqual([['store', 'fireSchedule'], ['store', 'listDueSchedules']]);
  });

  it('schedule-tick: a store refusal from another copy of the package belongs to the schedule, not to an outage', async () => {
    let outage = false;
    // a StoreRequestError as a second copy of core would throw it: branded, but not an instance of this copy's class
    const foreign = () => Object.assign(new Error('bad fire'), {
      [Symbol.for('sureq.error')]: true, code: 'STORE_BAD_REQUEST', operation: 'fireSchedule', retryable: false, outcomeUnknown: false,
    });
    const faults = {
      before: (op: string) => {
        if (op === 'fireSchedule') throw foreign();
        if (outage && op === 'listDueSchedules') throw new StoreUnavailableError('down', { operation: op, retryable: true, outcomeUnknown: false });
      },
    };
    const { pod, step } = setup({ faults });
    const q = pod();
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    await q.upsertSchedule('k', every());
    q.startScheduler();
    for (let i = 0; i < 3; i++) await step();
    outage = true;
    for (let i = 0; i < 2; i++) await step();
    expect(errors.map((e) => [e.source, e.context.operation])).toEqual([['store', 'fireSchedule'], ['store', 'listDueSchedules']]);
  });

  it('schedule-tick: a broken schedule does not hold back the rest of a full batch, nor spin', async () => {
    const { pod, store, scope, clock } = setup();
    const spy = spyStore(store);
    const q = pod({ store: spy.store, queue: { scheduler: { tickMs: 10_000, batchSize: 2 } } });
    q.on('error', () => {});
    for (const key of ['a', 'b', 'bad', 'c', 'd']) await q.upsertSchedule(key, every('1h'));
    const { namespace: _n, queue: _q, rev, createdAt: _c, updatedAt: _u, ...rest } = (await store.getSchedule(scope, { key: 'bad' }))!;
    // a template no queue can build a job from: written past upsert's checks
    await store.putSchedule(scope, { schedule: { ...rest, template: { name: null, data: '1', opts: { priority: 'high' } } }, expectedRev: rev });
    // every schedule is due: by key, the broken one shares the second batch
    clock.t += 3_600_000;
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(50);
    expect(store.dump().jobs.map((j) => j.scheduleKey).sort()).toEqual(['a', 'b', 'c', 'd']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spy.calls.filter((c) => c.op === 'listDueSchedules').length).toBeLessThanOrEqual(4);
  });

  it('schedule-tick: a broken schedule deleted and recreated broken is reported again', async () => {
    const { pod, store, scope, step } = setup();
    const q = pod();
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    const breakIt = async () => {
      await q.upsertSchedule('k', every());
      const { namespace: _n, queue: _q, rev, createdAt: _c, updatedAt: _u, ...rest } = (await store.getSchedule(scope, { key: 'k' }))!;
      // a template no queue can build a job from: written past upsert's checks
      await store.putSchedule(scope, { schedule: { ...rest, template: { name: null, data: '1', opts: { priority: 'high' } } }, expectedRev: rev });
    };
    await breakIt();
    q.startScheduler();
    for (let i = 0; i < 3; i++) await step();
    expect(errors).toHaveLength(1);
    expect(await q.deleteSchedule('k')).toBe(true);
    await step();
    await breakIt();
    for (let i = 0; i < 3; i++) await step();
    expect(errors.map((e) => [e.source, e.context.operation])).toEqual([['internal', 'fireSchedule'], ['internal', 'fireSchedule']]);
  });

  it('schedule-tick: a fire that fails after close gave up reports nothing', async () => {
    const { pod, clock, store } = setup();
    let fail = (_e: Error) => {};
    const spy = spyStore(store, { fireSchedule: () => new Promise<never>((_, reject) => (fail = reject)) });
    const q = pod({ store: spy.store });
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    let closed = false;
    q.on('closed', () => void (closed = true));
    await q.upsertSchedule('k', every());
    clock.t += 1000;
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(10);
    void q.close({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(closed).toBe(true);
    fail(new StoreUnavailableError('late', { operation: 'fireSchedule', retryable: true, outcomeUnknown: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual([]);
  });

  it('schedule-tick: a paused queue still fires its schedules', async () => {
    const { pod, fired, step } = setup();
    const q = pod();
    await q.upsertSchedule('k', every());
    await q.pause();
    q.startScheduler();
    await step();
    expect(fired().map((j) => j.state)).toEqual(['waiting']);
    expect((await q.getCounts()).blocked).toBe(1);
  });

  it('schedule-tick: a full batch of busy backlogs does not spin', async () => {
    const { pod, clock, store, scope } = setup();
    const spy = spyStore(store);
    const q = pod({ store: spy.store, queue: { scheduler: { tickMs: 100, batchSize: 2 } } });
    for (const key of ['a', 'b']) {
      await q.upsertSchedule(key, every('1h', { overlap: 'queue' }));
      const { namespace: _n, queue: _q, rev, createdAt: _c, updatedAt: _u, ...rest } = (await store.getSchedule(scope, { key }))!;
      // the previous run is still active, so every backlog fire answers busy
      await store.putSchedule(scope, { schedule: { ...rest, lastJobId: 'prev', queuedTicks: [clock.t - 1000] }, expectedRev: rev });
    }
    await store.add(scope, [{ id: 'prev', data: '1', formatVersion: 1, maxAttempts: 1 }]);
    await store.claim(scope, { workerId: 'w', limit: 1, leaseMs: 600_000, claimId: 'c' });
    q.startScheduler();
    await vi.advanceTimersByTimeAsync(1000);
    const lists = spy.calls.filter((c) => c.op === 'listDueSchedules').length;
    const fires = spy.calls.filter((c) => c.op === 'fireSchedule').length;
    expect(lists).toBeLessThanOrEqual(11);
    expect(fires).toBe(2 * lists);
  });
});

