import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreFormatError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import { Queue } from '../../src/queue/queue.js';
import { FormatWatch } from '../../src/format/watch.js';
import type { StoreClient } from '../../src/store/client.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { live } from '../helpers/pods.js';
import { K1, OLD, podOn } from '../helpers/releases.js';
import { spyStore } from '../helpers/spy-store.js';

const RECHECK = 30_000;
const queues: Queue[] = [];
const track = <Q extends Queue>(q: Q): Q => (queues.push(q), q);

async function world() {
  useFakeTime();
  const store = new MemoryStore({ clock: () => Date.now() });
  await store.open();
  const spy = spyStore(store);
  const old = track(podOn(spy.store, OLD));
  const events = { degraded: vi.fn(), error: vi.fn() };
  old.on('degraded', events.degraded);
  old.on('error', events.error);
  const claims = () => spy.calls.filter((c) => c.op === 'claim').length;
  return { store, old, events, claims };
}

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
  vi.useRealTimers();
});

describe('format degraded mode', () => {
  it('format: running pod enters degraded mode when meta moves past maxReadable and recovers when readable', async () => {
    const w = await world();
    w.old.process(async () => 'ok', live);
    await vi.advanceTimersByTimeAsync(100);
    await track(podOn(w.store, K1)).ready();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(w.events.degraded).toHaveBeenCalledTimes(1);
    expect((w.events.degraded.mock.calls[0]![0] as { error: StoreFormatError }).error.reason).toBe('too-new');
    const h = await w.old.health();
    expect(h.ready).toBe(false);
    expect(h.format).toEqual({ storeFormat: 2, supported: { min: 1, max: 1 }, degraded: true });
    expect(h.warnings.map((x) => x.code)).toContain('STORE_FORMAT_AHEAD');
    const before = w.claims();
    await vi.advanceTimersByTimeAsync(2 * RECHECK);
    expect(w.claims()).toBe(before);
    expect(w.events.error).not.toHaveBeenCalled();

    w.old.internals.client.__formatSupport.maxReadable = 2;
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(w.claims()).toBeGreaterThan(before);
    expect((await w.old.health()).format.degraded).toBe(false);
    expect(w.events.degraded).toHaveBeenCalledTimes(1);
    expect(w.events.error).not.toHaveBeenCalled();
  });

  it('format: degraded pod stops claiming but finishes active jobs', async () => {
    const w = await world();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const ran: string[] = [];
    w.old.process(async (job) => {
      ran.push(job.id);
      await gate;
      return 'done';
    }, { ...live, leaseDuration: '10s' });
    const { job } = await w.old.add({ n: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(ran).toEqual([job.id]);
    await track(podOn(w.store, K1)).ready();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(w.events.degraded).toHaveBeenCalledTimes(1);
    const scope = w.old.internals.scope;
    await w.store.add(scope, [{ id: 'later', data: '{}', formatVersion: 1, maxAttempts: 1 }]);
    await vi.advanceTimersByTimeAsync(RECHECK);
    open();
    await vi.advanceTimersByTimeAsync(100);
    expect(await w.store.get(scope, job.id)).toMatchObject({ state: 'completed', crashCount: 0 });
    expect((await w.store.get(scope, 'later'))!.state).toBe('waiting');
    expect(ran).toEqual([job.id]);
    expect(w.events.error).not.toHaveBeenCalled();
  });

  it('format: non-adjacent release is refused or degraded after meta is raised', async () => {
    const w = await world();
    w.old.process(async () => 'ok', live);
    await vi.advanceTimersByTimeAsync(100);
    await track(podOn(w.store, K1)).ready();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(w.events.degraded).toHaveBeenCalledTimes(1);
    await expect(track(podOn(w.store, OLD)).ready()).rejects.toMatchObject({ reason: 'too-new', recordKind: 'meta' });
  });

  it('format: a store error during a re-check is reported and the next check runs on schedule', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    await store.open();
    let fail = true;
    const spy = spyStore(store, {
      getNamespaceMeta: (ns) => (fail ? ((fail = false), Promise.reject(new Error('ECONNRESET'))) : store.getNamespaceMeta(ns)),
    });
    const old = track(podOn(spy.store, OLD));
    const errors: ErrorEvent[] = [];
    old.on('error', (e) => void errors.push(e));
    const degraded = vi.fn();
    old.on('degraded', degraded);
    old.process(async () => 'ok', live);
    await vi.advanceTimersByTimeAsync(100);
    await track(podOn(store, K1)).ready();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(errors).toMatchObject([{ source: 'store', context: { operation: 'getNamespaceMeta' } }]);
    expect(degraded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(degraded).toHaveBeenCalledTimes(1);
  });

  it('format: stop and start during a re-check keep one check per interval', async () => {
    useFakeTime();
    let answer!: () => void;
    const call = vi.fn(() => new Promise<null>((r) => (answer = () => r(null))));
    const client = { call, formatOf: () => null } as unknown as StoreClient;
    const watch = new FormatWatch({
      client, namespace: 'n', support: { current: 1, minReadable: 1, maxReadable: 1, sureqVersion: '0.3.0' },
      report: () => {}, emitDegraded: () => {}, logger: silent,
    });
    watch.start();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(call).toHaveBeenCalledTimes(1);
    watch.stop();
    watch.start();
    answer();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(call).toHaveBeenCalledTimes(2);
    answer();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(call).toHaveBeenCalledTimes(3);
    watch.stop();
    answer();
    await vi.advanceTimersByTimeAsync(2 * RECHECK);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('format: failed re-checks are reported once per outage and none run while the store is reconnecting', async () => {
    useFakeTime();
    let failing = true;
    const call = vi.fn(() => (failing ? Promise.reject(new Error('ECONNRESET')) : Promise.resolve(null)));
    const client = { call, formatOf: () => null, state: 'connected' } as { call: typeof call; formatOf: () => null; state: string };
    const report = vi.fn();
    const watch = new FormatWatch({
      client: client as unknown as StoreClient, namespace: 'n', support: { current: 1, minReadable: 1, maxReadable: 1, sureqVersion: '0.3.0' },
      report, emitDegraded: () => {}, logger: silent,
    });
    watch.start();
    await vi.advanceTimersByTimeAsync(3 * RECHECK);
    expect([call.mock.calls.length, report.mock.calls.length]).toEqual([3, 1]);
    failing = false;
    await vi.advanceTimersByTimeAsync(RECHECK);
    failing = true;
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(report).toHaveBeenCalledTimes(2);
    // the client already probes an unreachable store: the watch waits for it
    client.state = 'reconnecting';
    await vi.advanceTimersByTimeAsync(2 * RECHECK);
    expect([call.mock.calls.length, report.mock.calls.length]).toEqual([5, 2]);
    watch.stop();
  });

  it('format: a pod that passed the check before a raise never claims newer jobs before its next re-check', async () => {
    const w = await world();
    const handled: string[] = [];
    w.old.process(async (job) => void handled.push(job.id), live);
    await vi.advanceTimersByTimeAsync(100);
    const k1 = track(podOn(w.store, K1));
    await k1.ready();
    const ids = (await k1.addBulk(Array.from({ length: 10 }, (_, i) => ({ data: { i } })))).map((o) => (o.ok ? o.job.id : ''));
    await vi.advanceTimersByTimeAsync(RECHECK - 1000);
    expect(w.events.degraded).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
    for (const id of ids) expect((await w.store.get(w.old.internals.scope, id))!).toMatchObject({ state: 'waiting', formatVersion: 2, attempt: 0 });
    expect(w.events.error).not.toHaveBeenCalled();
  });

  it('health: format reports storeFormat, the supported range and degraded', async () => {
    const store = new MemoryStore();
    const q = track(new Queue('h', { store, logger: silent }));
    // health() opens a fresh queue's store, so the format is read on the first report
    const h = await q.health();
    expect(h.format).toEqual({ storeFormat: 1, supported: { min: 1, max: 1 }, degraded: false });
    expect(h.ready).toBe(true);
  });
});

describe('format and batch workers', () => {
  const batched = { ...live, batchSize: 2, batchDelay: 0 };

  it('format: a degraded batch worker claims nothing new and finishes its running batch', async () => {
    const w = await world();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const ran: string[][] = [];
    // a free batch slot: only degraded mode keeps the worker from claiming the next job
    w.old.processBatch(async (batch) => {
      ran.push(batch.jobs.map((j) => j.id));
      await gate;
    }, { ...batched, concurrency: 2, leaseDuration: '10s' });
    const { job } = await w.old.add({ n: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(ran).toEqual([[job.id]]);
    await track(podOn(w.store, K1)).ready();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(w.events.degraded).toHaveBeenCalledTimes(1);
    const before = w.claims();
    const scope = w.old.internals.scope;
    await w.store.add(scope, [{ id: 'later', data: '{}', formatVersion: 1, maxAttempts: 1 }]);
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(w.claims()).toBe(before);
    open();
    await vi.advanceTimersByTimeAsync(100);
    expect(await w.store.get(scope, job.id)).toMatchObject({ state: 'completed', crashCount: 0 });
    expect((await w.store.get(scope, 'later'))!.state).toBe('waiting');
    expect(ran).toEqual([[job.id]]);
    expect(w.events.error).not.toHaveBeenCalled();
  });

  it('format: a refused pod starts a batch worker that never claims', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    await store.open();
    await track(podOn(store, K1)).ready();
    const spy = spyStore(store);
    const old = track(podOn(spy.store, OLD));
    const handler = vi.fn();
    const worker = old.processBatch(handler, batched);
    const errors: unknown[] = [];
    worker.on('error', (e) => void errors.push(e.error));
    await vi.advanceTimersByTimeAsync(2000);
    expect(worker.state).toBe('stopped');
    expect(errors).toMatchObject([{ reason: 'too-new', recordKind: 'meta' }]);
    expect(spy.calls.filter((c) => c.op === 'claim')).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('format and the scheduler', () => {
  const every = { every: '1s', template: { data: { n: 1 } }, overlap: 'allow' as const };
  const firedOf = (store: MemoryStore) => store.dump().jobs.filter((j) => j.scheduleKey === 'k');

  it('format: a degraded pod fires no schedule until the format is readable again', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    await store.open();
    const old = track(podOn(store, OLD, { scheduler: { tickMs: 100 } }));
    const degraded = vi.fn();
    old.on('degraded', degraded);
    await old.upsertSchedule('k', every);
    // a pod with only a scheduler, no worker: it must still notice the raise
    old.startScheduler();
    await vi.advanceTimersByTimeAsync(3000);
    expect(firedOf(store).length).toBeGreaterThan(0);
    expect(firedOf(store).every((j) => j.formatVersion === 1)).toBe(true);
    await track(podOn(store, K1)).ready();
    await vi.advanceTimersByTimeAsync(RECHECK);
    expect(degraded).toHaveBeenCalledTimes(1);
    const before = firedOf(store).length;
    await vi.advanceTimersByTimeAsync(2 * RECHECK);
    expect(firedOf(store)).toHaveLength(before);
    expect((await old.health()).warnings.map((x) => x.code)).not.toContain('SCHEDULER_STALE');

    old.internals.client.__formatSupport.maxReadable = 2;
    await vi.advanceTimersByTimeAsync(RECHECK + 2000);
    expect(firedOf(store).length).toBeGreaterThan(before);
  });

  it('format: a refused pod reports its scheduler once and fires nothing', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    await store.open();
    const k1 = track(podOn(store, K1));
    await k1.upsertSchedule('k', every);
    const spy = spyStore(store);
    const old = track(podOn(spy.store, OLD, { scheduler: { tickMs: 100 } }));
    const errors: ErrorEvent[] = [];
    old.on('error', (e) => void errors.push(e));
    const degraded = vi.fn();
    old.on('degraded', degraded);
    old.startScheduler();
    await vi.advanceTimersByTimeAsync(5000);
    expect(errors).toMatchObject([{ source: 'store', context: { operation: 'listDueSchedules' }, error: { reason: 'too-new', recordKind: 'meta' } }]);
    expect(firedOf(store)).toEqual([]);
    // past the re-check interval: the format watch stopped with the scheduler
    await vi.advanceTimersByTimeAsync(2 * RECHECK);
    expect(degraded).not.toHaveBeenCalled();
    expect(spy.calls.filter((c) => c.op === 'getNamespaceMeta')).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('format: a refused scheduler reports when no worker of the pod is running', async () => {
    for (const idle of ['never run', 'closed'] as const) {
      useFakeTime();
      const store = new MemoryStore({ clock: () => Date.now() });
      await store.open();
      await track(podOn(store, K1)).upsertSchedule('k', every);
      const old = track(podOn(store, OLD, { scheduler: { tickMs: 100 } }));
      const errors: ErrorEvent[] = [];
      old.on('error', (e) => void errors.push(e));
      const worker = old.process(async () => 'x', { ...live, autorun: false });
      if (idle === 'closed') await worker.close();
      old.startScheduler();
      await vi.advanceTimersByTimeAsync(2000);
      expect(errors.filter((e) => e.context.operation === 'listDueSchedules'), idle).toHaveLength(1);
      expect(firedOf(store), idle).toEqual([]);
      vi.useRealTimers();
    }
  });

  it('format: a refused pod with alerts and a scheduler but no running worker reports the refusal once', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    await store.open();
    await track(podOn(store, K1)).upsertSchedule('k', every);
    const old = track(podOn(store, OLD, { scheduler: { tickMs: 100 }, alerts: { depth: { above: 1 }, interval: '1s' } }));
    const errors: ErrorEvent[] = [];
    old.on('error', (e) => void errors.push(e));
    old.startScheduler();
    await vi.advanceTimersByTimeAsync(5000);
    expect(errors.filter((e) => (e.error as StoreFormatError).recordKind === 'meta')).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(firedOf(store)).toEqual([]);
  });

  it('format: a refused pod whose only worker is paused reports the refusal once', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    await store.open();
    await track(podOn(store, K1)).upsertSchedule('k', every);
    const old = track(podOn(store, OLD, { scheduler: { enabled: false, tickMs: 100 } }));
    const errors: ErrorEvent[] = [];
    old.on('error', (e) => void errors.push(e));
    // a paused worker claims nothing, so it never meets the refusal its queue's scheduler meets.
    // A paused loop wakes every pollMax, so a 1 min poll keeps the 2 h jump below to ~120 turns (not ~144k at 50 ms).
    const w = old.process(async () => 'ok', { ...live, ...poll(60_000), sweepInterval: '1h', autorun: false });
    await w.pause();
    void w.run();
    old.startScheduler();
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.state).toBe('running');
    expect(errors.filter((e) => (e.error as StoreFormatError).recordKind === 'meta')).toHaveLength(1);
    // its sweeper meets the same refusal later: still one report
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(errors).toHaveLength(1);
    expect(firedOf(store)).toEqual([]);
  });

  it('format: a fired job is stamped with the firing pod format and gets an attempt record when claimed', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    await store.open();
    const k1 = track(podOn(store, K1, { scheduler: { tickMs: 100 } }));
    await k1.upsertSchedule('k', every);
    const ran: string[] = [];
    k1.process(async (job) => void ran.push(job.id), live);
    await vi.advanceTimersByTimeAsync(1500);
    const [first] = firedOf(store);
    expect(first).toMatchObject({ formatVersion: 2, state: 'completed' });
    expect(ran).toContain(first!.id);
    expect((await k1.getAttempts(first!.id)).attempts).toMatchObject([{ token: 1, outcome: 'completed' }]);
  });
});
