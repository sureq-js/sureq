import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, PayloadTooLargeError, ScheduleConflictError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { definitionHash } from '../../src/scheduler/schedules.js';
import type { ScheduleRecord } from '../../src/store/contract.js';
import { defineCapabilities } from '../../src/store/capabilities.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { nextOccurrence } from '../../src/scheduler/timing.js';
import { silent } from '../helpers/harness.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const Z = Date.parse;
let queues = 0;

/** `n` queues (pods) on one memory store whose clock is `clock.t`; every test gets its own queue name. */
function setup(opts: { pods?: number; over?: Parameters<typeof spyStore>[1]; logger?: typeof silent; maxPayloadBytes?: number } = {}) {
  const clock = { t: T0 };
  const raw = new MemoryStore({ clock: () => clock.t });
  const spy = spyStore(raw, opts.over);
  const name = `sched${++queues}`;
  const pods = Array.from({ length: opts.pods ?? 1 }, () =>
    new Queue(name, { store: spy.store, logger: opts.logger ?? silent, ...(opts.maxPayloadBytes !== undefined && { maxPayloadBytes: opts.maxPayloadBytes }) }));
  const scope = { namespace: 'default', queue: name };
  const stored = async (key: string): Promise<ScheduleRecord> => (await raw.getSchedule(scope, { key }))!;
  const ops = (op: string) => spy.calls.filter((c) => c.op === op).length;
  return { clock, raw, spy, queue: pods[0]!, pods, scope, stored, ops };
}

const issues = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(InvalidOptionError);
  return (e as InvalidOptionError).issues;
};

vi.mock('../../src/scheduler/timing.js', async (load) => {
  const real = await load<typeof import('../../src/scheduler/timing.js')>();
  return { ...real, nextOccurrence: vi.fn(real.nextOccurrence) };
});

afterEach(() => vi.restoreAllMocks());

describe('upsertSchedule', () => {
  it('schedule-upsert: first call creates with nextRunAt after store now', async () => {
    const { queue, clock } = setup();
    const res = await queue.upsertSchedule('every', { every: '1m', template: { data: { n: 1 } } });
    expect(res.action).toBe('created');
    expect(res.schedule).toMatchObject({
      key: 'every', kind: 'every', everyMs: 60_000, anchorAt: clock.t, nextRunAt: clock.t + 60_000, rev: 1, paused: false, runCount: 0,
      definitionVersion: 0, overlap: 'skip', maxQueued: 10, queuedTicks: [], lastFiredFor: null, lastJobId: null,
      template: { name: null, data: { n: 1 }, opts: {} },
    });
    const cron = await queue.upsertSchedule('nightly', { cron: '0 2 * * *', template: { data: null } });
    expect(cron.schedule).toMatchObject({ kind: 'cron', cron: '0 2 * * *', tz: 'UTC', nextRunAt: Z('2023-11-15T02:00Z') });
    clock.t = Z('2023-11-15T02:00Z');
    const onTick = await queue.upsertSchedule('on-tick', { cron: '0 2 * * *', template: { data: null } });
    expect(onTick.schedule.nextRunAt).toBe(Z('2023-11-16T02:00Z'));
  });

  it('every: same period on re-upsert keeps anchor, changed period resets it', async () => {
    const { queue, clock } = setup();
    const a = (await queue.upsertSchedule('k', { every: '1m', template: { data: 1 } })).schedule.anchorAt;
    clock.t += 90_000;
    expect((await queue.upsertSchedule('k', { every: '1m', template: { data: 1 } })).schedule.anchorAt).toBe(a);
    const changed = await queue.upsertSchedule('k', { every: '2m', template: { data: 1 } });
    expect(changed.schedule).toMatchObject({ anchorAt: clock.t, nextRunAt: clock.t + 120_000 });
    clock.t += 1000;
    const respelled = await queue.upsertSchedule('k', { every: '120s', template: { data: 1 } });
    expect([respelled.action, respelled.schedule.anchorAt]).toEqual(['unchanged', changed.schedule.anchorAt]);
  });

  it('schedule-upsert: same definition twice returns unchanged and keeps nextRunAt', async () => {
    const { queue, clock, ops } = setup();
    const first = await queue.upsertSchedule('k', { every: '1m', template: { data: { a: 1 } } });
    clock.t += 30_000;
    const second = await queue.upsertSchedule('k', { every: '1m', template: { data: { a: 1 } } });
    expect(second).toEqual({ action: 'unchanged', schedule: first.schedule });
    expect(ops('putSchedule')).toBe(1);
  });

  it('schedule-upsert: changed cron recomputes nextRunAt and keeps runCount, paused, lastJobId', async () => {
    const { queue, clock, raw, scope, stored } = setup();
    const plant = async (key: string) => {
      const rec = await stored(key);
      const { namespace: _n, queue: _q, rev, createdAt: _c, updatedAt: _u, ...rest } = rec;
      const res = await raw.putSchedule(scope, {
        schedule: { ...rest, runCount: 4, lastJobId: 'j', paused: true, lastFiredFor: T0 - 1000, queuedTicks: [5] }, expectedRev: rev,
      });
      expect(res.ok).toBe(true);
    };
    const created = (await queue.upsertSchedule('cron', { cron: '0 2 * * *', template: { data: 1 } })).schedule;
    await plant('cron');
    clock.t += 1000;
    const res = await queue.upsertSchedule('cron', { cron: '0 3 * * *', template: { data: 1 } });
    const kept = { runCount: 4, lastJobId: 'j', paused: true, lastFiredFor: T0 - 1000, queuedTicks: [5], createdAt: created.createdAt };
    expect(res.action).toBe('updated');
    expect(res.schedule).toMatchObject({ ...kept, cron: '0 3 * * *', nextRunAt: Z('2023-11-15T03:00Z'), updatedAt: clock.t });

    await queue.upsertSchedule('every', { every: '1m', template: { data: 1 } });
    await plant('every');
    clock.t += 1000;
    const every = await queue.upsertSchedule('every', { every: '2m', template: { data: 1 } });
    expect(every.schedule).toMatchObject({ runCount: 4, paused: true, queuedTicks: [5], anchorAt: clock.t, nextRunAt: clock.t + 120_000 });
  });

  it('schedule-upsert: changed template only keeps nextRunAt', async () => {
    const { queue, clock } = setup();
    const first = (await queue.upsertSchedule('k', { every: '1m', template: { data: { v: 1 } } })).schedule;
    clock.t += 10_000;
    const res = await queue.upsertSchedule('k', { every: '1m', template: { data: { v: 2 } }, overlap: 'allow' });
    expect(res.action).toBe('updated');
    expect(res.schedule).toMatchObject({ nextRunAt: first.nextRunAt, anchorAt: first.anchorAt, overlap: 'allow', template: { data: { v: 2 } }, rev: 2 });
  });

  it('schedule-upsert: key order in data does not change the hash', async () => {
    const { queue } = setup();
    await queue.upsertSchedule('k', { every: '1m', template: { data: { a: 1, b: { c: 2, d: 3 } } } });
    expect((await queue.upsertSchedule('k', { every: '1m', template: { data: { b: { d: 3, c: 2 }, a: 1 } } })).action).toBe('unchanged');
  });

  it('schedule-upsert: 20 pods upsert same definition concurrently, one created and 19 unchanged', async () => {
    const { pods, raw, scope } = setup({ pods: 20 });
    const results = await Promise.all(pods.map((q) => q.upsertSchedule('report', { cron: '0 2 * * *', template: { name: 'report', data: { all: true } } })));
    expect(results.map((r) => r.action).sort()).toEqual(['created', ...Array<string>(19).fill('unchanged')]);
    const { schedules } = await raw.listSchedules(scope, { limit: 10 });
    expect(schedules.map((s) => [s.key, s.rev])).toEqual([['report', 1]]);
  });

  it('schedule-upsert: concurrent different definitions leave one whole definition', async () => {
    const { pods, stored } = setup({ pods: 10 });
    await Promise.all(pods.map((q, i) => q.upsertSchedule('k', { every: `${i + 1}m`, template: { data: { n: i } } })));
    const rec = await stored('k');
    const i = (JSON.parse(rec.template.data as string) as { n: number }).n;
    expect(rec.everyMs).toBe((i + 1) * 60_000);
    const parts = { kind: 'every', everyMs: (i + 1) * 60_000, template: { name: null, data: { n: i }, opts: {} }, overlap: 'skip', maxQueued: 10 };
    expect(rec.definitionHash).toBe(definitionHash(parts));
  });

  it('schedule-upsert: lower version after a higher one returns stale and writes nothing', async () => {
    const warn = vi.fn();
    const { queue, stored, ops } = setup({ logger: { ...silent, warn } });
    await queue.upsertSchedule('k', { version: 5, every: '1m', template: { data: 'A' } });
    const before = await stored('k');
    const res = await queue.upsertSchedule('k', { version: 4, every: '2m', template: { data: 'B' } });
    expect(res.action).toBe('stale');
    expect(await stored('k')).toEqual(before);
    expect(ops('putSchedule')).toBe(1);
    const stale = warn.mock.calls.filter(([msg]) => String(msg).includes('scheduleStale'));
    expect(stale).toHaveLength(1);
    await queue.upsertSchedule('k', { version: 4, every: '2m', template: { data: 'B' } });
    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('scheduleStale'))).toHaveLength(1);
  });

  it('schedule-upsert: old and new pods restarting alternately leave the higher version stored', async () => {
    const { pods, stored } = setup({ pods: 2 });
    const [old, fresh] = pods as [Queue, Queue];
    const A = { version: 4, every: '1m', template: { data: 'A' } } as const;
    const B = { version: 5, every: '1m', template: { data: 'B' } } as const;
    const actions: string[] = [];
    for (let round = 0; round < 6; round++) actions.push((await (round % 2 === 0 ? old.upsertSchedule('k', A) : fresh.upsertSchedule('k', B))).action);
    expect(actions).toEqual(['created', 'updated', 'stale', 'unchanged', 'stale', 'unchanged']);
    expect((await stored('k')).template.data).toBe('"B"');
    expect((await old.upsertSchedule('k', { every: '1m', template: { data: 'A' } })).action).toBe('stale');
    const raised = await fresh.upsertSchedule('k', { ...B, version: 6 });
    expect([raised.action, raised.schedule.definitionVersion]).toEqual(['unchanged', 6]);
    expect((await old.upsertSchedule('k', { ...A, version: 5 })).action).toBe('stale');
  });

  it('schedule-upsert: equal version with a different hash applies; unversioned is last-writer-wins', async () => {
    const { queue } = setup();
    await queue.upsertSchedule('v', { version: 5, every: '1m', template: { data: 'A' } });
    expect((await queue.upsertSchedule('v', { version: 5, every: '1m', template: { data: 'B' } })).action).toBe('updated');
    await queue.upsertSchedule('u', { every: '1m', template: { data: 'A' } });
    for (const data of ['B', 'A']) expect((await queue.upsertSchedule('u', { every: '1m', template: { data } })).action).toBe('updated');
  });

  it('schedule-upsert: reserved template options are rejected with InvalidOptionError', async () => {
    const { queue, spy } = setup();
    const upsert = (def: unknown) => queue.upsertSchedule('k', def as never);
    for (const k of ['id', 'delay', 'runAt', 'onDuplicate', 'uniqueWhile', 'singletonKey', 'idempotencyKey']) {
      expect(await issues(upsert({ every: '1m', template: { data: 1, opts: { [k]: k === 'delay' ? 1000 : 'x' } } }))).toMatchObject([{ path: `template.opts.${k}` }]);
    }
    expect(await issues(upsert({ every: '1m', overlap: 'sometimes', template: { data: 1 } }))).toMatchObject([{ path: 'overlap', reason: 'bad-overlap' }]);
    expect(await issues(upsert({ every: '1m', overlap: 'skp', template: { data: 1 } }))).toMatchObject([{ path: 'overlap', suggestion: 'skip' }]);
    expect(await issues(upsert({ every: '1m', overlap: 'queue', maxQueued: 0, template: { data: 1 } }))).toMatchObject([{ path: 'maxQueued' }]);
    expect(await issues(upsert({ every: '1m', maxQueued: 5, template: { data: 1 } }))).toMatchObject([{ path: 'maxQueued' }]);
    for (const version of [0, 1.5]) expect(await issues(upsert({ version, every: '1m', template: { data: 1 } }))).toMatchObject([{ path: 'version' }]);
    expect(await issues(upsert({ every: '1m', template: { data: 1, opts: { priority: 'high' } } }))).toMatchObject([{ path: 'template.opts.priority' }]);
    expect(await issues(upsert({ every: '1m', overlaps: 'skip', template: { data: 1 } }))).toMatchObject([{ path: 'overlaps', suggestion: 'overlap' }]);
    expect(await issues(upsert({ every: '1m', template: { name: 'bad name', data: 1 } }))).toMatchObject([{ path: 'template.name' }]);
    expect(await issues(upsert({ every: '1m', template: {} }))).toMatchObject([{ path: 'template.data', code: 'missing_option' }]);
    expect(await issues(upsert({ cron: 'nope', template: { data: 1 } }))).toMatchObject([{ path: 'cron', reason: 'bad-cron' }]);
    // every issue in one error
    expect((await issues(upsert({ cron: 'nope', overlap: 'x', template: { data: 1, opts: { id: 'a' } } }))).map((i) => i.path).sort())
      .toEqual(['cron', 'overlap', 'template.opts.id']);
    expect(spy.calls).toEqual([]);
  });

  it('schedule-upsert: oversized or unserializable template data throws before any store call', async () => {
    const { queue, spy } = setup({ maxPayloadBytes: 16 });
    await expect(queue.upsertSchedule('k', { every: '1m', template: { data: 'x'.repeat(20) } })).rejects.toBeInstanceOf(PayloadTooLargeError);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    for (const data of [cycle, 10n]) {
      expect(await issues(queue.upsertSchedule('k', { every: '1m', template: { data } }))).toMatchObject([{ path: 'template.data' }]);
    }
    expect(spy.calls).toEqual([]);
  });

  it('schedule-upsert: key longer than 200 bytes is rejected', async () => {
    const { queue, spy } = setup();
    const def = { every: '1m', template: { data: 1 } };
    for (const key of ['a'.repeat(201), '€'.repeat(67), '']) expect(await issues(queue.upsertSchedule(key, def))).toMatchObject([{ path: 'key' }]);
    expect(spy.calls).toEqual([]);
    expect((await queue.upsertSchedule('a'.repeat(200), def)).action).toBe('created');
    // the fired job id sched:<key>:<tick> must also fit the store's own id limit
    class SmallIds extends MemoryStore {
      override readonly capabilities = defineCapabilities({ ...new MemoryStore().capabilities, limits: { maxIdBytes: 40 } });
    }
    const small = new Queue('small-ids', { store: new SmallIds(), logger: silent });
    expect(await issues(small.upsertSchedule('k'.repeat(18), def))).toMatchObject([{ path: 'key', code: 'out_of_range' }]);
    expect((await small.upsertSchedule('k'.repeat(17), def)).action).toBe('created');
  });

  it('schedule-upsert: timestamps come from store time under a pod clock skewed by one hour', async () => {
    const { queue, clock } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(clock.t + 3_600_000);
    const { schedule } = await queue.upsertSchedule('k', { every: '1m', template: { data: 1 } });
    expect([schedule.anchorAt, schedule.createdAt, schedule.updatedAt, schedule.nextRunAt]).toEqual([clock.t, clock.t, clock.t, clock.t + 60_000]);
  });

  it('schedule-upsert: conflict retries give up with ScheduleConflictError', async () => {
    const { queue, ops } = setup({ over: { putSchedule: async () => ({ ok: false, reason: 'conflict' }) } });
    await expect(queue.upsertSchedule('k', { every: '1m', template: { data: 1 } })).rejects.toSatisfy(
      (e) => e instanceof ScheduleConflictError && e.key === 'k',
    );
    expect(ops('putSchedule')).toBe(10);
  });

  it('schedule-upsert: a closing queue refuses upserts', async () => {
    const { queue } = setup();
    void queue.close();
    await expect(queue.upsertSchedule('k', { every: '1m', template: { data: 1 } })).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
  });

  it('schedule-upsert: a timing with no tick left at a later round throws no-occurrence and writes nothing', async () => {
    const { queue, ops } = setup();
    vi.mocked(nextOccurrence).mockReturnValueOnce(null);
    expect(await issues(queue.upsertSchedule('k', { every: '1m', template: { data: 1 } }))).toMatchObject([{ path: 'cron', reason: 'no-occurrence' }]);
    expect(ops('putSchedule')).toBe(0);
  });

  it('schedule-upsert: fired job id is sched:key:scheduledFor and carries job.schedule', async () => {
    useFakeTime();
    const { queue, clock } = setup();
    const seen: Array<{ id: string; schedule: unknown; frozen: boolean }> = [];
    const w = queue.process((job) => void seen.push({ id: job.id, schedule: job.schedule, frozen: Object.isFrozen(job.schedule) }), { ...poll(10) });
    const { schedule } = await queue.upsertSchedule('k', { every: '1s', template: { data: 1 } });
    const plain = await queue.add(2);
    clock.t += 1000;
    await vi.advanceTimersByTimeAsync(1100);
    const t = schedule.nextRunAt;
    expect(seen.find((s) => s.id !== plain.job.id)).toEqual({ id: `sched:k:${t}`, schedule: { key: 'k', scheduledFor: t }, frozen: true });
    expect(seen.find((s) => s.id === plain.job.id)?.schedule).toBeNull();
    await w.close();
    vi.useRealTimers();
  });

  it('schedule-upsert: queue defaults are applied at fire time', async () => {
    useFakeTime();
    const { queue, clock, raw, scope, stored } = setup();
    const name = queue.name;
    const later = new Queue(name, { store: raw, logger: silent, defaultJobOptions: { priority: 7 }, scheduler: { tickMs: 100 } });
    const first = new Queue(name, { store: raw, logger: silent, defaultJobOptions: { priority: 3 }, scheduler: { tickMs: 100 } });
    await first.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: 1 } });
    await first.upsertSchedule('t', { every: '1s', overlap: 'allow', template: { data: 1, opts: { priority: 9 } } });
    first.startScheduler();
    clock.t += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    await first.stopScheduler();
    later.startScheduler();
    clock.t += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    await later.stopScheduler();
    const jobs = raw.dump().jobs.filter((j) => j.namespace === scope.namespace && j.queue === scope.queue);
    const prio = (key: string) => jobs.filter((j) => j.scheduleKey === key).sort((a, b) => a.scheduledFor! - b.scheduledFor!).map((j) => j.priority);
    expect(prio('k')).toEqual([3, 7]);
    expect(prio('t')).toEqual([9, 9]);
    expect((await stored('k')).template.opts).toEqual({});
    vi.useRealTimers();
    await Promise.all([first.close(), later.close()]);
  });
});

