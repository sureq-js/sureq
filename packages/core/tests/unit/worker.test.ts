import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import type { JobContext } from '../../src/worker/context.js';
import type { Worker } from '../../src/worker/worker.js';
import { poll } from '../helpers/poll.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const open: Worker<unknown, unknown>[] = [];
const setup = (opts: Record<string, unknown> = {}) => {
  const store = new MemoryStore();
  const q = new Queue('q', { store, logger: silent, ...opts });
  const scope = q.internals.scope;
  const state = async (id: string) => (await stored(store, scope, id))?.state;
  const track = <W extends Worker<unknown, unknown>>(w: W): W => (open.push(w), w);
  return { store, q, scope, state, track };
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => w.close({ timeoutMs: 1000 })));
});

describe('queue.process lifecycle', () => {
  it('process: worker starts automatically by default', () => {
    const { q, track } = setup();
    expect(track(q.process(() => 1)).isRunning()).toBe(true);
  });

  it('process: autorun false claims nothing until run is called', async () => {
    const { q, state, track } = setup();
    const w = track(q.process(() => 1, { autorun: false }));
    expect(w.isRunning()).toBe(false);
    const { job } = await q.add(1);
    await tick(50);
    expect(await state(job.id)).toBe('waiting');
  });

  it('process: run is idempotent', async () => {
    const { q, track } = setup();
    const w = track(q.process(() => 1, { autorun: false }));
    await expect(Promise.all([w.run(), w.run()])).resolves.toEqual([undefined, undefined]);
    expect(w.isRunning()).toBe(true);
  });

  it('process: run after close throws WorkerClosedError', async () => {
    const { q } = setup();
    const w = q.process(() => 1);
    await w.close();
    expect(w.isRunning()).toBe(false);
    await expect(w.run()).rejects.toMatchObject({ code: 'WORKER_CLOSED' });
  });

  it('process: invalid handler shapes throw InvalidOptionError (string name, empty map, non-function value)', () => {
    const { q } = setup();
    const cases: Array<[unknown[], RegExp]> = [
      [['a', () => 1], /^handler$/],
      [[{}], /^handlers$/],
      [[null], /^handler$/],
      [[[() => 1]], /^handler$/],
      [[{ a: 1 }], /^handlers\.a$/],
      [[{ 'a b': () => 1 }], /^handlers\.a b$/],
    ];
    for (const [args, path] of cases) {
      try {
        (q.process as (...a: unknown[]) => unknown)(...args);
        expect.unreachable(JSON.stringify(args));
      } catch (e) {
        expect(e, String(args[0])).toBeInstanceOf(InvalidOptionError);
        expect((e as InvalidOptionError).issues[0]!.path).toMatch(path);
      }
    }
  });

  it('process: invalid worker options throw InvalidOptionError', () => {
    const { q } = setup();
    for (const opts of [{ concurrency: 0 }, { pollMin: 1.5 }, { autorun: 'yes' }, { workerId: '' }, { retryIf: 1 }, { unwrapCause: 1 }, { backoffStrategies: { x: 1 } }, { concurency: 2 }]) {
      expect.soft(() => q.process(() => 1, opts as never), JSON.stringify(opts)).toThrow(InvalidOptionError);
    }
  });

  it('process: on returns an unsubscribe function', () => {
    const { q, track } = setup();
    const w = track(q.process(() => 1));
    const off = w.on('completed', () => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('process: two workers get distinct workerIds; explicit workerId is kept', () => {
    const { q, track } = setup();
    const w1 = track(q.process(() => 1));
    const w2 = track(q.process(() => 1));
    expect(w1.id).not.toBe(w2.id);
    expect(w1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(track(q.process(() => 1, { workerId: 'w-1' })).id).toBe('w-1');
  });
});

/** Resolve with the payload of the next `event` from `w`. */
const next = <K extends 'completed' | 'failed' | 'active' | 'error'>(w: Worker<unknown, unknown>, event: K) =>
  new Promise<Parameters<Parameters<Worker<unknown, unknown>['once']>[1]>[0]>((r) => w.once(event, r as never));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe('worker loop', () => {
  it('process: autorun false, then run, completes the waiting job', async () => {
    const { q, state, track } = setup();
    const w = track(q.process(() => 'done', { autorun: false }));
    const { job } = await q.add(1);
    await tick(20);
    expect(await state(job.id)).toBe('waiting');
    const done = next(w, 'completed');
    await w.run();
    await done;
    expect(await state(job.id)).toBe('completed');
  });

  it('process: run is idempotent (one loop)', async () => {
    const { store, q, track } = setup();
    const claim = vi.spyOn(store, 'claim');
    const w = track(q.process(() => 1, { autorun: false, ...poll(10_000) }));
    await Promise.all([w.run(), w.run()]);
    await tick(20);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('process: run resolves once the worker has started', async () => {
    const { q, track } = setup();
    const g = gate();
    const w = track(q.process(() => g.p, { autorun: false }));
    await q.add(1);
    const started = next(w, 'active');
    await w.run();
    await started;
    expect(w.inFlight).toBe(1);
    g.open();
  });

  it('process: handler return value is stored as result and job completes', async () => {
    const { store, scope, q, track } = setup();
    const w = track(q.process(() => ({ ok: 1 })));
    const events: unknown[] = [];
    w.on('completed', (e) => void events.push(e));
    const done = next(w, 'completed');
    const { job } = await q.add(1);
    await done;
    const rec = (await stored(store, scope, job.id))!;
    expect(rec.state).toBe('completed');
    expect(JSON.parse(rec.result!)).toEqual({ ok: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ job: { id: job.id, state: 'completed' }, result: { ok: 1 }, durationMs: expect.any(Number) });
  });

  it('process: handler throw hands the error to retry logic', async () => {
    const { store, scope, q, track } = setup();
    const w = track(q.process(() => Promise.reject(new TypeError('boom'))));
    const retrying = vi.fn();
    w.on('retrying', retrying);
    const failed = next(w, 'failed');
    const { job } = await q.add(1, { maxAttempts: 1 });
    expect(await failed).toMatchObject({ job: { id: job.id, state: 'failed' }, error: { message: 'boom' } });
    expect((await stored(store, scope, job.id))!).toMatchObject({ state: 'failed', error: { message: 'boom' } });
    expect(retrying).not.toHaveBeenCalled();
  });

  it('process: non-Error throw is wrapped with cause', async () => {
    const { store, scope, q, track } = setup();
    const w = track(
      q.process(() => {
        throw 'x';
      }),
    );
    const failed = next(w, 'failed');
    const { job } = await q.add(1, { maxAttempts: 1 });
    await failed;
    const err = (await stored(store, scope, job.id))!.error!;
    expect(err.message).toBe('x');
    // The serializer stores a non-Error cause as a NonErrorThrown node carrying the value.
    expect(err.cause).toMatchObject({ name: 'NonErrorThrown', message: 'x' });
  });

  it('process: throwing handler releases its concurrency slot', async () => {
    const { store, scope, q, track } = setup();
    const w = track(q.process(() => Promise.reject(new TypeError('no')), { concurrency: 1 }));
    let n = 0;
    const all = new Promise<void>((r) => w.on('failed', () => void (++n === 5 && r())));
    await q.addBulk(Array.from({ length: 5 }, (_, i) => ({ data: i, opts: { maxAttempts: 1 } })));
    await all;
    expect((await store.counts(scope)).failed).toBe(5);
    await tick(0);
    expect(w.inFlight).toBe(0);
  });

  it('process: throwing listener does not stop the loop', async () => {
    const { q, state, track } = setup();
    const w = track(q.process(() => 1));
    w.on('active', () => {
      throw new TypeError('l');
    });
    const error = next(w, 'error');
    const done = next(w, 'completed');
    const { job } = await q.add(1);
    await done;
    expect(await error).toMatchObject({ error: { code: 'LISTENER_ERROR' } });
    expect(await state(job.id)).toBe('completed');
  });

  it('process: ctx exposes signal, attempt, isLastAttempt, workerId and fail', async () => {
    const { q, track } = setup();
    const seen: Array<{ ctx: JobContext; attempt: number }> = [];
    const w = track(q.process((job, ctx) => void seen.push({ ctx, attempt: job.attempt })));
    let n = 0;
    const both = new Promise<void>((r) => w.on('completed', () => void (++n === 2 && r())));
    await q.add(1, { maxAttempts: 1 });
    await q.add(2);
    await both;
    const [last, notLast] = seen.map((s) => s.ctx);
    expect(last!.signal).toBeInstanceOf(AbortSignal);
    expect(last!.signal.aborted).toBe(false);
    expect(last!.isLastAttempt).toBe(true);
    expect(notLast!.isLastAttempt).toBe(false);
    expect(last!.workerId).toBe(w.id);
    expect(typeof last!.fail).toBe('function');
    expect(() => last!.fail(new TypeError('stop'), { retry: false })).toThrow();
  });

  it('process: attempt in ctx equals job.attempt and starts at 1', async () => {
    const { q, track } = setup();
    const seen: number[][] = [];
    const w = track(q.process((job, ctx) => void seen.push([ctx.attempt, job.attempt])));
    const done = next(w, 'completed');
    await q.add(1);
    await done;
    expect(seen).toEqual([[1, 1]]);
  });

  it('process: add wakes an idle local worker without waiting for the poll interval', async () => {
    const { q, track } = setup();
    const w = track(q.process(() => 1, { ...poll(60_000) }));
    await tick(10); // the first empty claim is done; the worker sleeps
    const done = next(w, 'completed');
    const t0 = Date.now();
    await q.add(1);
    await done;
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('process: jobs are claimed in priority then FIFO order', async () => {
    const { q, track } = setup();
    const order: unknown[] = [];
    const w = track(q.process((job) => void order.push(job.data), { autorun: false, concurrency: 1 }));
    await q.add('a', { priority: 0 });
    await q.add('b', { priority: 5 });
    await q.add('c', { priority: 0 });
    let n = 0;
    const all = new Promise<void>((r) => w.on('completed', () => void (++n === 3 && r())));
    await w.run();
    await all;
    expect(order).toEqual(['b', 'a', 'c']);
  });
});

describe('worker close', () => {
  it('process: close waits for running handlers and stops claiming', async () => {
    const { q, state } = setup();
    const g = gate();
    const w = q.process(() => g.p);
    const started = next(w, 'active');
    const { job: first } = await q.add(1);
    await started;
    let closed = false;
    const c = w.close().then(() => (closed = true));
    const { job: second } = await q.add(2);
    await tick(30);
    expect(closed).toBe(false);
    g.open();
    await c;
    expect(await state(first.id)).toBe('completed');
    expect(await state(second.id)).toBe('waiting');
  });

  it('process: close with timeoutMs aborts a handler still running and releases its job', async () => {
    const { q, state } = setup({ shutdownAbortGrace: 0 });
    let reason: unknown;
    const w = q.process((_job, ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject((reason = ctx.signal.reason)))));
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const t0 = Date.now();
    await w.close({ timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(reason).toMatchObject({ code: 'SHUTDOWN' });
    expect(w.inFlight).toBe(0);
    expect(await state(job.id)).toBe('waiting');
  });

  it('process: close without timeoutMs waits for a slow handler', async () => {
    const { q, state } = setup();
    const w = q.process(() => tick(100).then(() => 'slow'));
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const t0 = Date.now();
    await w.close();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    expect(await state(job.id)).toBe('completed');
  });

  it('process: close timeoutMs must be a non-negative safe integer', async () => {
    const { q } = setup();
    for (const timeoutMs of [-1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
      const w = q.process(() => 1);
      const e = await w.close({ timeoutMs } as never).then(() => expect.unreachable(String(timeoutMs)), (x: unknown) => x);
      expect(e, String(timeoutMs)).toBeInstanceOf(InvalidOptionError);
      expect((e as InvalidOptionError).issues[0]!.path).toBe('timeoutMs');
      await w.close();
    }
    const w = q.process(() => 1);
    await expect(w.close({ timeoutMs: 0 })).resolves.toBeUndefined();
  });

  it('process: close while idle resolves at once', async () => {
    const { q } = setup();
    const w = q.process(() => 1);
    const t0 = Date.now();
    await w.close();
    expect(Date.now() - t0).toBeLessThan(50);
    expect(w.isRunning()).toBe(false);
  });

  it('process: queue relays worker events', async () => {
    const { q } = setup();
    const completed = vi.fn();
    const active = vi.fn();
    q.on('completed', completed);
    q.on('active', active);
    const w = q.process(() => 1);
    const done = next(w, 'completed');
    const { job } = await q.add(1);
    await done;
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]![0]).toMatchObject({ job: { id: job.id }, result: 1 });
    expect(active).toHaveBeenCalledTimes(1);
    await q.close();
    expect(w.isRunning()).toBe(false);
  });

  it('process: queue.close closes its workers with the same options first', async () => {
    const { q } = setup({ shutdownAbortGrace: 0 });
    const w = q.process(() => new Promise(() => {}));
    const started = next(w, 'active');
    await q.add(1);
    await started;
    const t0 = Date.now();
    await q.close({ timeoutMs: 30 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(w.isRunning()).toBe(false);
    expect(q.closed).toBe(true);
  });

  it('process: process and add after close throw QueueClosedError, also while close is in progress', async () => {
    const { q } = setup();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = q.process(() => gate);
    const active = next(w, 'active');
    await q.add(1);
    await active;
    const closing = q.close();
    await expect(q.add(2)).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    await expect(q.addBulk([{ data: 3 }])).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    expect(() => q.process(() => 1)).toThrow(expect.objectContaining({ code: 'QUEUE_CLOSED' }));
    open();
    await closing;
    expect(() => q.process(() => 1)).toThrow(expect.objectContaining({ code: 'QUEUE_CLOSED' }));
  });

  it('process: a thrown value that cannot be stringified still fails the job', async () => {
    const { q, state } = setup();
    const w = q.process((job) => {
      throw job.data === 'nullproto'
        ? Object.create(null)
        : {
            toString() {
              throw new TypeError('no string for you');
            },
          };
    });
    for (const data of ['nullproto', 'badToString']) {
      const failed = next(w, 'failed');
      const { job } = await q.add(data, { maxAttempts: 1 });
      await failed;
      expect(await state(job.id), data).toBe('failed');
    }
    await vi.waitFor(() => expect(w.inFlight).toBe(0));
  });
});
