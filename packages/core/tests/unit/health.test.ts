import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { InvalidOptionError, StoreNotReadyError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { HealthReport } from '../../src/index.js';
import { Queue } from '../../src/queue/queue.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { clientFor, type StoreClient } from '../../src/store/client.js';
import { buildHealth } from '../../src/health/health.js';
import type { Store } from '../../src/store/contract.js';
import type { FaultHooks } from '../../src/store/types.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { outageStore, type OutageCtl } from '../helpers/outage.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  const closing = Promise.allSettled(queues.splice(0).map((q) => q.close({ timeoutMs: 0 })));
  await vi.advanceTimersByTimeAsync(10_000);
  await closing;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** No jitter and no sweeps; the default poll wait (pollMax 5 s). */
const steady = { random: () => 0.5, sweepInterval: 3_600_000 };
const ALL_CLEAR = { onTime: true, lateJobs: 0, worstLagMs: 0 };

/** A queue on a MemoryStore reading the fake clock, optionally wrapped; probes every 100 ms while down. */
function world(o: { wrap?: (inner: MemoryStore) => Store; queue?: QueueOptions; faults?: FaultHooks } = {}) {
  useFakeTime();
  const inner = new MemoryStore({ clock: () => Date.now(), ...(o.faults && { faults: o.faults }) });
  const store = o.wrap?.(inner) ?? inner;
  clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
  const q = new Queue('hq', { store, logger: silent, ...o.queue });
  queues.push(q);
  return { inner, store, q };
}

/** Claims by the worker "dead" never answer; the store stays connected. */
const stuckClaims = (inner: MemoryStore): Store =>
  spyStore(inner, { claim: (scope, req) => (req.workerId === 'dead' ? new Promise(() => {}) : inner.claim(scope, req)) }).store;

/** A handler that runs until its signal aborts. */
const untilAborted = (_job: unknown, ctx: { signal: AbortSignal }) => new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r()));

describe('health report', () => {
  it('health: healthy queue returns ok with live and ready true', async () => {
    const w = world();
    const worker = w.q.process(() => 'ok', steady);
    await w.q.add(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(await w.q.getCounts()).toMatchObject({ completed: 1 });
    const r = await w.q.health();
    expect(r).toMatchObject({ live: true, ready: true, status: 'ok', warnings: [], queue: { paused: false }, store: { ok: true, state: 'connected' } });
    expect(r.store.latencyMs).toEqual(expect.any(Number));
    expect(r.checkedAt).toBe(Date.now());
    expect(r.workers).toEqual([
      { workerId: worker.id, state: 'running', paused: false, loopAlive: true, lastLoopAt: expect.any(Number), activeJobs: 0, renewals: ALL_CLEAR },
    ]);
  });

  it('health: store down gives ready false, live true, status degraded and never throws', async () => {
    let down = false;
    const w = world({
      faults: {
        before(op) {
          if (down && op === 'now') throw new Error('ECONNREFUSED');
        },
      },
    });
    w.q.process(() => 'ok', steady);
    await vi.advanceTimersByTimeAsync(100);
    down = true;
    const r = await w.q.health();
    expect(r.store.ok).toBe(false);
    expect(r.store.error).toContain('ECONNREFUSED');
    expect(r).toMatchObject({ ready: false, live: true, status: 'degraded' });
    // Still down: not probed again, still a report.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await w.q.health()).toMatchObject({ ready: false, live: true, status: 'degraded', store: { ok: false, state: 'reconnecting' } });
  });

  it('health: store timeout is reported as an error and the rest of the report is returned', async () => {
    let hang = false;
    // A hung now() that fails long after health gave up on it.
    const w = world({ wrap: (inner) => spyStore(inner, { now: () => (hang ? new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 2000)) : inner.now()) }).store });
    w.q.process(() => 'ok', steady);
    await vi.advanceTimersByTimeAsync(100);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      hang = true;
      let settled = false;
      const p = w.q.health({ timeoutMs: 500 }).then((r) => ((settled = true), r));
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = await p;
      expect(r.store).toEqual({ ok: false, latencyMs: null, state: 'connected', durable: false, error: 'timeout' });
      expect(r.workers).toHaveLength(1);
      expect(r).toMatchObject({ ready: false, live: true });
      await vi.advanceTimersByTimeAsync(3000);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('health: dead worker loop makes live false after the threshold', async () => {
    // The worker "dead" sends a claim that never answers while the store stays connected: its loop is wedged.
    const w = world({ wrap: stuckClaims });
    const dead = w.q.process(() => 'ok', { ...steady, workerId: 'dead' });
    const healthy = w.q.process(() => 'ok', steady);
    // Default pollMax 5 s: dead after 3 × 5 s.
    await vi.advanceTimersByTimeAsync(14_999);
    expect((await w.q.health()).live).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    const r = await w.q.health();
    expect(r).toMatchObject({ live: false, status: 'down', store: { ok: true, state: 'connected' } });
    expect(r.workers.map((x) => [x.workerId, x.loopAlive])).toEqual([[dead.id, false], [healthy.id, true]]);

    // pollMax 1 s: the 10 s floor applies.
    const v = world({ wrap: stuckClaims });
    v.q.process(() => 'ok', { ...steady, pollMax: 1000, workerId: 'dead' });
    await vi.advanceTimersByTimeAsync(9_999);
    expect((await v.q.health()).live).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect((await v.q.health()).workers[0]!.loopAlive).toBe(false);
  });

  it('health: a worker with every slot busy on long jobs stays live', async () => {
    const w = world();
    await w.q.add(1);
    await w.q.add(2);
    const worker = w.q.process(untilAborted, { ...steady, concurrency: 2 });
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await w.q.health();
    expect(worker.inFlight).toBe(2);
    expect(r).toMatchObject({ live: true, status: 'ok' });
    // It claims nothing, yet its loop still goes round at least every pollMax.
    expect(Date.now() - r.workers[0]!.lastLoopAt!).toBeLessThanOrEqual(5000);
  });

  it('health: a worker loop that ended while running makes live false', async () => {
    let broken = false;
    // A malformed claim result that throws only once the loop itself reads it: the loop ends.
    const w = world({
      wrap: (inner) => spyStore(inner, {
        claim: async (scope, req) => {
          const res = await inner.claim(scope, req);
          if (!broken) return res;
          let reads = 0;
          return Object.defineProperty({ ...res }, 'jobs', {
            get: () => {
              if (++reads > 3) throw new TypeError('bad claim result');
              return res.jobs;
            },
          });
        },
      }).store,
    });
    const errors: string[] = [];
    w.q.on('error', (e) => void errors.push(e.context.operation ?? ''));
    const worker = w.q.process(() => 'ok', steady);
    await vi.advanceTimersByTimeAsync(100);
    broken = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(errors).toEqual(['loop']);
    expect(worker.state).toBe('running');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await w.q.health()).toMatchObject({ live: false, status: 'down' });
  });

  it('health: created and stopped workers are not judged', async () => {
    const w = world();
    const worker = w.q.process(() => 'ok', { ...steady, autorun: false });
    await vi.advanceTimersByTimeAsync(3_600_000);
    let r = await w.q.health();
    expect(r.workers[0]).toMatchObject({ state: 'created', loopAlive: true, lastLoopAt: null });
    expect(r.live).toBe(true);
    await worker.run();
    await worker.close();
    await vi.advanceTimersByTimeAsync(3_600_000);
    r = await w.q.health();
    expect(r.workers[0]).toMatchObject({ state: 'stopped', loopAlive: true });
    expect(r.live).toBe(true);
  });

  it('health: paused worker still counts as alive', async () => {
    const w = world();
    const worker = w.q.process(() => 'ok', steady);
    await worker.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await w.q.health();
    expect(r.workers[0]).toMatchObject({ loopAlive: true, paused: true, state: 'running' });
    expect(r.live).toBe(true);
  });

  it('health: worker whose claim call hangs during an outage stays live because the loop still ticks', async () => {
    let ctl!: OutageCtl;
    const w = world({ wrap: (inner) => ({ ctl } = outageStore(stuckClaims(inner))).store });
    // Claims are never refused, the stuck one just never answers; everything else fails while down.
    ctl.failing = (op) => ctl.down && op !== 'claim';
    w.q.process(() => 'ok', { ...steady, workerId: 'dead' });
    w.q.process(() => 'ok', steady);
    await vi.advanceTimersByTimeAsync(100);
    ctl.down = true;
    await w.q.health(); // its now() fails: the outage begins
    expect(w.q.connectionState).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await w.q.health();
    expect(r).toMatchObject({ live: true, status: 'degraded', store: { state: 'reconnecting' } });
    expect(r.workers.map((x) => x.loopAlive)).toEqual([true, true]);
    // The idle worker's loop keeps going round during the outage, at least every pollMax.
    expect(Date.now() - r.workers[1]!.lastLoopAt!).toBeLessThanOrEqual(5000);
  });

  it('health: worker in reconnecting state is not judged for loop liveness', async () => {
    let ctl!: OutageCtl;
    const w = world({ wrap: (inner) => ({ ctl } = outageStore(stuckClaims(inner))).store });
    ctl.failing = (op) => ctl.down && op === 'now';
    w.q.process(() => 'ok', { ...steady, workerId: 'dead' });
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await w.q.health()).live).toBe(false);
    ctl.down = true;
    const r = await w.q.health();
    expect(r.workers[0]!.loopAlive).toBe(true);
    expect(r).toMatchObject({ live: true, status: 'degraded', store: { ok: false, state: 'reconnecting' } });
    expect(r.warnings.map((x) => x.code)).toEqual(['STORE_RECONNECTING']);
    // Connected again: the wedged loop is judged again.
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(w.q.connectionState).toBe('connected');
    expect((await w.q.health()).live).toBe(false);
  });

  it('health: a store that throws a value with no prototype still gets a report', async () => {
    let bad = false;
    const w = world({ wrap: (inner) => spyStore(inner, { now: () => (bad ? Promise.reject(Object.create(null) as unknown) : inner.now()) }).store });
    await w.q.ready();
    bad = true;
    const r = await w.q.health();
    expect(r).toMatchObject({ ready: false, live: true, store: { ok: false } });
    expect(r.store.error).toContain('unknown error');
  });

  it('health: late renewal sets onTime false and adds RENEWALS_LATE', async () => {
    const w = world({ wrap: (inner) => spyStore(inner, { renew: () => new Promise(() => {}) }).store, queue: { leaseDuration: '3s' } });
    await w.q.add(1);
    const worker = w.q.process(untilAborted, steady);
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect((await w.q.health()).workers[0]!.renewals.onTime).toBe(true);
    await vi.advanceTimersByTimeAsync(500); // heartbeat every 1 s; late past 2 s without a good renew
    const r = await w.q.health();
    expect(r.workers[0]!.renewals).toMatchObject({ onTime: false, lateJobs: 1 });
    expect(r.workers[0]!.renewals.worstLagMs).toBeGreaterThanOrEqual(2000);
    expect(r.warnings.map((x) => x.code)).toEqual(['RENEWALS_LATE']);
    expect(r).toMatchObject({ status: 'degraded', live: true, ready: true });
  });

  it("health: renewal lateness uses each job's own lease length", async () => {
    const w = world({
      wrap: (inner) => spyStore(inner, { renew: () => new Promise(() => {}) }).store,
      queue: { leaseDurationByName: { slow: '30s', fast: '3s' } },
    });
    await w.q.add(1, { name: 'slow' });
    await w.q.add(2, { name: 'fast' });
    const worker = w.q.process({ slow: untilAborted, fast: untilAborted }, { ...steady, concurrency: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.inFlight).toBe(2);
    // 2.5 s without a renew: late for a 3 s lease (over 2 s), on time for a 30 s one (under 20 s).
    await vi.advanceTimersByTimeAsync(2500);
    expect((await w.q.health()).workers[0]!.renewals).toMatchObject({ onTime: false, lateJobs: 1 });
    // The fast lease ran out at 3 s, so only the slow job is still tracked; it is late past 20 s.
    await vi.advanceTimersByTimeAsync(17_000);
    expect((await w.q.health()).workers[0]!.renewals).toMatchObject({ onTime: true, lateJobs: 0 });
    await vi.advanceTimersByTimeAsync(1500);
    const r = (await w.q.health()).workers[0]!;
    expect(r.renewals.lateJobs).toBe(1);
    expect(r.renewals.worstLagMs).toBeGreaterThan(20_000);
  });

  it('health: global pause adds QUEUE_PAUSED warning but stays ready', async () => {
    const w = world();
    w.q.process(() => 'ok', steady);
    await w.q.pause();
    const r = await w.q.health();
    expect(r).toMatchObject({ queue: { paused: true }, ready: true, live: true, status: 'degraded' });
    expect(r.warnings.map((x) => x.code)).toEqual(['QUEUE_PAUSED']);
  });

  it('health: ready becomes false when shutdown starts', async () => {
    const w = world();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    await w.q.add(1);
    w.q.process(() => gate, steady);
    await vi.advanceTimersByTimeAsync(0);
    expect((await w.q.health()).ready).toBe(true);
    const closing = w.q.close();
    expect(await w.q.health()).toMatchObject({ ready: false, live: true });
    finish();
    await closing;

    const p = world();
    await p.q.ready();
    const done = p.q.close();
    expect(await p.q.health()).toMatchObject({ ready: false, live: true });
    await done;
  });

  it('health: producer-only queue is live with no workers', async () => {
    const w = world();
    await w.q.ready();
    expect(await w.q.health()).toMatchObject({ workers: [], live: true, ready: true, status: 'ok' });
  });

  it('health: report shape matches the HealthReport type', async () => {
    const w = world();
    w.q.process(() => 'ok', steady);
    await w.q.ready();
    const r = await w.q.health();
    expectTypeOf(r).toEqualTypeOf<HealthReport>();
    expect(Object.keys(r).sort()).toEqual(['alerts', 'checkedAt', 'format', 'live', 'queue', 'ready', 'status', 'store', 'warnings', 'workers']);
    expect(Object.keys(r.format).sort()).toEqual(['degraded', 'storeFormat', 'supported']);
    expect(Object.keys(r.store).sort()).toEqual(['durable', 'latencyMs', 'ok', 'state']);
    expect(Object.keys(r.workers[0]!).sort()).toEqual(['activeJobs', 'lastLoopAt', 'loopAlive', 'paused', 'renewals', 'state', 'workerId']);
    expect(Object.keys(r.queue)).toEqual(['paused']);
  });

  it('health: a fresh queue opens its store and reports ready; after close it never throws', async () => {
    useFakeTime();
    const spy = spyStore(new MemoryStore());
    const q = new Queue('fresh', { store: spy.store, logger: silent });
    const before = await q.health();
    expect(before).toMatchObject({ ready: true, live: true, status: 'ok', store: { ok: true, state: 'connected' }, warnings: [] });
    expect(spy.calls.map((c) => c.op)).toContain('open');
    await q.close();
    const after = await q.health();
    expect(after).toMatchObject({ ready: false, store: { ok: false, state: 'closed' } });
  });

  it('health: never rejects or outlasts its timeout against a fault-injecting store', async () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    let faulty = false;
    const now = (inner: MemoryStore): Promise<number> => {
      if (!faulty) return inner.now();
      const x = rand();
      if (x < 0.25) throw new Error('boom');
      if (x < 0.5) return new Promise(() => {});
      return new Promise((r) => setTimeout(() => void inner.now().then(r), Math.floor(rand() * 3000)));
    };
    const w = world({ wrap: (inner) => spyStore(inner, { now: () => now(inner) }).store });
    w.q.process(() => 'ok', steady);
    await w.q.ready();
    faulty = true;
    const seen = { ok: 0, timeout: 0, failed: 0, notProbed: 0 };
    for (let i = 0; i < 200; i++) {
      let outcome: 'pending' | 'rejected' | HealthReport = 'pending';
      void w.q.health({ timeoutMs: 1000 }).then((r) => (outcome = r), () => (outcome = 'rejected'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(typeof outcome, `iteration ${i}`).toBe('object');
      const { store } = outcome as unknown as HealthReport;
      if (store.ok) seen.ok++;
      else if (store.error === 'timeout') seen.timeout++;
      else if (store.error?.startsWith('store is ')) seen.notProbed++;
      else seen.failed++;
    }
    // The reconnect probe ends most outages within the second, so most calls really call the store.
    expect(seen.ok + seen.timeout + seen.failed).toBeGreaterThanOrEqual(100);
    for (const n of [seen.ok, seen.timeout, seen.failed]) expect(n).toBeGreaterThan(10);
  });

  it('health: invalid timeoutMs rejects with InvalidOptionError', async () => {
    const w = world();
    for (const timeoutMs of [0, -1, 1.5, '2s']) {
      await expect(w.q.health({ timeoutMs: timeoutMs as number })).rejects.toBeInstanceOf(InvalidOptionError);
    }
  });

  it('health: the report after an internal failure still shows the store as durable', async () => {
    useFakeTime();
    const host = {
      client: { capabilities: { durable: true }, call: () => Promise.resolve(1), __formatSupport: { current: 1, minReadable: 1, maxReadable: 2 } } as unknown as StoreClient,
      state: () => 'connected' as const,
      workers: (): never => {
        throw new TypeError('bug');
      },
      isPaused: () => false,
      isClosing: () => false,
      format: () => ({ storeFormat: 1, supported: { min: 1, max: 1 }, degraded: false }),
      scheduler: () => undefined,
      noSchedulerRunning: () => false,
      alerts: () => [],
      deadLetters: () => undefined,
      sweeper: () => undefined,
    };
    const r = await buildHealth(host, { timeoutMs: 100 });
    expect(r).toMatchObject({ live: true, ready: false, store: { ok: false, error: 'unknown', state: 'connected', durable: true } });
    expect(r.format).toEqual({ storeFormat: null, supported: { min: 1, max: 2 }, degraded: false });
  });
});

describe('isRunning and ready', () => {
  it('running: isRunning true only in state running and unaffected by pause', async () => {
    const w = world();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    await w.q.add(1);
    const worker = w.q.process(() => gate, { ...steady, autorun: false });
    expect([worker.state, worker.isRunning()]).toEqual(['created', false]);
    await worker.run();
    await vi.advanceTimersByTimeAsync(0);
    expect([worker.state, worker.isRunning()]).toEqual(['running', true]);
    await worker.pause();
    expect(worker.isRunning()).toBe(true);
    const closed = worker.close();
    expect([worker.state, worker.isRunning()]).toEqual(['stopping', false]);
    finish();
    await closed;
    expect([worker.state, worker.isRunning()]).toEqual(['stopped', false]);
  });

  it('ready: health is ready on a fresh queue without ready()', async () => {
    const w = world();
    expect((await w.q.health()).ready).toBe(true);
  });

  it('health: a store that cannot open gives a not-ready report within the health timeout', async () => {
    const w = world({ wrap: (inner) => spyStore(inner, { open: () => Promise.reject(new Error('down')) }).store });
    let report: HealthReport | undefined;
    void w.q.health({ timeoutMs: 500 }).then((r) => (report = r));
    await vi.advanceTimersByTimeAsync(499);
    expect(report).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(report).toMatchObject({ ready: false, live: true, store: { ok: false, state: 'reconnecting' } });
  });

  it('ready: rejects with StoreNotReadyError after the default timeout', async () => {
    const w = world({ wrap: (inner) => spyStore(inner, { open: () => Promise.reject(new Error('down')) }).store });
    let outcome: unknown = 'pending';
    void w.q.ready().catch((e: unknown) => (outcome = e));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(StoreNotReadyError);
    expect((outcome as StoreNotReadyError).code).toBe('STORE_NOT_READY');
    expect((outcome as StoreNotReadyError).cause).toBeDefined();
  });

  it('ready: retries with backoff while the store is down', async () => {
    useFakeTime();
    const inner = new MemoryStore({ clock: () => Date.now() });
    let opens = 0;
    const store = spyStore(inner, { open: () => (++opens <= 2 ? Promise.reject(new Error('down')) : inner.open()) }).store;
    // The default schedule (100 ms doubling) without the jitter.
    clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 30_000, factor: 2, jitter: 0.2, random: () => 0.5 });
    const q = new Queue('r', { store, logger: silent });
    queues.push(q);
    let done = false;
    void q.ready().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(299); // tries at 0 and 100 ms fail
    expect([done, opens]).toEqual([false, 2]);
    await vi.advanceTimersByTimeAsync(1); // the third, at 300 ms, works
    expect([done, opens]).toEqual([true, 3]);
  });

  it('ready: add before ready follows onDisconnected (default reject)', async () => {
    useFakeTime();
    const inner = new MemoryStore({ clock: () => Date.now() });
    const store = spyStore(inner, { open: () => Promise.reject(new Error('down')) }).store;
    clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
    const q = new Queue('r', { store, logger: silent });
    queues.push(q);
    const err = await q.add(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as StoreUnavailableError).outcomeUnknown).toBe(false);

    const inner2 = new MemoryStore({ clock: () => Date.now() });
    let up2 = false;
    const store2 = spyStore(inner2, { open: () => (up2 ? inner2.open() : Promise.reject(new Error('down'))) }).store;
    clientFor(store2).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
    const waiting = new Queue('r', { store: store2, logger: silent, onDisconnected: 'wait' });
    queues.push(waiting);
    let added = false;
    const add = waiting.add(1).then((r) => ((added = true), r));
    await vi.advanceTimersByTimeAsync(250);
    expect(added).toBe(false);
    up2 = true;
    const ready = waiting.ready();
    await vi.advanceTimersByTimeAsync(100);
    await ready;
    expect((await add).added).toBe(true);
  });
});
