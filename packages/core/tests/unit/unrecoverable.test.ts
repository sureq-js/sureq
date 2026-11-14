import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUnrecoverable } from '../../src/retry/unrecoverable.js';
import { UnrecoverableError } from '../../src/errors/catalog.js';
import { isSureQError } from '../../src/errors/base.js';
import type { Queue } from '../../src/queue/queue.js';
import type { JobHandler } from '../../src/worker/worker.js';
import { harness } from '../helpers/harness.js';
import { getJobVia } from '../helpers/get-job.js';
import { poll } from '../helpers/poll.js';

describe('isUnrecoverable', () => {
  it('unrecoverable: detected across a second module copy', () => {
    const foreign = Object.assign(new Error('x'), { [Symbol.for('sureq.unrecoverable')]: true });
    expect(isUnrecoverable(foreign, true)).toBe(true);
    expect(isUnrecoverable(foreign, false)).toBe(true);
  });

  it('unrecoverable: plain Error with code UNRECOVERABLE is not unrecoverable', () => {
    expect(isUnrecoverable(Object.assign(new Error('x'), { code: 'UNRECOVERABLE' }), true)).toBe(false);
  });

  it('unrecoverable: wrapped inside a cause is detected by default and not detected with unwrapCause false', () => {
    const e = new Error('outer', { cause: new UnrecoverableError('inner') });
    expect(isUnrecoverable(e, true)).toBe(true);
    expect(isUnrecoverable(e, false)).toBe(false);
    expect(isUnrecoverable(new Error('a', { cause: new Error('b', { cause: new UnrecoverableError() }) }), true)).toBe(true);
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(isUnrecoverable(a, true)).toBe(false);
  });

  it('unrecoverable: UnrecoverableError defaults and non-Error inputs', () => {
    const u = new UnrecoverableError();
    expect(u.message).toBe('Unrecoverable error');
    expect(u.code).toBe('UNRECOVERABLE');
    expect(isSureQError(u)).toBe(true);
    expect(isUnrecoverable(u, false)).toBe(true);
    for (const v of ['x', null, undefined, 42]) expect(isUnrecoverable(v, true)).toBe(false);
  });
});

describe('unrecoverable via worker', () => {
  const queues: Queue[] = [];
  afterEach(async () => {
    await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  });
  /** Run one job (maxAttempts 5, instant retries) until it ends; count handler runs and events. */
  const run = async (handler: JobHandler, workerOpts: Record<string, unknown> = {}, queueOpts: Record<string, unknown> = {}) => {
    const h = harness({ queue: { defaultJobOptions: { backoff: 0 }, ...queueOpts } });
    queues.push(h.queue);
    let runs = 0;
    const w = h.queue.process((job, ctx) => (runs++, handler(job, ctx)), { ...poll(5), ...workerOpts });
    const retrying = vi.fn();
    w.on('retrying', retrying);
    const end = new Promise<{ kind: string; reason?: string }>((r) => {
      w.once('failed', (p) => r({ kind: 'failed', reason: p.reason }));
      w.once('completed', () => r({ kind: 'completed' }));
    });
    const { job } = await h.queue.add(1, { maxAttempts: 5 });
    const e = await end;
    return { ...e, runs, retrying, job: (await getJobVia(h.queue, job.id))! };
  };

  it('unrecoverable: throwing UnrecoverableError fails the job without retry', async () => {
    const r = await run(() => {
      throw new UnrecoverableError('bad input');
    });
    expect(r).toMatchObject({ kind: 'failed', runs: 1 });
    expect(r.retrying).not.toHaveBeenCalled();
  });

  it('unrecoverable: remaining attempts are unused and attempt count stays', async () => {
    const r = await run(() => {
      throw new UnrecoverableError('x');
    });
    expect(r.job).toMatchObject({ state: 'failed', attempt: 1, maxAttempts: 5 });
  });

  it('unrecoverable: retryIf and backoff are not invoked', async () => {
    const retryIf = vi.fn(() => true);
    const mine = vi.fn(() => 0);
    const r = await run(() => {
      throw new UnrecoverableError('x');
    }, { retryIf, backoffStrategies: { mine } }, { defaultJobOptions: { backoff: { type: 'mine' } } });
    expect(r.kind).toBe('failed');
    expect(retryIf).not.toHaveBeenCalled();
    expect(mine).not.toHaveBeenCalled();
  });

  it('unrecoverable: failed event has reason unrecoverable', async () => {
    expect((await run(() => Promise.reject(new UnrecoverableError('x')))).reason).toBe('unrecoverable');
  });

  it('unrecoverable: ctx.fail with retry false fails immediately and stores the original error', async () => {
    const r = await run((_j, ctx) => ctx.fail(new TypeError('x'), { retry: false }));
    expect(r).toMatchObject({ kind: 'failed', reason: 'unrecoverable', runs: 1 });
    expect(r.job.failedReason!.name).toBe('TypeError');
  });

  it('unrecoverable: ctx.fail without option follows normal retry rules', async () => {
    const r = await run((_j, ctx) => ctx.fail(new TypeError('x')));
    expect(r).toMatchObject({ kind: 'failed', reason: 'attempts-exhausted', runs: 5 });
  });

  it('unrecoverable: ctx.fail retry true skips retryIf but respects maxAttempts', async () => {
    const retryIf = vi.fn(() => false);
    const r = await run((_j, ctx) => ctx.fail(new TypeError('x'), { retry: true }), { retryIf });
    expect(r).toMatchObject({ kind: 'failed', reason: 'attempts-exhausted', runs: 5 });
    expect(retryIf).not.toHaveBeenCalled();
  });

  it('unrecoverable: cause chain is kept in failedReason', async () => {
    const r = await run(() => {
      throw new UnrecoverableError('outer', { cause: new RangeError('root cause') });
    });
    expect(r.job.failedReason!.cause).toMatchObject({ name: 'RangeError', message: 'root cause' });
  });

  it('unrecoverable: on the last attempt reason is unrecoverable not attempts-exhausted', async () => {
    const r = await run((job) => {
      throw job.attempt === 5 ? new UnrecoverableError('last') : new TypeError('retry me');
    });
    expect(r).toMatchObject({ reason: 'unrecoverable', runs: 5 });
  });

  it('unrecoverable: oversized result fails the job with reason unrecoverable, no retrying event, handler runs once', async () => {
    const r = await run(() => 'x'.repeat(100), {}, { maxResultBytes: 10 });
    expect(r).toMatchObject({ reason: 'unrecoverable', runs: 1 });
    expect(r.retrying).not.toHaveBeenCalled();
  });

  it('unrecoverable: unserializable result fails the job with reason unrecoverable, no retrying event, handler runs once', async () => {
    const r = await run(() => 10n);
    expect(r).toMatchObject({ reason: 'unrecoverable', runs: 1 });
    expect(r.retrying).not.toHaveBeenCalled();
  });

  it('unrecoverable: wrapped inside a cause is retried end to end with unwrapCause false', async () => {
    const wrapped = () => {
      throw new TypeError('lib', { cause: new UnrecoverableError('inner') });
    };
    expect(await run(wrapped)).toMatchObject({ reason: 'unrecoverable', runs: 1 });
    expect(await run(wrapped, { unwrapCause: false })).toMatchObject({ reason: 'attempts-exhausted', runs: 5 });
  });
});
