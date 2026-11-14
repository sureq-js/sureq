import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreRequestError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import { SUREQ_VERSION } from '../../src/format/support.js';
import { Queue } from '../../src/queue/queue.js';
import { SKEW_CHECK_MS } from '../../src/registry/skew.js';
import type { RegisterWorkerRequest } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { NEW, podOn } from '../helpers/releases.js';
import { spyStore } from '../helpers/spy-store.js';

const NS = { namespace: 'default' };
const [major, minor] = SUREQ_VERSION.split('.').map(Number) as [number, number];
const ADJACENT = `${major}.${minor + 1}.0`;
// the nearest release that is not adjacent
const FAR = `${major}.${minor + 2}.0`;
const queues: Queue[] = [];

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
  vi.useRealTimers();
});

/** A record that stays live for the whole test. */
const peer = (workerId: string, sureqVersion: string): RegisterWorkerRequest => ({
  workerId, queues: ['s'], concurrency: 1, sureqVersion, formatVersion: 1, heartbeatIntervalMs: 3_600_000, host: 'peer', pid: null, labels: {},
  scheduler: false,
});

async function world(over: Parameters<typeof spyStore>[1] = {}) {
  useFakeTime();
  const raw = new MemoryStore({ clock: () => Date.now() });
  await raw.open();
  const spy = spyStore(raw, over);
  const q = new Queue('s', { logger: silent, store: spy.store });
  queues.push(q);
  const skew = vi.fn();
  const errors: ErrorEvent[] = [];
  q.on('versionSkew', skew);
  q.on('error', (e) => void errors.push(e));
  return { raw, spy, q, skew, errors };
}

describe('format version skew', () => {
  it('format: versionSkew fires for non-adjacent live workers and never blocks', async () => {
    const w = await world();
    await w.raw.registerWorker(NS, peer('far', FAR));
    await w.raw.registerWorker(NS, peer('near', ADJACENT));
    const done = vi.fn();
    w.q.on('completed', done);
    w.q.process(async () => 'ok', poll(50));
    await w.q.add({});
    await vi.advanceTimersByTimeAsync(SKEW_CHECK_MS);
    expect(w.skew).toHaveBeenCalledTimes(1);
    expect(w.skew).toHaveBeenCalledWith({ workers: [{ workerId: 'far', sureqVersion: FAR }] });
    expect(done).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SKEW_CHECK_MS);
    expect(w.skew).toHaveBeenCalledTimes(1);
    await w.q.add({});
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledTimes(2);
    expect(w.errors).toEqual([]);
  });

  it('format: an adjacent release raises no versionSkew', async () => {
    const w = await world();
    await w.raw.registerWorker(NS, peer('near', ADJACENT));
    w.q.process(async () => 'ok', poll(50));
    await vi.advanceTimersByTimeAsync(2 * SKEW_CHECK_MS);
    expect(w.skew).not.toHaveBeenCalled();
  });

  it('format: a failing skew read is reported once and blocks nothing', async () => {
    const w = await world({ listWorkers: () => Promise.reject(new StoreRequestError('boom', { operation: 'listWorkers' })) });
    const done = vi.fn();
    w.q.on('completed', done);
    w.q.process(async () => 'ok', poll(50));
    await vi.advanceTimersByTimeAsync(3 * SKEW_CHECK_MS);
    await w.q.add({});
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledTimes(1);
    expect(w.errors.filter((e) => e.context.operation === 'listWorkers')).toHaveLength(1);
  });

  it('format: a pod refused at start-up writes no worker record, evaluates no alert and raises no skew or degraded', async () => {
    useFakeTime();
    const raw = new MemoryStore({ clock: () => Date.now() });
    await raw.open();
    await raw.ensureNamespaceMeta(NS, { current: 1, minReadable: 1, maxReadable: 1, sureqVersion: SUREQ_VERSION });
    await raw.registerWorker(NS, { ...peer('far', FAR), queues: ['fmt'] });
    const spy = spyStore(raw);
    const refused = podOn(spy.store, NEW, { alerts: { depth: { above: 1 }, interval: '1s' } });
    queues.push(refused);
    const events = { skew: vi.fn(), degraded: vi.fn(), error: vi.fn(), alert: vi.fn() };
    refused.on('alert', events.alert);
    refused.on('versionSkew', events.skew);
    refused.on('degraded', events.degraded);
    refused.on('error', events.error);
    refused.process(async () => 'ok', poll(50));
    await vi.advanceTimersByTimeAsync(3 * SKEW_CHECK_MS);
    expect(spy.calls.filter((c) => ['registerWorker', 'heartbeatWorker', 'unregisterWorker', 'listWorkers', 'purgeWorkers', 'stats'].includes(c.op))).toEqual([]);
    expect(events.alert).not.toHaveBeenCalled();
    expect((await raw.listWorkers(NS, {})).workers.map((r) => r.workerId)).toEqual(['far']);
    expect(events.skew).not.toHaveBeenCalled();
    expect(events.degraded).not.toHaveBeenCalled();
    expect(events.error).toHaveBeenCalledTimes(1);
  });
});
