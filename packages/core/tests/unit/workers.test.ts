import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, QueueClosedError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import { FORMAT_SUPPORT, SUREQ_VERSION } from '../../src/format/support.js';
import { Queue } from '../../src/queue/queue.js';
import { toWorkerInfos } from '../../src/registry/info.js';
import type { ListWorkersResult, RegisterWorkerRequest, Store, WorkerRecord } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { freezable } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const NS = { namespace: 'default' };
const HB = { ...poll(50), heartbeatInterval: '1s', random: () => 0.5 } as const;
const queues: Queue[] = [];
const track = (q: Queue): Queue => (queues.push(q), q);

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(10).catch(() => {});
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

/** A MemoryStore on a hand-moved clock; `tick` moves it with the fake timers in 100 ms steps. */
function world(over: Parameters<typeof spyStore>[1] = {}) {
  useFakeTime();
  const clock = { now: 1_000_000 };
  const raw = new MemoryStore({ clock: () => clock.now });
  const spy = spyStore(raw, over);
  const queue = (store: Store = spy.store, opts: ConstructorParameters<typeof Queue>[1] = {}) => track(new Queue('h', { logger: silent, ...opts, store }));
  const tick = async (ms: number) => {
    for (let left = ms; left > 0; left -= 100) {
      const step = Math.min(100, left);
      clock.now += step;
      await vi.advanceTimersByTimeAsync(step);
    }
  };
  const ops = (op: string) => spy.calls.filter((c) => c.op === op);
  return { raw, spy, clock, queue, tick, ops };
}

const reg = (over: Partial<RegisterWorkerRequest> = {}): RegisterWorkerRequest => ({
  workerId: 'direct', queues: ['h'], concurrency: 1, sureqVersion: SUREQ_VERSION, formatVersion: 1, heartbeatIntervalMs: 1000, host: 'x', pid: 1,
  labels: {}, scheduler: false, ...over,
});

const record = (over: Partial<WorkerRecord>): WorkerRecord => ({
  ...reg(), names: null, activeJobs: 0, status: 'running', startedAt: 0, lastHeartbeatAt: 0, ...over,
});

describe('workers', () => {
  it('workers: labels over limit throw InvalidOptionError at worker creation', async () => {
    const w = world();
    const q = w.queue();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ labels: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'])) }, 'labels'],
      [{ labels: { ['k'.repeat(65)]: 'v' } }, `labels.${'k'.repeat(64)}`],
      [{ labels: { k: 'v'.repeat(65) } }, 'labels.k'],
      [{ labels: { k: 1 } }, 'labels.k'],
      [{ labels: 'x' }, 'labels'],
      [{ host: '' }, 'host'],
      [{ heartbeatInterval: '500ms' }, 'heartbeatInterval'],
      [{ heartbeatInterval: '2d' }, 'heartbeatInterval'],
    ];
    for (const [opts, path] of bad) {
      let caught: unknown;
      try {
        q.process(async () => {}, opts);
      } catch (e) {
        caught = e;
      }
      expect(caught, path).toBeInstanceOf(InvalidOptionError);
      expect((caught as InvalidOptionError).issues.map((i) => i.path), path).toContain(path);
    }
    q.process(async () => {}, poll(50));
    await w.tick(100);
    const [info] = await q.getWorkers();
    expect(info).toMatchObject({ host: hostname(), labels: {} });
    expect(w.ops('registerWorker')[0]!.args[1]).toMatchObject({ heartbeatIntervalMs: 10_000 });
  });

  it('workers: includeStale returns dead workers flagged stale', () => {
    const res: ListWorkersResult = {
      now: 100_000,
      workers: [
        record({ workerId: 'a', lastHeartbeatAt: 97_000, heartbeatIntervalMs: 1000 }),
        record({ workerId: 'b', lastHeartbeatAt: 96_999, heartbeatIntervalMs: 1000 }),
        record({ workerId: 'c', lastHeartbeatAt: 96_999, heartbeatIntervalMs: 10_000 }),
      ],
    };
    const live = toWorkerInfos(res, { includeStale: false });
    expect(live.map((w) => [w.workerId, w.stale])).toEqual([['a', false], ['c', false]]);
    const all = toWorkerInfos(res, { includeStale: true });
    expect(all.map((w) => [w.workerId, w.stale, w.heartbeatAgeMs])).toEqual([['a', false, 3000], ['b', true, 3001], ['c', false, 3001]]);
  });

  it('workers: getWorkers sorts by startedAt then workerId', async () => {
    const res: ListWorkersResult = {
      now: 10,
      workers: [record({ workerId: 'z', startedAt: 5 }), record({ workerId: 'b', startedAt: 7 }), record({ workerId: 'a', startedAt: 5 })],
    };
    expect(toWorkerInfos(res, { includeStale: true }).map((w) => w.workerId)).toEqual(['a', 'z', 'b']);
    const w = world();
    const q = w.queue();
    await w.raw.open();
    await w.raw.registerWorker(NS, reg({ workerId: 'y' }));
    await w.raw.registerWorker(NS, reg({ workerId: 'x' }));
    await w.raw.registerWorker(NS, reg({ workerId: 'other', queues: ['elsewhere'] }));
    expect((await q.getWorkers()).map((i) => i.workerId)).toEqual(['x', 'y']);
    const broken = world({ listWorkers: () => Promise.reject(new Error('down')) });
    await expect(broken.queue().getWorkers()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'listWorkers' });
    await expect(q.getWorkers({ includeStale: 'yes' as never })).rejects.toBeInstanceOf(InvalidOptionError);
  });

  it('workers: getWorkers lists workers started on other queue instances', async () => {
    const w = world();
    const [q1, q2] = [w.queue(), w.queue()];
    const a = q1.process(async () => {}, HB);
    const b = q2.process(async () => {}, HB);
    await w.tick(100);
    for (const q of [q1, q2]) {
      const infos = await q.getWorkers();
      expect(infos.map((i) => i.workerId).sort()).toEqual([a.id, b.id].sort());
      for (const i of infos) expect(i).toMatchObject({ queues: ['h'], host: hostname(), pid: process.pid, status: 'running', stale: false });
    }
  });

  it('workers: worker with autorun false is listed only after run', async () => {
    const w = world();
    const q = w.queue();
    const never = q.process(async () => {}, { ...HB, autorun: false });
    await never.close();
    const worker = q.process(async () => {}, { ...HB, autorun: false });
    await w.tick(5000);
    expect(await q.getWorkers()).toEqual([]);
    await worker.run();
    await w.tick(10);
    expect((await q.getWorkers()).map((i) => i.workerId)).toEqual([worker.id]);
    expect(w.ops('registerWorker').map((c) => (c.args[1] as RegisterWorkerRequest).workerId)).toEqual([worker.id]);
    expect(w.ops('unregisterWorker')).toEqual([]);
  });

  it('workers: killed worker disappears after three heartbeat intervals', async () => {
    const w = world();
    const view = freezable(w.raw);
    const pod = w.queue(view);
    const observer = w.queue(w.raw);
    const worker = pod.process(async () => {}, HB);
    await w.tick(1000);
    view.freeze();
    await w.tick(2900);
    expect((await observer.getWorkers()).map((i) => i.workerId)).toEqual([worker.id]);
    await w.tick(200);
    expect(await observer.getWorkers()).toEqual([]);
    const [dead] = await observer.getWorkers({ includeStale: true });
    expect(dead).toMatchObject({ workerId: worker.id, stale: true });
    expect(dead!.heartbeatAgeMs).toBeGreaterThan(3000);
    view.unfreeze();
  });

  it('workers: graceful shutdown removes the record and shows draining first', async () => {
    const w = world();
    const q = w.queue();
    await q.add({});
    const worker = q.process((_job, ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))), {
      ...HB, shutdownTimeout: '100ms', shutdownAbortGrace: '100ms',
    });
    await w.tick(100);
    expect(worker.inFlight).toBe(1);
    const closing = worker.close();
    await w.tick(2000);
    await closing;
    const order = w.spy.calls.map((c) => c.op);
    const draining = w.spy.calls.findIndex((c) => c.op === 'heartbeatWorker' && (c.args[1] as { status: string }).status === 'draining');
    expect(draining).toBeGreaterThan(-1);
    expect(draining).toBeLessThan(order.indexOf('release'));
    expect(order.indexOf('release')).toBeLessThan(order.indexOf('unregisterWorker'));
    expect(await q.getWorkers({ includeStale: true })).toEqual([]);
  });

  it('workers: failed heartbeat does not stop jobs and recovers next tick', async () => {
    let failures = 0;
    const w = world({
      heartbeatWorker: (ns, req) => (failures-- > 0 ? Promise.reject(Object.assign(new Error('down'), { code: 'X' })) : w.raw.heartbeatWorker(ns, req)),
    });
    const q = w.queue();
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    const completed = vi.fn();
    q.on('completed', completed);
    await q.add({});
    q.process(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return 'done';
    }, HB);
    await w.tick(1000);
    failures = 3;
    await w.tick(3500);
    const before = (await w.raw.listWorkers(NS, {})).workers[0]!.lastHeartbeatAt;
    await w.tick(1000);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(errors.filter((e) => e.context.operation === 'heartbeatWorker')).toHaveLength(1);
    expect((await w.raw.listWorkers(NS, {})).workers[0]!.lastHeartbeatAt).toBeGreaterThan(before);
  });

  it('workers: worker re-registers after its record was cleaned', async () => {
    const w = world();
    const q = w.queue();
    const worker = q.process(async () => {}, HB);
    await w.tick(100);
    const [first] = await q.getWorkers();
    await w.raw.unregisterWorker(NS, { workerId: worker.id });
    expect(await q.getWorkers()).toEqual([]);
    await w.tick(1000);
    const [again] = await q.getWorkers();
    expect(again!.workerId).toBe(worker.id);
    expect(again!.startedAt).toBeGreaterThan(first!.startedAt);
    expect(w.ops('registerWorker')).toHaveLength(2);
  });

  it('workers: liveness uses store time under pod clock skew ±1h', async () => {
    for (const skew of [3_600_000, -3_600_000]) {
      const w = world();
      const view = freezable(w.raw);
      const steady = w.queue(w.raw);
      const frozenPod = w.queue(view);
      const a = steady.process(async () => {}, HB);
      const b = frozenPod.process(async () => {}, HB);
      await w.tick(1000);
      vi.setSystemTime(Date.now() + skew);
      view.freeze();
      await w.tick(2500);
      expect((await steady.getWorkers()).map((i) => i.workerId).sort()).toEqual([a.id, b.id].sort());
      await w.tick(1000);
      expect((await steady.getWorkers()).map((i) => i.workerId)).toEqual([a.id]);
      view.unfreeze();
      await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
    }
  });

  it('workers: registry state never affects claim or sweep', async () => {
    const w = world();
    const q = w.queue();
    const runs = new Map<string, number>();
    const stalled = vi.fn();
    q.on('stalled', stalled);
    for (let i = 0; i < 20; i++) await q.add({ i }, { id: `j${i}` });
    const handler = async (job: { id: string }) => {
      runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 200));
    };
    q.process(handler, { ...HB, sweepInterval: '500ms' });
    q.process(handler, { ...HB, sweepInterval: '500ms' });
    for (let t = 0; t < 4000; t += 100) {
      await w.raw.purgeWorkers(NS, { staleIntervals: 0, limit: 1000 });
      await w.tick(100);
    }
    expect([...runs.values()]).toEqual(Array.from({ length: 20 }, () => 1));
    expect((await q.getCounts()).completed).toBe(20);
    expect(stalled).not.toHaveBeenCalled();
    // only the registry check at worker start reads the registry (one per Queue object), never the claim or sweep
    expect(w.ops('listWorkers')).toHaveLength(1);
  });

  it('workers: record carries sureqVersion and formatVersion', async () => {
    const w = world();
    const q = w.queue();
    q.process(async () => {}, { ...HB, labels: { zone: 'eu-1', role: 'api' }, host: 'pod-7' });
    await w.tick(100);
    const [rec] = (await w.raw.listWorkers(NS, {})).workers;
    expect(rec).toMatchObject({
      sureqVersion: SUREQ_VERSION, formatVersion: FORMAT_SUPPORT.current, heartbeatIntervalMs: 1000, labels: { zone: 'eu-1', role: 'api' }, host: 'pod-7',
      names: [null], concurrency: 1, scheduler: true,
    });
  });

  it('workers: a hung unregister does not extend close beyond its bound', async () => {
    const w = world({ unregisterWorker: () => new Promise(() => {}) });
    const q = w.queue();
    const worker = q.process(async () => {}, { ...HB, shutdownTimeout: '1s', shutdownAbortGrace: '500ms' });
    await w.tick(100);
    const started = performance.now();
    let closedAt: number | undefined;
    void worker.close().then(() => (closedAt = performance.now()));
    await w.tick(3000);
    expect(w.ops('unregisterWorker')).toHaveLength(1);
    expect(closedAt).toBeDefined();
    expect(closedAt! - started).toBeLessThanOrEqual(1000 + 500 + 1000);
  });

  it('workers: a hung heartbeat in flight or while draining does not extend close beyond its bound', async () => {
    for (const hang of ['in flight', 'draining'] as const) {
      const w = world({
        heartbeatWorker: (ns, req) =>
          hang === 'in flight' || req.status === 'draining' ? new Promise(() => {}) : w.raw.heartbeatWorker(ns, req),
      });
      const q = w.queue();
      const errors: ErrorEvent[] = [];
      q.on('error', (e) => void errors.push(e));
      const worker = q.process(async () => {}, { ...HB, shutdownTimeout: '1s', shutdownAbortGrace: '500ms' });
      await w.tick(1500);
      expect(w.ops('heartbeatWorker').length, hang).toBeGreaterThan(0);
      const started = performance.now();
      let closedAt: number | undefined;
      void worker.close().then(() => (closedAt = performance.now()));
      await w.tick(3000);
      expect(closedAt, hang).toBeDefined();
      expect(closedAt! - started, hang).toBeLessThanOrEqual(1000 + 500 + 1000);
      expect(errors, hang).toEqual([]);
      await q.close({ timeoutMs: 100 });
      vi.useRealTimers();
    }
  });

  it('workers: an unregister that rejects is reported once and close still resolves', async () => {
    const w = world({ unregisterWorker: () => Promise.reject(Object.assign(new Error('down'), { code: 'X' })) });
    const q = w.queue();
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    const worker = q.process(async () => {}, HB);
    await w.tick(100);
    const closing = worker.close().then(() => 'resolved', (e: unknown) => e);
    await w.tick(2000);
    // a rejecting unregister is not a lease that could not be released: no AggregateError
    expect(await closing).toBe('resolved');
    expect(w.ops('unregisterWorker')).toHaveLength(1);
    expect(errors.map((e) => [e.source, e.context.operation])).toEqual([['store', 'unregisterWorker']]);
  });

  it('workers: getWorkers after close throws QueueClosedError', async () => {
    const w = world();
    const q = w.queue();
    q.process(async () => {}, HB);
    await w.tick(100);
    await q.close({ timeoutMs: 100 });
    await expect(q.getWorkers()).rejects.toBeInstanceOf(QueueClosedError);
  });

  it('workers: sweeper purges records older than ten heartbeat intervals', async () => {
    const w = world();
    const q = w.queue();
    await w.raw.open();
    await w.raw.registerWorker(NS, reg({ workerId: 'dead', heartbeatIntervalMs: 1000 }));
    q.process(async () => {}, { ...HB, sweepInterval: '1s' });
    await w.tick(9000);
    expect((await q.getWorkers({ includeStale: true })).map((i) => i.workerId)).toContain('dead');
    await w.tick(2000);
    expect((await q.getWorkers({ includeStale: true })).map((i) => i.workerId)).not.toContain('dead');
    expect(w.ops('purgeWorkers')[0]!.args[1]).toEqual({ staleIntervals: 10, limit: 100 });
  });

  it('workers: sweeper purge judges each record by its own heartbeat interval', async () => {
    const w = world();
    const q = w.queue();
    await w.raw.open();
    // a live worker that beats every 60 s, far slower than this pod
    await w.raw.registerWorker(NS, reg({ workerId: 'slow', heartbeatIntervalMs: 60_000 }));
    q.process(async () => {}, { ...HB, sweepInterval: '1s' });
    await w.tick(30_000);
    expect((await q.getWorkers({ includeStale: true })).map((i) => i.workerId)).toContain('slow');
  });

  it('workers: a failing stats read after a sweep does not skip the purge, nor a failing purge the stats read', async () => {
    const statsDown = world({ stats: () => Promise.reject(new Error('down')) });
    const q = statsDown.queue();
    await statsDown.raw.open();
    await statsDown.raw.registerWorker(NS, reg({ workerId: 'dead', heartbeatIntervalMs: 1000 }));
    q.process(async () => {}, { ...HB, sweepInterval: '1s' });
    await statsDown.tick(11_000);
    expect(statsDown.ops('stats').length).toBeGreaterThan(0);
    expect((await q.getWorkers({ includeStale: true })).map((i) => i.workerId)).not.toContain('dead');
    await q.close({ timeoutMs: 100 });

    const purgeDown = world({ purgeWorkers: () => Promise.reject(new Error('down')) });
    const p = purgeDown.queue();
    p.process(async () => {}, { ...HB, sweepInterval: '1s' });
    await purgeDown.tick(3500);
    expect(purgeDown.ops('purgeWorkers').length).toBeGreaterThanOrEqual(2);
    expect(purgeDown.ops('stats')).toHaveLength(purgeDown.ops('purgeWorkers').length);
  });

  it('workers: health warns when schedules exist and no live worker runs a scheduler', async () => {
    const w = world();
    const q = w.queue(undefined, { scheduler: { enabled: false } });
    q.process(async () => {}, HB);
    await w.tick(61_000);
    expect((await q.health()).warnings.map((x) => x.code)).not.toContain('NO_SCHEDULER_RUNNING');
    await q.upsertSchedule('k', { every: '1h', template: { data: {} } });
    await w.tick(60_000);
    const h = await q.health();
    expect(h.warnings.map((x) => x.code)).toContain('NO_SCHEDULER_RUNNING');
    // a scheduler on a pod without a worker is not in the registry, so the warning cannot claim nothing fires
    expect(h.warnings.find((x) => x.code === 'NO_SCHEDULER_RUNNING')!.message).not.toContain('no schedule fires');
    expect(h).toMatchObject({ status: 'degraded', live: true });
    q.startScheduler();
    await w.tick(60_000);
    expect((await q.health()).warnings.map((x) => x.code)).not.toContain('NO_SCHEDULER_RUNNING');
  });

  it('workers: the scheduler check runs at worker start, not a full check interval later (regression)', async () => {
    const w = world();
    const q = w.queue(undefined, { scheduler: { enabled: false } });
    await q.upsertSchedule('k', { every: '1h', template: { data: {} } });
    q.process(async () => {}, HB);
    await w.tick(1000);
    expect((await q.health()).warnings.map((x) => x.code)).toContain('NO_SCHEDULER_RUNNING');
  });

  it('workers: the first scheduler check counts this pod\'s own scheduler before its worker is registered (regression)', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = world({ registerWorker: async (...args: Parameters<Store['registerWorker']>) => { await gate; return w.raw.registerWorker(...args); } });
    const q = w.queue();
    await q.upsertSchedule('k', { every: '1h', template: { data: {} } });
    q.process(async () => {}, HB);
    await w.tick(1000);
    expect((await q.health()).warnings.map((x) => x.code)).not.toContain('NO_SCHEDULER_RUNNING');
    open();
  });

  it('workers: a scheduler warning from the first check is re-checked within seconds, not a full interval (regression)', async () => {
    const w = world();
    // this pod runs no scheduler; another pod's scheduler worker registers just after this pod's first check
    const q = w.queue(undefined, { scheduler: { enabled: false } });
    await q.upsertSchedule('k', { every: '1h', template: { data: {} } });
    q.process(async () => {}, HB);
    await w.tick(1000);
    expect((await q.health()).warnings.map((x) => x.code)).toContain('NO_SCHEDULER_RUNNING');
    await w.raw.registerWorker(NS, reg({ workerId: 'other', scheduler: true, heartbeatIntervalMs: 60_000 }));
    await w.tick(5000);
    expect((await q.health()).warnings.map((x) => x.code)).not.toContain('NO_SCHEDULER_RUNNING');
  });

  it('workers: no scheduler warning while every schedule is paused', async () => {
    const w = world();
    const q = w.queue(undefined, { scheduler: { enabled: false } });
    q.process(async () => {}, HB);
    for (const key of ['a', 'b']) {
      await q.upsertSchedule(key, { every: '1h', template: { data: {} } });
      await q.pauseSchedule(key);
    }
    await w.tick(61_000);
    expect((await q.health()).warnings.map((x) => x.code)).not.toContain('NO_SCHEDULER_RUNNING');
    await q.resumeSchedule('b');
    await w.tick(60_000);
    expect((await q.health()).warnings.map((x) => x.code)).toContain('NO_SCHEDULER_RUNNING');
  });

  it('workers: a batch worker reports its unsettled batch jobs as active', async () => {
    const w = world();
    const q = w.queue();
    await q.addBulk([1, 2, 3].map((data) => ({ data })));
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    q.processBatch(async (batch, ctx) => {
      await ctx.complete(batch.jobs[0]!, 1);
      await held;
    }, { ...HB, batchSize: 5 });
    await w.tick(1100);
    const [info] = await q.getWorkers();
    expect(info).toMatchObject({ concurrency: 1, activeJobs: 2 });
    open();
    await w.tick(1100);
    expect((await q.getWorkers())[0]).toMatchObject({ activeJobs: 0 });
  });

  it('workers: redrive and job retry work while a worker keeps its record', async () => {
    const w = world();
    const q = w.queue();
    const done: string[] = [];
    let fail = true;
    q.process(async (job) => {
      if (fail) throw new Error('boom');
      done.push(job.id);
    }, HB);
    const a = await q.add({}, { maxAttempts: 1 });
    const b = await q.add({}, { maxAttempts: 1 });
    await w.tick(1100);
    expect((await q.getJob(a.job.id))!.state).toBe('failed');
    fail = false;
    expect(await q.redrive(a.job.id)).toMatchObject({ status: 'redriven' });
    expect(await (await q.getJob(b.job.id))!.retry()).toMatchObject({ status: 'redriven' });
    await w.tick(1100);
    expect(done.sort()).toEqual([a.job.id, b.job.id].sort());
    expect((await q.getWorkers()).map((i) => i.status)).toEqual(['running']);
    expect(w.ops('heartbeatWorker').length).toBeGreaterThan(0);
  });
});
