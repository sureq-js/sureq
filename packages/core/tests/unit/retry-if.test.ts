import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateRetryIf } from '../../src/retry/decide.js';
import { isSureQError } from '../../src/errors/base.js';
import { InvalidOptionError, UnrecoverableError } from '../../src/errors/catalog.js';
import { harness } from '../helpers/harness.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import type { Job } from '../../src/job/job.js';
import { poll } from '../helpers/poll.js';

const job = (): Job => ({ id: 'j1', name: null, data: { n: 1 }, attempt: 1, maxAttempts: 3 }) as unknown as Job;

afterEach(() => {
  vi.useRealTimers();
});

describe('evaluateRetryIf', () => {
  it('retryif: false makes the job fail without retry and reason not-retryable', async () => {
    expect(await evaluateRetryIf(() => false, new TypeError('x'), job())).toEqual({ retry: false });
  });

  it('retryif: true retries with backoff', async () => {
    expect(await evaluateRetryIf(() => true, new TypeError('x'), job())).toEqual({ retry: true });
  });

  it('retryif: not set retries whenever attempts remain', async () => {
    expect(await evaluateRetryIf(undefined, new TypeError('x'), job())).toEqual({ retry: true });
  });

  it('retryif: receives the thrown error and a job snapshot with attempt', async () => {
    const err = new TypeError('x');
    const original = job();
    const fn = vi.fn((_e: Error, j: Job) => {
      expect(Object.isFrozen(j)).toBe(true);
      expect(j.attempt).toBe(1);
      return true;
    });
    await evaluateRetryIf(fn, err, original);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn.mock.calls[0]![0]).toBe(err);
    const mutate = await evaluateRetryIf((_e, j) => {
      (j.data as { n: number }).n = 99;
      return false;
    }, err, original);
    expect(mutate.retry).toBe(true);
    expect(mutate.error!.code).toBe('RETRY_IF_ERROR');
    expect((original.data as { n: number }).n).toBe(1);
  });

  it('retryif: async predicate is awaited and slot stays held', async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = evaluateRetryIf(() => new Promise<boolean>((r) => setTimeout(() => r(false), 50)), new TypeError('x'), job()).then((v) => ((settled = true), v));
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ retry: false });
  });

  it('retryif: throwing predicate retries and emits error event', async () => {
    const thrown = new TypeError('cannot read status of undefined');
    const r = await evaluateRetryIf(() => {
      throw thrown;
    }, new TypeError('x'), job());
    expect(r.retry).toBe(true);
    expect(isSureQError(r.error)).toBe(true);
    expect(r.error!.code).toBe('RETRY_IF_ERROR');
    expect(r.error!.cause).toBe(thrown);
  });

  it('retryif: rejecting predicate retries and emits error event', async () => {
    const thrown = new TypeError('async boom');
    const r = await evaluateRetryIf(() => Promise.reject(thrown), new TypeError('x'), job());
    expect(r).toMatchObject({ retry: true, error: { code: 'RETRY_IF_ERROR' } });
    expect(r.error!.cause).toBe(thrown);
  });

  it('retryif: non-boolean result retries and emits error event', async () => {
    for (const v of [undefined, 0, 'no', null, 'yes']) {
      const r = await evaluateRetryIf(() => v as never, new TypeError('x'), job());
      expect(r.retry, String(v)).toBe(true);
      expect(r.error!.code).toBe('RETRY_IF_ERROR');
    }
  });

  it('retryif: non-Error throw is wrapped with cause', async () => {
    const fn = vi.fn((e: Error) => (e as { status?: number }).status === 500);
    await evaluateRetryIf(fn, 'boom', job());
    const received = fn.mock.calls[0]![0];
    expect(received).toBeInstanceOf(Error);
    expect(received.name).toBe('NonErrorThrown');
    expect(received.cause).toBe('boom');
  });

  it('retryif: non-function option throws InvalidOptionError', async () => {
    const q = new Queue('ri', { store: new MemoryStore(), logger: { debug() {}, info() {}, warn() {}, error() {} } });
    try {
      q.process(() => 1, { retryIf: 'yes' as never });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidOptionError);
      expect((e as InvalidOptionError).issues[0]!.path).toBe('retryIf');
    }
    expect(() => q.process(() => 1, { retryIf: async () => true })).not.toThrow();
    expect(() => q.process(() => 1, { retryIf: undefined })).not.toThrow();
    await q.close();
  });

  it('retryif: example policy retries 5xx and not 4xx', async () => {
    const retryIf = (e: Error) => (e as unknown as { status: number }).status >= 500;
    expect((await evaluateRetryIf(retryIf, Object.assign(new TypeError('x'), { status: 503 }), job())).retry).toBe(true);
    expect((await evaluateRetryIf(retryIf, Object.assign(new TypeError('x'), { status: 400 }), job())).retry).toBe(false);
  });
});

describe('retryIf via worker', () => {
  const queues: Queue[] = [];
  afterEach(async () => {
    await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  });
  const setup = (workerOpts: Record<string, unknown>, handler: (attempt: number) => unknown = () => Promise.reject(new TypeError('x'))) => {
    const h = harness({ queue: { defaultJobOptions: { backoff: 0 } } });
    queues.push(h.queue);
    let runs = 0;
    const w = h.queue.process((j) => (runs++, handler(j.attempt)), { ...poll(5), ...workerOpts });
    const end = new Promise<{ reason?: string; kind: string }>((r) => {
      w.once('failed', (p) => r({ kind: 'failed', reason: p.reason }));
      w.once('completed', () => r({ kind: 'completed' }));
    });
    return { ...h, w, end, runs: () => runs };
  };

  it('retryif: false makes the job fail without retry and reason not-retryable (end to end)', async () => {
    const s = setup({ retryIf: () => false });
    await s.queue.add(1, { maxAttempts: 5 });
    expect(await s.end).toMatchObject({ kind: 'failed', reason: 'not-retryable' });
    expect(s.runs()).toBe(1);
  });

  it('retryif: true retries with backoff (end to end)', async () => {
    const s = setup({ retryIf: () => true }, (attempt) => (attempt < 3 ? Promise.reject(new TypeError('x')) : 'ok'));
    await s.queue.add(1, { maxAttempts: 5 });
    expect((await s.end).kind).toBe('completed');
    expect(s.runs()).toBe(3);
  });

  it('retryif: not called on the last attempt', async () => {
    const retryIf = vi.fn(() => true);
    const s = setup({ retryIf });
    await s.queue.add(1, { maxAttempts: 3 });
    await s.end;
    expect(retryIf).toHaveBeenCalledTimes(2);
  });

  it('retryif: not called for UnrecoverableError', async () => {
    const retryIf = vi.fn(() => true);
    const s = setup({ retryIf }, () => Promise.reject(new UnrecoverableError('x')));
    await s.queue.add(1, { maxAttempts: 3 });
    await s.end;
    expect(retryIf).not.toHaveBeenCalled();
  });

  it('retryif: not called when ctx.fail forces retry true', async () => {
    const retryIf = vi.fn(() => false);
    const h = harness({ queue: { defaultJobOptions: { backoff: 0 } } });
    queues.push(h.queue);
    const w = h.queue.process((_j, ctx) => ctx.fail(new TypeError('x'), { retry: true }), { ...poll(5), retryIf });
    const failed = new Promise<{ reason: string }>((r) => w.once('failed', r as never));
    await h.queue.add(1, { maxAttempts: 3 });
    expect((await failed).reason).toBe('attempts-exhausted');
    expect(retryIf).not.toHaveBeenCalled();
  });

  it('retryif: called once per failed attempt', async () => {
    const retryIf = vi.fn(() => true);
    const s = setup({ retryIf });
    await s.queue.add(1, { maxAttempts: 4 });
    await s.end;
    expect(s.runs()).toBe(4);
    expect(retryIf).toHaveBeenCalledTimes(3);
  });

  it('retryif: async predicate is awaited and slot stays held (end to end)', async () => {
    let release!: (v: boolean) => void;
    const s = setup({ retryIf: () => new Promise<boolean>((r) => (release = r)) });
    const retrying = vi.fn();
    s.w.on('retrying', retrying);
    await s.queue.add(1, { maxAttempts: 3 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.w.inFlight).toBe(1);
    expect(retrying).not.toHaveBeenCalled();
    release(false);
    expect((await s.end).reason).toBe('not-retryable');
  });

  for (const [label, retryIf] of [
    ['throwing', () => {
      throw new TypeError('predicate bug');
    }],
    ['rejecting', () => Promise.reject(new TypeError('predicate bug'))],
    ['non-boolean', () => 'yes'],
  ] as const) {
    it(`retryif: ${label} predicate retries and emits error event (end to end)`, async () => {
      const s = setup({ retryIf }, (attempt) => (attempt < 2 ? Promise.reject(new TypeError('x')) : 'ok'));
      const error = new Promise<{ source: string; error: { code: string } }>((r) => s.w.once('error', r as never));
      await s.queue.add(1, { maxAttempts: 3 });
      expect(await error).toMatchObject({ source: 'internal', error: { code: 'RETRY_IF_ERROR' } });
      expect((await s.end).kind).toBe('completed');
    });
  }
});
