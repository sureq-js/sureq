import type { PodMetrics } from '../../src/metrics/metrics.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import type { StoreClient } from '../../src/store/client.js';
import type { JobRecord, SweepRequest, SweepResult, SweptJob } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Sweeper, type SweeperHost } from '../../src/worker/sweeper.js';
import { silent } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';
import { defineCapabilities } from '../../src/store/capabilities.js';

afterEach(() => {
  vi.useRealTimers();
});

const down = () => new StoreUnavailableError('down', { operation: 'sweep', retryable: true, outcomeUnknown: false });
const swept = (id: string, over: Partial<SweptJob> = {}): SweptJob => ({ id, token: 1, previousOwner: `w-${id}`, action: 'requeued', attempt: 1, crashCount: 1, ...over });
const record = (id: string, over: Partial<JobRecord> = {}) => ({ id, crashCount: 1, error: null, ...over }) as JobRecord;

/** A host whose store calls are spies: `sweep` answers from the queue `answers` (last one repeats), `get` from `records`. */
function world(o: { answers?: Array<SweepResult | Error | Promise<SweepResult>>; records?: Record<string, JobRecord | null | Error | Array<JobRecord | null | Error>>; emit?: SweeperHost['emit'] } = {}) {
  vi.useFakeTimers();
  const answers = o.answers ?? [{ swept: [], now: 1 }];
  let n = 0;
  const call = vi.fn((op: string, _scope: unknown, arg: unknown) => {
    if (op === 'sweep') {
      const a = answers[Math.min(n++, answers.length - 1)]!;
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    }
    if (op === 'get') {
      const entry = o.records?.[arg as string] ?? null;
      // a list answers one read each, the last one repeating
      const rec = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
      return rec instanceof Error ? Promise.reject(rec) : Promise.resolve(rec);
    }
    return Promise.reject(new Error(`unexpected ${op}`));
  });
  const emitted: Array<[string, unknown]> = [];
  const host: SweeperHost = {
    client: { call } as unknown as StoreClient,
    scope: { namespace: 'n', queue: 'q' },
    toJob: (rec) => ({ id: rec.id }) as Job,
    maxFormat: () => 1,
    isDegraded: () => false,
    emit: o.emit ?? ((event, payload) => void emitted.push([event, payload])),
    report: vi.fn(),
    evaluateDrained: vi.fn(() => Promise.resolve()),
    metrics: { attemptEnded: vi.fn() } as unknown as PodMetrics,
    afterTick: vi.fn(() => Promise.resolve()),
  };
  const sweeps = () => call.mock.calls.filter((c) => c[0] === 'sweep');
  return { host, call, sweeps, emitted };
}

const make = (host: SweeperHost, over: Partial<ConstructorParameters<typeof Sweeper>[1]> = {}) =>
  new Sweeper(host, { sweepIntervalMs: 500, sweepBatch: 2, maxCrashes: 3, random: () => 0.5, ...over });

describe('sweeper loop', () => {
  it('sweep: interval has jitter and drains full batches up to 10 rounds', async () => {
    const low = world();
    const a = make(low.host, { random: () => 0 });
    a.start();
    await vi.advanceTimersByTimeAsync(399);
    expect(low.sweeps()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(low.sweeps()).toHaveLength(1);
    await a.stop();

    const high = world();
    const b = make(high.host, { random: () => 1 });
    b.start();
    await vi.advanceTimersByTimeAsync(599);
    expect(high.sweeps()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(high.sweeps()).toHaveLength(1);
    await b.stop();

    const full = { swept: [swept('a'), swept('b')], now: 1 };
    const always = world({ answers: [full] });
    const c = make(always.host);
    c.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(always.sweeps()).toHaveLength(10);
    const req = always.sweeps()[0]![2] as SweepRequest;
    expect(req).toMatchObject({ limit: 2, maxCrashes: 3 });
    expect(JSON.parse(req.failError as string)).toMatchObject({ name: 'StalledJobError', code: 'JOB_STALLED' });
    expect(JSON.parse(req.poisonError as string)).toMatchObject({ name: 'PoisonPillError', code: 'POISON_PILL', props: { maxCrashes: 3 } });
    await c.stop();

    const twice = world({ answers: [full, full, { swept: [swept('c')], now: 1 }, { swept: [], now: 1 }] });
    const d = make(twice.host);
    d.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(twice.sweeps()).toHaveLength(3);
    await d.stop();
  });

  it('sweep: stalled event fires once per swept job, failed event also when action is failed', async () => {
    const poison = JSON.stringify({ v: 1, name: 'PoisonPillError', code: 'POISON_PILL', message: 'm', props: { maxCrashes: 3 } });
    const w = world({
      answers: [{ swept: [swept('A'), swept('B', { action: 'failed', crashCount: 3 }), swept('C', { action: 'failed', crashCount: 1 })], now: 1 }, { swept: [], now: 1 }],
      records: { A: record('A'), B: record('B', { crashCount: 3, error: poison }), C: record('C', { error: '{"v":1,"name":"StalledJobError","message":"m"}' }) },
    });
    const s = make(w.host, { sweepBatch: 5 });
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    await s.stop();
    expect(w.emitted.map(([e, p]) => [e, (p as { job: Job }).job.id])).toEqual([['stalled', 'A'], ['stalled', 'B'], ['failed', 'B'], ['stalled', 'C'], ['failed', 'C']]);
    expect(w.emitted[0]![1]).toEqual({ job: { id: 'A' }, previousWorkerId: 'w-A', crashCount: 1, action: 'requeued' });
    expect(w.emitted[2]![1]).toMatchObject({ reason: 'unrecoverable', error: { code: 'POISON_PILL', props: { jobId: 'B', crashCount: 3, maxCrashes: 3 } } });
    expect(w.emitted[4]![1]).toMatchObject({ reason: 'attempts-exhausted', error: { name: 'StalledJobError' } });
    expect(w.host.report).not.toHaveBeenCalled();
    // Each failed job may have emptied the queue.
    expect(w.host.evaluateDrained).toHaveBeenCalledTimes(2);
  });

  it('sweep: a failed job the store stored no error for is announced with a StalledJobError', async () => {
    const w = world({ answers: [{ swept: [swept('A', { action: 'failed', crashCount: 1 })], now: 1 }, { swept: [], now: 1 }], records: { A: record('A') } });
    const s = make(w.host, { sweepBatch: 5 });
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    await s.stop();
    expect(w.emitted[1]).toEqual(['failed', expect.objectContaining({ reason: 'attempts-exhausted', error: expect.objectContaining({ code: 'JOB_STALLED', name: 'StalledJobError' }) })]);
  });

  it('sweep: store error emits one error event per outage and the loop continues', async () => {
    const ok = { swept: [], now: 1 };
    const w = world({ answers: [down(), down(), down(), ok, down(), ok] });
    const s = make(w.host);
    s.start();
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(500);
    expect(w.sweeps()).toHaveLength(5);
    expect(w.host.report).toHaveBeenCalledTimes(2);
    expect(w.host.report).toHaveBeenCalledWith(expect.any(StoreUnavailableError), 'store', 'sweep');
    await vi.advanceTimersByTimeAsync(500);
    expect(w.sweeps()).toHaveLength(6);
    await s.stop();
  });

  it('sweep: a failed read of a swept job is retried once and the rest of the batch is still announced', async () => {
    const full = { swept: [swept('a'), swept('b'), swept('c')], now: 1 };
    const w = world({ answers: [full, { swept: [], now: 1 }], records: { a: [down(), record('a')], b: down(), c: record('c') } });
    const s = make(w.host, { sweepBatch: 3 });
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    const gets = w.call.mock.calls.filter((c) => c[0] === 'get').map((c) => c[2]);
    expect(gets).toEqual(['a', 'a', 'b', 'b', 'c']);
    expect(w.emitted.map(([event, p]) => [event, (p as { job: Job }).job.id])).toEqual([['stalled', 'a'], ['stalled', 'c']]);
    // one report for the outage, and no second round in this tick
    expect(w.host.report).toHaveBeenCalledTimes(1);
    expect(w.host.report).toHaveBeenCalledWith(expect.any(StoreUnavailableError), 'store', 'sweep');
    expect(w.sweeps()).toHaveLength(1);
    await s.stop();
  });

  it('sweep: throwing stalled listener does not stop the loop', async () => {
    const boom = new Error('listener');
    const w = world({
      answers: [{ swept: [swept('A')], now: 1 }, { swept: [], now: 1 }],
      records: { A: record('A') },
      emit: () => {
        throw boom;
      },
    });
    const s = make(w.host);
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(w.host.report).toHaveBeenCalledWith(boom, 'internal', 'sweep');
    await vi.advanceTimersByTimeAsync(500);
    expect(w.sweeps()).toHaveLength(2);
    await s.stop();
  });

  it('sweep: swept job that was removed before it could be read emits no event', async () => {
    const w = world({ answers: [{ swept: [swept('gone')], now: 1 }, { swept: [], now: 1 }], records: { gone: null } });
    const s = make(w.host);
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    await s.stop();
    expect(w.call.mock.calls.filter((c) => c[0] === 'get')).toHaveLength(1);
    expect(w.emitted).toEqual([]);
    expect(w.host.report).not.toHaveBeenCalled();
  });

  it('sweep: stop waits for a tick in flight and a store failure during stop does not throw', async () => {
    let settle!: (r: SweepResult) => void;
    const pending = new Promise<SweepResult>((r) => (settle = r));
    const w = world({ answers: [pending] });
    const s = make(w.host);
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    let stopped = false;
    const stopping = s.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    settle({ swept: [], now: 1 });
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.sweeps()).toHaveLength(1);

    let fail!: (e: Error) => void;
    const failing = new Promise<SweepResult>((_, r) => (fail = r));
    const f = world({ answers: [failing] });
    const t = make(f.host);
    t.start();
    await vi.advanceTimersByTimeAsync(500);
    const stop = t.stop();
    fail(down());
    await expect(stop).resolves.toBeUndefined();
  });

  it('sweep: a slow afterTick never delays the next sweep, runs one at a time and is waited for by stop', async () => {
    const w = world();
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    vi.mocked(w.host.afterTick).mockImplementationOnce(() => slow);
    const s = make(w.host);
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(s.ticks.lastTickAt).toBeDefined();
    // the upkeep still runs: two more sweeps go on schedule, and no second upkeep starts beside it
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.sweeps()).toHaveLength(3);
    expect(w.host.afterTick).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = s.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(w.host.afterTick).toHaveBeenCalledTimes(1);
  });

  it('sweep: a sweeper stopped during its tick runs no afterTick', async () => {
    let settle!: (r: SweepResult) => void;
    const pending = new Promise<SweepResult>((r) => (settle = r));
    const w = world({ answers: [pending] });
    const s = make(w.host);
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    const stopping = s.stop();
    settle({ swept: [], now: 1 });
    await stopping;
    expect(w.host.afterTick).not.toHaveBeenCalled();
  });
});

describe('sweeper options', () => {
  const store = new MemoryStore();
  const path = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidOptionError);
      return (e as InvalidOptionError).issues[0]?.path;
    }
    return undefined;
  };
  const queue = (opts: Record<string, unknown> = {}) => new Queue('o', { store, logger: silent, ...opts });

  it('poison: invalid maxCrashes throws InvalidOptionError', () => {
    for (const maxCrashes of [0, 1.5, '3', -1]) expect(path(() => queue({ maxCrashes }))).toBe('maxCrashes');
    expect(queue().internals.maxCrashes).toBe(3);
    expect(queue({ maxCrashes: 1 }).internals.maxCrashes).toBe(1);
  });

  it('sweep: sweepInterval and sweepBatch are validated and default to 5 s and 100', () => {
    const q = queue();
    for (const sweepBatch of [0, 1001]) expect(path(() => q.process(() => {}, { autorun: false, sweepBatch }))).toBe('sweepBatch');
    for (const sweepInterval of [499, 86_400_001, '2d', 'abc', 1.5]) expect(path(() => q.process(() => {}, { autorun: false, sweepInterval: sweepInterval as number }))).toBe('sweepInterval');
    expect(path(() => q.process({ a: () => {} }, { autorun: false, sweepInterval: '500ms' }))).toBeUndefined();
    expect(path(() => q.process({ b: () => {} }, { autorun: false, sweepInterval: 500 }))).toBeUndefined();
    expect(path(() => q.process({ c: () => {} }, { autorun: false, sweepInterval: '1d' }))).toBeUndefined();
  });

  it('sweep: a sweepBatch above the store claim limit is capped with one warning', async () => {
    const spy = spyStore(new MemoryStore());
    Object.defineProperty(spy.store, 'capabilities', { value: defineCapabilities({ ...new MemoryStore().capabilities, limits: { maxIdBytes: 255, maxClaimLimit: 10 } }) });
    const log = { ...silent, warn: vi.fn() };
    const q = new Queue('cap', { store: spy.store, logger: log });
    q.process({ a: () => {} }, { sweepBatch: 50, sweepInterval: 500, acknowledgeVolatileStore: true });
    q.process({ b: () => {} }, { sweepBatch: 50, sweepInterval: 500, acknowledgeVolatileStore: true });
    await vi.waitFor(() => expect(spy.calls.some((c) => c.op === 'sweep')).toBe(true), { timeout: 2000 });
    await q.close();
    expect((spy.calls.find((c) => c.op === 'sweep')!.args[1] as SweepRequest).limit).toBe(10);
    expect(log.warn.mock.calls.filter(([m]) => String(m).includes('sweepBatch'))).toHaveLength(1);
  });
});
