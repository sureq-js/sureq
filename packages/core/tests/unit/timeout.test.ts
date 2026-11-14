import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, LeaseLostError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import type { AddOptions, QueueOptions, WorkerOptions } from '../../src/queue/options.js';
import type { FailRequest } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { JobContext } from '../../src/worker/context.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';
import { stored } from '../helpers/store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

/** A fixed poll, no jitter and no sweep within a test. */
const steady = { ...poll(50), random: () => 0.5, sweepInterval: 3_600_000 };
type Handler = (job: Job, ctx: JobContext) => unknown;

/** A queue on a spied MemoryStore; `manual` gives the store a hand-driven clock (`clock.t`), else the faked wall clock. */
function world(o: { manual?: boolean; queue?: QueueOptions } = {}) {
  useFakeTime();
  const clock = { t: Date.now() };
  const inner = new MemoryStore({ clock: o.manual ? () => clock.t : () => Date.now() });
  const spy = spyStore(inner);
  const logger = { ...silent, warn: vi.fn() };
  const q = new Queue('t', { store: spy.store, logger, ...o.queue });
  queues.push(q);
  const events = { failed: vi.fn(), retrying: vi.fn(), completed: vi.fn(), leaseLost: vi.fn() };
  for (const [k, fn] of Object.entries(events)) q.on(k as 'failed', fn);
  const ops = (op: string) => spy.calls.filter((c) => c.op === op);
  /** Handler start times (pod ms) and the contexts they got, in call order. */
  const starts: number[] = [];
  const contexts: JobContext[] = [];
  const run = (handler: Handler, opts: WorkerOptions = {}) =>
    q.process((job: Job, ctx: JobContext) => {
      starts.push(Date.now());
      contexts.push(ctx);
      return handler(job, ctx);
    }, { ...steady, ...opts });
  /** Advance the faked clock to `ms` after the first handler started. */
  const at = async (ms: number) => vi.advanceTimersByTimeAsync(starts[0]! + ms - Date.now());
  const rec = async (id: string) => (await stored(inner, q.internals.scope, id))!;
  const add = (opts: AddOptions = {}) => q.add(1, { maxAttempts: 1, ...opts }).then((r) => r.job.id);
  const abandonWarnings = () => logger.warn.mock.calls.filter(([m]) => String(m).includes('abandoned'));
  return { clock, inner, spy, q, ops, events, starts, contexts, run, at, rec, add, logger, abandonWarnings };
}

const abortPromise = (ctx: JobContext) => new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r()));
const rejectOnAbort: Handler = async (_job, ctx) => {
  await abortPromise(ctx);
  throw ctx.signal.reason;
};
const never: Handler = () => new Promise(() => {});

describe('timeouts', () => {
  it('timeout: handler that stops on abort fails immediately without waiting out the grace', async () => {
    const w = world();
    const id = await w.add();
    w.run(rejectOnAbort, { timeout: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(999);
    expect((await w.rec(id)).state).toBe('active');
    await w.at(1005);
    const r = await w.rec(id);
    expect(r.state).toBe('failed');
    expect(r.error).toMatchObject({ code: 'JOB_TIMEOUT', props: { abandoned: false, timeoutMs: 1000, graceMs: 5000 } });
    expect(w.events.failed).toHaveBeenCalledOnce();
    expect(w.events.failed.mock.calls[0]![0]).toMatchObject({ reason: 'attempts-exhausted', error: { code: 'JOB_TIMEOUT' } });
  });

  it('timeout: result returned after abort is discarded and attempt fails', async () => {
    const w = world();
    const id = await w.add();
    w.run(async (_job, ctx) => {
      await abortPromise(ctx);
      return 'late';
    }, { timeout: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(1005);
    const r = await w.rec(id);
    expect(r).toMatchObject({ state: 'failed', result: null, error: { code: 'JOB_TIMEOUT', props: { abandoned: false } } });
    expect(w.events.completed).not.toHaveBeenCalled();
  });

  it('timeout: handler ignoring the signal is failed after timeout plus grace with abandoned true', async () => {
    const w = world();
    const id = await w.add();
    let lateReject!: (e: Error) => void;
    w.run(() => new Promise((_, reject) => (lateReject = reject)), { timeout: 1000, timeoutGrace: 500 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(1499);
    expect(w.contexts[0]!.signal.aborted).toBe(true);
    expect((await w.rec(id)).state).toBe('active');
    await w.at(1505);
    expect(await w.rec(id)).toMatchObject({ state: 'failed', error: { code: 'JOB_TIMEOUT', props: { abandoned: true } } });
    expect(w.abandonWarnings()).toHaveLength(1);
    lateReject(new Error('late'));
    await vi.advanceTimersByTimeAsync(100);
    expect(await w.rec(id)).toMatchObject({ state: 'failed', error: { props: { abandoned: true } } });
    expect(w.events.failed).toHaveBeenCalledOnce();
  });

  it('timeout: slot is freed when an abandoned handler is failed', async () => {
    const w = world();
    await w.add();
    await w.add();
    const worker = w.run((job, ctx) => (w.starts.length === 1 ? never(job, ctx) : 'ok'), { timeout: 1000, timeoutGrace: 500, concurrency: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.starts).toHaveLength(1);
    await w.at(1499);
    expect(w.starts).toHaveLength(1);
    await w.at(1505);
    expect(w.starts).toHaveLength(2);
    expect(w.starts[1]! - w.starts[0]!).toBeGreaterThanOrEqual(1500);
    expect(w.starts[1]! - w.starts[0]!).toBeLessThan(1501);
    await vi.advanceTimersByTimeAsync(10);
    expect(w.events.completed).toHaveBeenCalledOnce();
    expect(worker.inFlight).toBe(0);
  });

  it("timeout: abandoned handler's late complete is rejected and changes nothing", async () => {
    const w = world();
    const id = await w.add({ maxAttempts: 2, backoff: { type: 'fixed', delay: 0 } });
    let finishFirst!: (v: string) => void;
    const tokens: number[] = [];
    w.run((job) => {
      tokens.push(job.token);
      return tokens.length === 1 ? new Promise((r) => (finishFirst = r)) : 'second';
    }, { timeout: 1000, timeoutGrace: 500 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(1600);
    expect(tokens).toHaveLength(2);
    expect(await w.rec(id)).toMatchObject({ state: 'completed', result: '"second"' });
    finishFirst('first');
    await vi.advanceTimersByTimeAsync(100);
    expect(await w.rec(id)).toMatchObject({ state: 'completed', result: '"second"' });
    expect(w.events.completed).toHaveBeenCalledOnce();
    expect(w.ops('complete').filter((c) => (c.args[1] as { token: number }).token === tokens[0])).toEqual([]);
  });

  it('timeout: timed out attempt retries with backoff and then fails on last attempt', async () => {
    const w = world();
    const id = await w.add({ maxAttempts: 2, backoff: { type: 'fixed', delay: 1000 } });
    w.run(rejectOnAbort, { timeout: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(1005);
    expect(w.events.retrying).toHaveBeenCalledOnce();
    expect(w.events.retrying.mock.calls[0]![0]).toMatchObject({ error: { code: 'JOB_TIMEOUT' }, delayMs: 1000 });
    await w.at(3200);
    expect(w.starts).toHaveLength(2);
    expect((await w.rec(id)).state).toBe('failed');
    expect(w.events.failed.mock.calls[0]![0]).toMatchObject({ reason: 'attempts-exhausted', error: { code: 'JOB_TIMEOUT' } });
  });

  it('timeout: retryIf can mark JobTimeoutError as non-retryable', async () => {
    const w = world();
    await w.add({ maxAttempts: 3 });
    w.run(rejectOnAbort, { timeout: 1000, retryIf: (e) => (e as { code?: string }).code !== 'JOB_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(1005);
    expect(w.events.failed.mock.calls[0]![0]).toMatchObject({ reason: 'not-retryable', error: { code: 'JOB_TIMEOUT' } });
    expect(w.events.retrying).not.toHaveBeenCalled();
  });

  it('timeout: lease lost before timeout aborts with LeaseLostError and does not call fail', async () => {
    const w = world({ manual: true, queue: { leaseDuration: '1s' } });
    await w.add();
    w.run(never, { timeout: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    w.clock.t += 2000;
    await vi.advanceTimersByTimeAsync(400);
    const signal = w.contexts[0]!.signal;
    expect(signal.reason).toBeInstanceOf(LeaseLostError);
    await w.at(16_000);
    expect(signal.reason).toBeInstanceOf(LeaseLostError);
    expect(w.ops('fail')).toEqual([]);
  });

  it('timeout: lease lost during the grace fails nothing and emits one leaseLost', async () => {
    const w = world({ manual: true, queue: { leaseDuration: '1s' } });
    await w.add();
    w.run(never, { timeout: 500, timeoutGrace: 3000 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(600);
    const signal = w.contexts[0]!.signal;
    expect(signal.aborted).toBe(true);
    expect(w.events.leaseLost).not.toHaveBeenCalled();
    w.clock.t += 2000;
    await vi.advanceTimersByTimeAsync(400);
    expect(w.events.leaseLost).toHaveBeenCalledOnce();
    await w.at(5000);
    expect(w.ops('fail')).toEqual([]);
    expect(w.abandonWarnings()).toEqual([]);
    expect(w.events.failed).not.toHaveBeenCalled();
    expect(w.events.retrying).not.toHaveBeenCalled();
    expect(w.events.leaseLost).toHaveBeenCalledOnce();
  });

  it('timeout: per-add overrides worker overrides queue', async () => {
    /** Ms from the handler's start to its signal's abort, or to the failure when it ignores the signal. */
    const measure = async (o: { queue?: QueueOptions; worker?: WorkerOptions; add?: AddOptions; ignore?: boolean }) => {
      const w = world(o.queue ? { queue: o.queue } : {});
      await w.add(o.add);
      let endedAt: number | undefined;
      w.q.on('failed', () => void (endedAt ??= Date.now()));
      w.run(async (_job, ctx) => {
        if (o.ignore) return never(_job, ctx);
        await abortPromise(ctx);
        endedAt = Date.now();
        throw ctx.signal.reason;
      }, o.worker);
      await vi.advanceTimersByTimeAsync(0);
      await w.at(4000);
      return endedAt! - w.starts[0]!;
    };
    expect(await measure({ queue: { timeout: 3000 }, worker: { timeout: 2000 }, add: { timeout: 1000 } })).toBe(1000);
    expect(await measure({ queue: { timeout: 3000 }, worker: { timeout: 2000 } })).toBe(2000);
    expect(await measure({ queue: { timeout: 3000 } })).toBe(3000);
    expect(await measure({ queue: { timeoutGrace: 900 }, worker: { timeout: 2000, timeoutGrace: 700 }, add: { timeoutGrace: 100 }, ignore: true })).toBe(2100);
    expect(await measure({ queue: { timeoutGrace: 900 }, worker: { timeout: 1000, timeoutGrace: 700 }, ignore: true })).toBe(1700);
    expect(await measure({ queue: { timeout: 1000, timeoutGrace: 900 }, ignore: true })).toBe(1900);
  });

  it('timeout: invalid values throw InvalidOptionError', () => {
    useFakeTime();
    const store = new MemoryStore();
    const paths = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidOptionError);
        return (e as InvalidOptionError).issues.map((i) => i.path);
      }
      return [];
    };
    expect(paths(() => new Queue('q', { store, logger: silent, timeout: 0 }))).toEqual(['timeout']);
    expect(paths(() => new Queue('q', { store, logger: silent, timeoutGrace: -1 }))).toEqual(['timeoutGrace']);
    const q = new Queue('q', { store, logger: silent, timeoutGrace: 0 });
    queues.push(q);
    expect(paths(() => q.process(() => 1, { autorun: false, timeout: 1.5 }))).toEqual(['timeout']);
    expect(paths(() => q.process(() => 1, { autorun: false, timeout: 'abc' as never }))).toEqual(['timeout']);
    expect(paths(() => q.process(() => 1, { autorun: false, timeoutGrace: -1 }))).toEqual(['timeoutGrace']);
    expect(paths(() => q.process(() => 1, { autorun: false, timeoutGrace: 0, timeout: '1s' }))).toEqual([]);
  });

  it('timeout: timeout and timeoutGrace are capped at the longest timer Node runs', async () => {
    useFakeTime();
    const store = new MemoryStore();
    const issues = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        if (!(e instanceof InvalidOptionError)) throw e;
        return e.issues.map(({ path, code }) => ({ path, code }));
      }
      return [];
    };
    const max = 2_147_483_647;
    const over = [{ path: 'timeout', code: 'out_of_range' }, { path: 'timeoutGrace', code: 'out_of_range' }];
    expect(issues(() => new Queue('q', { store, logger: silent, timeout: max + 1, timeoutGrace: max + 1 }))).toEqual(over);
    const q = new Queue('q', { store, logger: silent, timeout: max, timeoutGrace: max });
    queues.push(q);
    expect(issues(() => q.process(() => 1, { autorun: false, timeout: max + 1, timeoutGrace: max + 1 }))).toEqual(over);
    expect(issues(() => q.process(() => 1, { autorun: false, timeout: max, timeoutGrace: max }))).toEqual([]);
    await expect(q.add(1, { timeout: max + 1 })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'out_of_range' })] });
  });

  it('timeout: timer starts at handler invocation not at claim', async () => {
    const w = world();
    await w.add();
    const worker = w.run(never, { timeout: 1000 });
    worker.on('active', () => void vi.advanceTimersByTime(900));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.starts).toHaveLength(1);
    await w.at(900);
    expect(w.contexts[0]!.signal.aborted).toBe(false);
    await w.at(1000);
    expect(w.contexts[0]!.signal.aborted).toBe(true);
  });

  it('timeout: heartbeat keeps renewing between the abort and the fail', async () => {
    const w = world({ queue: { leaseDuration: '1s' } });
    await w.add();
    w.run(never, { timeout: 500, timeoutGrace: 3000 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(5000);
    const t0 = w.starts[0]!;
    const failAt = w.ops('fail')[0]!.at - t0;
    const renews = w.ops('renew').map((c) => c.at - t0);
    expect(failAt).toBe(3500);
    expect(renews.filter((t) => t > 500 && t < failAt).length).toBeGreaterThanOrEqual(8);
    expect(renews.filter((t) => t > failAt)).toEqual([]);
  });

  it('timeout: a handler that throws because of the abort is recorded as a timeout with the thrown error as cause', async () => {
    const w = world();
    const id = await w.add();
    w.run(async (_job, ctx) => {
      await abortPromise(ctx);
      throw new DOMException('x', 'AbortError');
    }, { timeout: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(1005);
    expect(await w.rec(id)).toMatchObject({
      state: 'failed',
      error: { code: 'JOB_TIMEOUT', props: { abandoned: false }, cause: { name: 'AbortError', message: 'x' } },
    });
  });

  it('timeout: a timeout longer than the lease duration lets a healthy handler finish', async () => {
    const w = world({ queue: { leaseDuration: '1s' } });
    const id = await w.add();
    w.run(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return 'ok';
    }, { timeout: 10_000 });
    for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(100);
    expect(await w.rec(id)).toMatchObject({ state: 'completed', result: '"ok"', crashCount: 0 });
  });

  it('timeout: ctx.fail after the abort still records the timeout', async () => {
    const w = world();
    const id = await w.add({ maxAttempts: 2 });
    w.run(async (_job, ctx) => {
      await abortPromise(ctx);
      ctx.fail(new Error('mine'), { retry: false });
    }, { timeout: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(1005);
    expect((await w.rec(id)).error).toMatchObject({ code: 'JOB_TIMEOUT', cause: { message: 'mine' } });
    expect(w.events.retrying).toHaveBeenCalledOnce();
    expect(w.events.failed).not.toHaveBeenCalled();
    expect((w.ops('fail')[0]!.args[1] as FailRequest).retryInMs).toBeTypeOf('number');
  });

  it('timeout: a handler cancelled during its grace is not warned about as failed', async () => {
    const w = world();
    const id = await w.add();
    const worker = w.run(never, { timeout: 1000, timeoutGrace: 500 });
    await vi.advanceTimersByTimeAsync(0);
    await w.at(1100);
    await w.q.cancel(id);
    await w.at(1600);
    expect(w.abandonWarnings()).toHaveLength(0);
    expect(w.ops('fail')).toHaveLength(0);
    expect(worker.inFlight).toBe(0);
  });
});
