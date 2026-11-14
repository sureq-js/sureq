import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreFormatError } from '../../src/errors/catalog.js';
import { FORMAT_SUPPORT, SUREQ_VERSION, findSkew, isAdjacent } from '../../src/format/support.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { freezable, live } from '../helpers/pods.js';
import { Producer } from '../../src/producer.js';
import { clientFor } from '../../src/store/client.js';
import { K1, NEW, OLD, podOn } from '../helpers/releases.js';
import { spyStore } from '../helpers/spy-store.js';

const opened = async () => {
  const store = new MemoryStore({ clock: () => 1_000_000 });
  await store.open();
  return store;
};
const rejection = (p: Promise<unknown>): Promise<StoreFormatError> => p.then(
  () => { throw new TypeError('expected a rejection'); },
  (e: unknown) => e as StoreFormatError,
);
const queues: Queue[] = [];
const track = (q: Queue): Queue => (queues.push(q), q);

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

describe('format start-up check', () => {
  it('format: pod refuses to start against a newer store with StoreFormatError and starts nothing', async () => {
    const store = await opened();
    await track(podOn(store, K1)).ready();
    const { store: spied, calls } = spyStore(store);
    const old = track(podOn(spied, OLD));
    const e = await rejection(old.ready());
    expect(e).toBeInstanceOf(StoreFormatError);
    expect(e).toMatchObject({
      reason: 'too-new', found: 2, supported: 1, storeFormat: 2, minReadable: 1, maxReadable: 1, sureqVersion: '0.3.0', recordKind: 'meta',
    });
    expect(e.message).toContain('2');
    expect(e.message).toContain('1');
    expect(e.message).toContain('upgrade');
    const seen = calls.length;
    expect(await rejection(old.ready())).toBe(e);
    expect(calls.length).toBe(seen);
  });

  it('format: pod refuses an older-than-minReadable store with StoreFormatError', async () => {
    const store = await opened();
    await track(podOn(store, OLD)).ready();
    const e = await rejection(track(podOn(store, NEW)).ready());
    expect(e).toMatchObject({ reason: 'too-old', found: 1, storeFormat: 1, minReadable: 3, maxReadable: 3, sureqVersion: '0.7.0' });
    expect(e.message).toContain('upgrade');
  });

  it('format: refusing pod writes no job, meta or worker record', async () => {
    useFakeTime();
    const store = await opened();
    await track(podOn(store, K1)).ready();
    const before = store.dump();
    const spy = spyStore(store);
    const old = track(podOn(spy.store, OLD));
    const errors = vi.fn();
    old.on('error', errors);
    await rejection(old.ready());
    await rejection(old.add({ n: 1 }));
    const worker = old.process(async () => 'x', live);
    worker.on('error', () => {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.dump()).toEqual(before);
    // the worker and the scheduler start, but the client refuses their calls before the store: the only store
    // calls are the open, the one format check and the store clock
    expect([...new Set(spy.calls.map((c) => c.op))].sort()).toEqual(['ensureNamespaceMeta', 'now', 'open']);
    // one refusal, one error: the worker reports it, the scheduler stops quietly and stays stopped
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]![0]).toMatchObject({ source: 'store', context: { operation: 'claim' }, error: { recordKind: 'meta' } });
    old.process(async () => 'x', live).on('error', () => {});
    old.startScheduler();
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors.mock.calls.filter(([e]) => (e as { context: { operation?: string } }).context.operation === 'listDueSchedules')).toEqual([]);
  });

  it('format: add and process reject with the same error as ready', async () => {
    const store = await opened();
    await track(podOn(store, K1)).ready();
    const old = track(podOn(store, OLD));
    const fromReady = await rejection(old.ready());
    const fromAdd = await rejection(old.add({ n: 1 }));
    expect([fromAdd.code, fromAdd.reason, fromAdd.found]).toEqual([fromReady.code, fromReady.reason, fromReady.found]);
    const handler = vi.fn();
    const worker = old.process(handler);
    const errors: unknown[] = [];
    worker.on('error', (e) => void errors.push(e.error));
    await vi.waitFor(() => expect(worker.state).toBe('stopped'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: fromReady.code, reason: 'too-new', found: 2, recordKind: 'meta' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('format: getJob of an unreadable record throws StoreFormatError with recordId', async () => {
    const store = await opened();
    const k1 = track(podOn(store, K1));
    const { job } = await k1.add({ n: 1 });
    expect(store.dump().jobs[0]!.formatVersion).toBe(2);
    expect(await rejection(track(podOn(store, OLD)).getJob(job.id))).toMatchObject({ reason: 'too-new', recordKind: 'meta' });

    const fresh = await opened();
    const old = track(podOn(fresh, OLD));
    const { job: planted } = await old.add({ n: 1 });
    fresh.unsafeMutate(old.internals.scope, planted.id, { formatVersion: 2 });
    expect(await rejection(old.getJob(planted.id))).toMatchObject({ reason: 'too-new', recordKind: 'job', recordId: planted.id, found: 2 });
  });

  it('format: patch versions never change format', () => {
    for (const [a, b] of [['0.3.0', '0.3.9'], ['0.3.1', '0.4.0'], ['1.2.0', '1.1.5']]) expect(isAdjacent(a!, b!), `${a} ${b}`).toBe(true);
    for (const [a, b] of [['0.3.0', '0.5.0'], ['1.0.0', '2.0.0']]) expect(isAdjacent(a!, b!), `${a} ${b}`).toBe(false);
    const workers = [
      { workerId: 'a', sureqVersion: '0.3.7' }, { workerId: 'b', sureqVersion: '0.5.0' }, { workerId: 'c', sureqVersion: '0.2.1' },
      { workerId: 'd', sureqVersion: '1.3.1' },
    ];
    expect(findSkew('0.3.1', workers).map((w) => w.workerId)).toEqual(['b', 'd']);
    expect(FORMAT_SUPPORT).toEqual({ current: 1, minReadable: 1, maxReadable: 1 });
    expect(Object.isFrozen(FORMAT_SUPPORT)).toBe(true);
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SUREQ_VERSION).toBe(pkg.version);
  });

  it('format: a prerelease version counts as its major and minor release', () => {
    for (const [a, b] of [['1.0.0-rc.1', '1.0.0'], ['1.0.0-rc.1', '1.1.0'], ['1.0.0-rc.1', '1.0.0-rc.2'], ['0.9.0', '1.0.0-rc.1']]) {
      expect(isAdjacent(a!, b!), `${a} ${b}`).toBe(a!.startsWith('1') && b!.startsWith('1'));
    }
    const workers = [
      { workerId: 'same', sureqVersion: '1.0.0' }, { workerId: 'next', sureqVersion: '1.1.0-beta.0' }, { workerId: 'far', sureqVersion: '1.2.0' },
      { workerId: 'old', sureqVersion: '0.3.0' }, { workerId: 'garbage', sureqVersion: 'rc' },
    ];
    expect(findSkew('1.0.0-rc.1', workers).map((w) => w.workerId)).toEqual(['far', 'old', 'garbage']);
  });

  it('format: producer-only pod runs the same start-up check', async () => {
    const store = await opened();
    const producer = track(new Queue('fmt', { logger: silent, store }));
    await producer.add({ n: 1 });
    expect(store.dump().meta['default']).toMatchObject({ formatVersion: 1, createdBy: SUREQ_VERSION });

    const ahead = await opened();
    await track(podOn(ahead, K1)).ready();
    expect(await rejection(track(podOn(ahead, OLD)).add({ n: 1 }))).toMatchObject({ reason: 'too-new', recordKind: 'meta' });
    expect(ahead.dump().jobs).toEqual([]);

    // a Producer of the older release meets the same check through its store client
    const view = freezable(ahead);
    clientFor(view).__formatSupport = { ...OLD };
    const old = new Producer('fmt', { logger: silent, store: view });
    const fromProducer = await rejection(old.add({ n: 1 }));
    const fromQueue = await rejection(track(podOn(ahead, OLD)).add({ n: 1 }));
    expect(fromProducer).toBeInstanceOf(StoreFormatError);
    expect([fromProducer.reason, fromProducer.found, fromProducer.supported, fromProducer.recordKind]).toEqual([fromQueue.reason, fromQueue.found, fromQueue.supported, fromQueue.recordKind]);
    expect(ahead.dump().jobs).toEqual([]);
    await old.close();
  });

  it('format: store without meta is treated as format 1', async () => {
    const store = await opened();
    const scope = { namespace: 'default', queue: 'fmt' };
    await store.add(scope, [{ id: 'a', data: '{"n":1}', formatVersion: 1, maxAttempts: 1 }]);
    expect(store.dump().meta).toEqual({});
    const pod = track(new Queue('fmt', { logger: silent, store }));
    await pod.ready();
    expect(store.dump().meta['default']).toMatchObject({ formatVersion: 1 });
    expect((await pod.getJobs('waiting')).map((j) => j.id)).toEqual(['a']);
    expect(await rejection(track(podOn(store, NEW)).ready())).toMatchObject({ reason: 'too-old', found: 1 });
  });
});
