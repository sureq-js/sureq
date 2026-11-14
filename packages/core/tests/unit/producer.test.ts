import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, QueueClosedError, StoreFormatError, StoreUnavailableError, UnrecoverableError } from '../../src/errors/catalog.js';
import { Producer } from '../../src/producer.js';
import { Queue } from '../../src/queue/queue.js';
import { clientFor } from '../../src/store/client.js';
import type { AddOutcome, NewJob, Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { next, silent } from '../helpers/harness.js';
import { outageStore } from '../helpers/outage.js';
import { live } from '../helpers/pods.js';
import { spyStore } from '../helpers/spy-store.js';
import { PRODUCER_MEMBERS } from '../public-names.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const open: Array<{ close(o?: { timeoutMs?: number }): Promise<void> }> = [];
const track = <T extends { close(o?: { timeoutMs?: number }): Promise<void> }>(x: T): T => (open.push(x), x);

afterEach(async () => {
  await Promise.all(open.splice(0).map((x) => x.close({ timeoutMs: 100 })));
  vi.useRealTimers();
});

function clocked() {
  const clock = { t: T0 };
  const store = new MemoryStore({ clock: () => clock.t });
  return { clock, store };
}
const producer = (store: Store, opts: Record<string, unknown> = {}) => track(new Producer('q', { store, logger: silent, ...opts }));
const worker = (store: Store, opts: Record<string, unknown> = {}) => track(new Queue('q', { store, logger: silent, ...opts }));
const steady = (store: Store) => clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
const WORKER_OPS = ['claim', 'renew', 'sweep', 'registerWorker', 'heartbeatWorker', 'listDueSchedules', 'fireSchedule', 'subscribe', 'purgeWorkers'];

describe('producer', () => {
  it('producer: upsertSchedule, listSchedules, pause, resume, delete and nextRuns work without a worker and fire nothing', async () => {
    useFakeTime();
    const { clock, store } = clocked();
    const p = producer(store);
    expect(await p.upsertSchedule('s', { every: '1m', template: { data: 1 } })).toMatchObject({ action: 'created' });
    expect(vi.getTimerCount()).toBe(0);
    expect((await p.listSchedules()).schedules.map((s) => s.key)).toEqual(['s']);
    expect((await p.pauseSchedule('s')).paused).toBe(true);
    expect((await p.resumeSchedule('s')).paused).toBe(false);
    const runs = await p.nextRuns('s', 3);
    expect(runs).toHaveLength(3);
    expect([runs[1]! - runs[0]!, runs[2]! - runs[1]!]).toEqual([MIN, MIN]);
    clock.t += 10 * MIN;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect((await p.getCounts()).waiting).toBe(0);
    expect(await p.deleteSchedule('s')).toBe(true);
    expect(await p.getSchedule('s')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('producer: no timers or intervals are running after ready', async () => {
    useFakeTime();
    const { store } = clocked();
    const p = new Producer('q', { store, logger: silent });
    await p.ready();
    expect(vi.getTimerCount()).toBe(0);
    await p.add(1);
    await p.addBulk([{ data: 2 }, { data: 3 }]);
    await p.getJobs('waiting');
    await p.metrics();
    await p.health();
    expect(vi.getTimerCount()).toBe(0);
    await p.close();
    expect(vi.getTimerCount()).toBe(0);

    // a call that waited through one reconnect leaves nothing behind either
    const { store: flaky, ctl } = outageStore(new MemoryStore());
    steady(flaky);
    const w = producer(flaky, { onDisconnected: 'wait' });
    await w.ready();
    ctl.down = true;
    await w.getCounts().catch(() => {});
    const pending = w.add(1);
    await vi.advanceTimersByTimeAsync(50);
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).added).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('producer: add resolves only after the store persisted the job', async () => {
    const inner = new MemoryStore();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { store } = spyStore(inner, {
      add: async (s: Scope, jobs: NewJob[], o?: { atomic?: boolean }): Promise<AddOutcome[]> => {
        await gate;
        return inner.add(s, jobs, o);
      },
    });
    const p = producer(store);
    let stored: boolean | undefined;
    const added = p.add({ n: 1 }).then((r) => (stored = inner.dump().jobs.some((j) => j.id === r.job.id)));
    await new Promise((r) => setTimeout(r, 20));
    expect(stored).toBeUndefined();
    release();
    await added;
    expect(stored).toBe(true);
  });

  it('producer: add during a store outage rejects or waits and buffers nothing in memory', async () => {
    useFakeTime();
    const inner = new MemoryStore();
    const { store, ctl } = outageStore(inner);
    steady(store);
    const r = producer(store);
    await r.ready();
    ctl.down = true;
    await r.getCounts().catch(() => {});
    await expect(r.add(1)).rejects.toSatisfy((e: unknown) => e instanceof StoreUnavailableError && !e.outcomeUnknown);
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(inner.dump().jobs).toEqual([]);

    const w = producer(store, { onDisconnected: 'wait', maxBufferedAdds: 1 });
    ctl.down = true;
    await w.getCounts().catch(() => {});
    let done = false;
    const held = w.add('held').then((x) => ((done = true), x));
    await vi.advanceTimersByTimeAsync(0);
    await expect(w.add('second')).rejects.toBeInstanceOf(StoreUnavailableError);
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(false);
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(200);
    const { job } = await held;
    expect(inner.dump().jobs.map((j) => j.id)).toEqual([job.id]);
  });

  it('producer: a job added by a producer is claimed and run by a worker pod', async () => {
    const store = new MemoryStore();
    const p = producer(store);
    const q = worker(store);
    const completed = next<{ job: { id: string; result: unknown } }>(q, 'completed');
    const { job } = await p.add({ n: 2 });
    q.process(async (j) => (j.data as { n: number }).n * 2, live);
    expect(await completed).toMatchObject({ job: { id: job.id, result: 4 } });
  });

  it('producer: add behaves identically to Queue.add for duplicates, validation and addBulk outcomes', async () => {
    const script = async (c: Producer | Queue) => {
      const out: unknown[] = [];
      const settle = async (f: () => Promise<unknown>) => {
        try {
          const r = await f();
          out.push(JSON.parse(JSON.stringify(r, function (this: Record<string, unknown>, k: string, v: unknown) {
            const raw = this[k];
            if (raw instanceof Error) return { error: raw.constructor.name, code: (raw as { code?: string }).code };
            return k === 'id' ? undefined : v;
          })));
        } catch (e) {
          out.push({ error: (e as Error).constructor.name, code: (e as { code?: string }).code });
        }
      };
      await settle(() => c.add(1, { id: 'a' }));
      await settle(() => c.add(2, { id: 'a' }));
      await settle(() => c.add(3, { id: 'a', onDuplicate: 'replace' }));
      await settle(() => c.add(4, { id: 'a', onDuplicate: 'reject' }));
      await settle(() => c.add(5, { singletonKey: 'k', id: 'b' }));
      await settle(() => c.add(6, { singletonKey: 'k', id: 'c' }));
      await settle(() => c.add('x'.repeat(200), { id: 'd' }));
      await settle(() => c.add(7, { priority: 'high' as never }));
      await settle(() => c.addBulk([{ data: 8, opts: { id: 'e' } }, { data: 9, opts: { id: 'a' } }, { data: 10, opts: { maxAttempts: 0 } }]));
      await settle(() => c.addBulk([{ data: 11 }], { atomic: true }));
      return out;
    };
    // a store without transactions, so an atomic addBulk is refused the same way on both
    const fresh = () => {
      const { store } = clocked();
      const plain = spyStore(store).store;
      Object.defineProperty(plain, 'capabilities', { value: Object.freeze({ ...store.capabilities, transactions: false }) });
      return plain;
    };
    const fromProducer = await script(producer(fresh(), { maxPayloadBytes: 100 }));
    const fromQueue = await script(worker(fresh(), { maxPayloadBytes: 100 }));
    expect(fromProducer).toEqual(fromQueue);
    expect(fromProducer.filter((o) => (o as { error?: string }).error).length).toBeGreaterThanOrEqual(3);
  });

  it('producer: is never listed in getWorkers and holds no lease', async () => {
    const inner = new MemoryStore();
    const spy = spyStore(inner);
    const p = producer(spy.store);
    const q = worker(inner);
    const w = q.process(async () => 'ok', live);
    await p.add(1);
    await vi.waitFor(async () => expect((await p.getWorkers()).map((x) => x.workerId)).toEqual([w.id]));
    expect(inner.dump().jobs.every((j) => j.lease === null || j.lease?.owner === w.id)).toBe(true);
    expect(spy.calls.filter((c) => WORKER_OPS.includes(c.op))).toEqual([]);
  });

  it('producer: ready rejects with StoreFormatError on a newer store and writes nothing', async () => {
    const store = new MemoryStore();
    await store.open();
    await store.ensureNamespaceMeta({ namespace: 'default' }, { current: 99, minReadable: 99, maxReadable: 99, sureqVersion: '9.0.0' });
    const before = store.dump();
    const p = producer(store);
    await expect(p.ready()).rejects.toSatisfy((e: unknown) => e instanceof StoreFormatError && e.reason === 'too-new');
    await expect(p.add(1)).rejects.toBeInstanceOf(StoreFormatError);
    expect(store.dump()).toEqual(before);
  });

  it('producer: getJob, getJobs, getCounts and getDeadLetters read what workers wrote', async () => {
    const store = new MemoryStore();
    const q = worker(store);
    const p = producer(store);
    const ok = (await q.add('ok')).job.id;
    const bad = (await q.add('bad', { maxAttempts: 1 })).job.id;
    const dead = next(q, 'deadLettered');
    const finished = next(q, 'completed');
    q.process(async (j) => {
      if (j.data === 'bad') throw new UnrecoverableError('no');
      return 'done';
    }, live);
    await Promise.all([dead, finished]);
    expect((await p.getJob(ok))).toMatchObject({ id: ok, state: 'completed', result: 'done' });
    expect((await p.getJobs('completed')).map((j) => j.id)).toEqual([ok]);
    expect(await p.getCounts()).toEqual(await q.getCounts());
    expect((await p.getDeadLetters()).jobs.map((j) => j.id)).toEqual([bad]);
    expect(await p.countDeadLetters()).toBe(1);
  });

  it('producer: cancel, remove, retry, redrive and pause work without a worker', async () => {
    const store = new MemoryStore();
    const p = producer(store);
    const waiting = (await p.add(1)).job;
    expect(await p.cancel(waiting.id)).toMatchObject({ cancelled: true, previousState: 'waiting' });
    const delayed = (await p.add(2, { delay: '1h' })).job;
    expect(await p.remove(delayed.id)).toBe(true);
    // two dead letters, written straight through the store
    const scope = { namespace: 'default', queue: 'q' };
    const ids = (await p.addBulk([{ data: 3, opts: { maxAttempts: 1 } }, { data: 4, opts: { maxAttempts: 1 } }])).map((r) => (r.ok ? r.job.id : ''));
    const { jobs } = await store.claim(scope, { workerId: 'w', limit: 2, leaseMs: 60_000, claimId: 'c' });
    for (const j of jobs) await store.fail(scope, { id: j.id, token: j.token, error: '{"v":1,"name":"E","message":"boom"}', deadLetter: {} });
    expect(await (await p.getJob(ids[0]!))!.retry()).toMatchObject({ status: 'redriven' });
    expect(await p.redrive(ids[1]!)).toMatchObject({ status: 'redriven' });
    expect((await p.getCounts()).waiting).toBe(2);
    expect(await p.pause()).toEqual({ changed: true });
    expect(p.isPaused()).toBe(true);
    expect(await p.pauseState()).toEqual({ paused: true });
    expect(await p.resume()).toEqual({ changed: true });
    expect(p.isPaused()).toBe(false);
  });

  it('producer: cancel applies the default cancelled policy, and add and addBulk carry a per-job keep', async () => {
    const { store: inner } = clocked();
    const { store, calls } = spyStore(inner);
    const p = producer(store);
    const plain = (await p.add(1)).job;
    const own = (await p.add(2, { keep: { cancelled: '1h' } })).job;
    const [bulk] = await p.addBulk([{ data: 3, opts: { keep: { cancelled: 0 } } }]);
    if (!bulk?.ok) throw new TypeError('expected an added job');
    for (const id of [plain.id, own.id, bulk.job.id]) await p.cancel(id);
    const sent = calls.filter((c) => c.op === 'cancel').map((c) => (c.args[1] as { retention?: unknown }).retention);
    expect(sent).toEqual([{ retainMs: 14 * 24 * 60 * MIN }, { retainMs: 60 * MIN }, { retainMs: 30_000 }]);
    const ownJob = (await p.getJob(own.id))!;
    expect(ownJob.retainUntil).toBe(ownJob.finishedAt! + 60 * MIN);
    expect((await p.getJob(bulk.job.id))!.retainUntil).toBe(T0 + 30_000);
  });

  it('producer: cancel sends no history, so the attempt records the workers keep are only closed', async () => {
    const { store: inner } = clocked();
    const { store, calls } = spyStore(inner);
    const q = worker(store, { history: { maxRecordsPerJob: 200 } });
    const p = producer(store);
    const { job } = await p.add(1);
    const scope = { namespace: 'default', queue: 'q' };
    await inner.claim(scope, { workerId: 'w', limit: 1, leaseMs: 60_000, claimId: 'c', history: { max: 200 } });
    expect(await p.cancel(job.id)).toMatchObject({ cancelled: true, previousState: 'active' });
    const sent = calls.filter((c) => c.op === 'cancel').map((c) => c.args[1] as Record<string, unknown>);
    expect(sent).toHaveLength(1);
    expect(Object.hasOwn(sent[0]!, 'history')).toBe(false);
    expect((await p.getAttempts(job.id)).attempts.map((a) => a.outcome)).toEqual(['cancelled']);
    // a queue sends its own history settings
    const other = (await q.add(2)).job;
    await q.cancel(other.id);
    expect(calls.filter((c) => c.op === 'cancel').map((c) => (c.args[1] as { history?: unknown }).history)).toEqual([undefined, { max: 200 }]);
  });

  it('producer: clean, drain and obliterate work without a worker', async () => {
    const { clock, store } = clocked();
    const p = producer(store);
    const scope = { namespace: 'default', queue: 'q' };
    await p.add(1, { maxAttempts: 1 });
    const { jobs } = await store.claim(scope, { workerId: 'w', limit: 1, leaseMs: 60_000, claimId: 'c' });
    await store.complete(scope, { id: jobs[0]!.id, token: jobs[0]!.token, result: null });
    clock.t += 2 * MIN;
    expect(await p.clean('completed', '1m')).toEqual({ removed: 1, done: true });
    await p.addBulk([{ data: 2 }, { data: 3 }, { data: 4, opts: { delay: '1h' } }]);
    expect(await p.drain()).toEqual({ removed: 2 });
    expect((await p.getCounts()).delayed).toBe(1);
    await p.upsertSchedule('s', { every: '1m', template: { data: 1 } });
    expect(await p.obliterate()).toEqual({ removed: 1 });
    expect(await p.getCounts()).toMatchObject({ waiting: 0, delayed: 0 });
    expect(await p.getSchedule('s')).toBeNull();
  });

  it('producer: add after close rejects with QueueClosedError', async () => {
    const p = new Producer('q', { store: new MemoryStore(), logger: silent });
    await p.add(1);
    await p.close();
    expect(p.closed).toBe(true);
    expect(p.connectionState).toBe('closed');
    await expect(p.add(2)).rejects.toBeInstanceOf(QueueClosedError);
    await expect(p.getCounts()).rejects.toBeInstanceOf(QueueClosedError);
  });

  it('producer: errors name the producer, not a queue', async () => {
    const { store, ctl } = outageStore(new MemoryStore());
    ctl.down = true;
    const down = producer(store);
    await expect(down.ready({ timeoutMs: 20 })).rejects.toThrow('producer "q": store not ready after 20 ms');
    const p = new Producer('q', { store: new MemoryStore(), logger: silent });
    await p.close();
    for (const call of [() => p.add(1), () => p.addBulk([{ data: 1 }]), () => p.getCounts(), () => p.ready(), () => p.cancel('x')]) {
      await expect(call()).rejects.toThrow('producer "q" is closed');
    }
  });

  it('producer: public members match the included list', () => {
    const names = new Set<string>();
    // protected fields (shared, events, hooks, ...) are own properties of the instance, so this prototype walk never sees them
    for (let o: object | null = Producer.prototype; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
      for (const n of Object.getOwnPropertyNames(o)) if (n !== 'constructor') names.add(n);
    }
    expect([...names].sort()).toEqual([...PRODUCER_MEMBERS].sort());
    const p = new Producer('q', { store: new MemoryStore(), logger: silent });
    expect('process' in p).toBe(false);
    expect((p as unknown as Record<string, unknown>)['process']).toBeUndefined();
  });

  it('producer: unknown or worker-side options throw InvalidOptionError', () => {
    const store = new MemoryStore();
    const issue = (opts: unknown) => {
      try {
        new Producer('q', opts as never);
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidOptionError);
        return (e as InvalidOptionError).issues[0];
      }
      throw new TypeError('expected InvalidOptionError');
    };
    expect(issue({ store, retention: {} })).toMatchObject({ path: 'retention', code: 'unknown_option' });
    expect(issue({ store, alerts: { depth: { above: 1 } } })).toMatchObject({ path: 'alerts', code: 'unknown_option' });
    expect(issue({ store, leaseDuration: '1s' })).toMatchObject({ path: 'leaseDuration', code: 'unknown_option' });
    // logPayloads was removed: no log line carries job data
    expect(issue({ store, logPayloads: true })).toMatchObject({ path: 'logPayloads', code: 'unknown_option' });
    expect(() => new Queue('q', { logPayloads: true } as never)).toThrow(InvalidOptionError);
    expect(issue({})).toMatchObject({ path: 'store', code: 'missing_option' });
    expect(issue({ store, namspace: 'x' })).toMatchObject({ path: 'namspace', suggestion: 'namespace' });
    expect(issue({ store, namespace: 'bad name' })).toMatchObject({ path: 'namespace', code: 'invalid_value' });
  });

  it('producer: close leaves a passed-in store open', async () => {
    const store = new MemoryStore();
    const spy = spyStore(store);
    const p = new Producer('q', { store: spy.store, logger: silent });
    await p.add(1);
    await p.close();
    expect(spy.calls.filter((c) => c.op === 'close')).toEqual([]);
    expect(typeof (await store.now())).toBe('number');
  });
});

describe('producer metrics and alerts', () => {
  it('metrics: producer-only exposes only sureq_jobs and sureq_jobs_added_total', async () => {
    const p = producer(new MemoryStore());
    await p.add(1);
    await p.add(2, { name: 'x' });
    const { samples } = await p.metrics();
    const names = new Set(samples.map((s) => s.name));
    expect([...names].sort()).toEqual(['sureq_jobs', 'sureq_jobs_added_total', 'sureq_oldest_waiting_age_seconds']);
    expect(samples.filter((s) => s.name === 'sureq_jobs_added_total').reduce((n, s) => n + ('value' in s ? s.value : 0), 0)).toBe(2);

    const filtered = producer(new MemoryStore(), { filter: () => 'no' });
    await filtered.add(1).catch(() => {});
    expect(new Set((await filtered.metrics()).samples.map((s) => s.name))).toEqual(new Set(['sureq_jobs', 'sureq_oldest_waiting_age_seconds', 'sureq_jobs_rejected_total']));
  });

  it('alerts: producer-only pod does not evaluate', async () => {
    useFakeTime();
    expect(() => new Producer('q', { store: new MemoryStore(), alerts: { depth: { above: 1 } } } as never)).toThrow(InvalidOptionError);
    const spy = spyStore(new MemoryStore());
    const p = producer(spy.store);
    await p.add(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy.calls.filter((c) => c.op === 'stats')).toEqual([]);
    expect(await p.health()).toMatchObject({ workers: [], live: true, alerts: [] });
  });

  it('producer: health has no workers, no alerts and no dead-letter warning, from one store clock read', async () => {
    const spy = spyStore(new MemoryStore());
    const q = new Producer('q', { store: spy.store, logger: silent });
    track(q);
    await q.ready();
    spy.calls.length = 0;
    const r = await q.health();
    expect(r).toMatchObject({ live: true, ready: true, workers: [], alerts: [] });
    expect(r.warnings.map((w) => w.code)).not.toContain('DEAD_LETTERS_HIGH');
    expect(spy.calls.map((c) => c.op)).toEqual(['now']);
  });
});

describe('producer schedules', () => {
  it('schedule-mgmt: methods work on a producer-only queue', async () => {
    const run = async (c: Producer | Queue) => {
      const out: unknown[] = [];
      const strip = (s: unknown) => JSON.parse(JSON.stringify(s, (k, v: unknown) => (['createdAt', 'updatedAt'].includes(k) ? undefined : v))) as unknown;
      out.push(strip(await c.upsertSchedule('a', { cron: '*/5 * * * *', template: { data: { n: 1 } } })));
      out.push(strip(await c.upsertSchedule('b', { every: '1m', template: { data: 2 } })));
      out.push(strip(await c.getSchedule('a')));
      out.push(strip(await c.listSchedules({ limit: 1 })));
      out.push(strip(await c.pauseSchedule('a')));
      out.push(strip(await c.resumeSchedule('a')));
      out.push(await c.nextRuns('a', 3));
      out.push(await c.deleteSchedule('b'));
      out.push(await c.deleteSchedule('b'));
      return out;
    };
    const fromProducer = await run(producer(clocked().store));
    const fromQueue = await run(worker(clocked().store));
    expect(fromProducer).toEqual(fromQueue);
  });

  it('schedule-tick: producer-only queue never fires', async () => {
    useFakeTime();
    const { clock, store } = clocked();
    const spy = spyStore(store);
    const p = producer(spy.store);
    await p.upsertSchedule('k', { every: '1s', template: { data: 1 } });
    for (let i = 0; i < 10; i++) {
      clock.t += 1000;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(store.dump().jobs).toEqual([]);
    expect(spy.calls.filter((c) => c.op === 'listDueSchedules' || c.op === 'fireSchedule')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
