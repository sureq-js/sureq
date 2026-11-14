import { describe, expect, it, vi } from 'vitest';
import { decideFailure } from '../../src/retry/decide.js';
import { BackoffStrategyError, RetryIfError, UnrecoverableError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';

const fixed100 = { type: 'fixed', delay: 100, jitter: 'none' as const };
const job = { id: 'j', name: null, data: {}, attempt: 1, maxAttempts: 3 } as unknown as Job;
const input = (over: Partial<Parameters<typeof decideFailure>[0]> = {}): Parameters<typeof decideFailure>[0] => ({
  err: new TypeError('x'),
  job,
  attempt: 1,
  maxAttempts: 3,
  unwrapCause: true,
  backoff: fixed100,
  strategies: {},
  random: () => 0.5,
  ...over,
});

describe('decideFailure (decision table)', () => {
  it('attempts: decision table order — row 1 unrecoverable', async () => {
    expect(await decideFailure(input({ err: new UnrecoverableError('x') }))).toMatchObject({ action: 'fail', reason: 'unrecoverable' });
    expect(await decideFailure(input({ ctxFail: { retry: false } }))).toMatchObject({ action: 'fail', reason: 'unrecoverable' });
  });

  it('attempts: decision table order — row 2 attempts exhausted', async () => {
    expect(await decideFailure(input({ attempt: 3 }))).toMatchObject({ action: 'fail', reason: 'attempts-exhausted' });
  });

  it('attempts: decision table order — row 3 ctx.fail retry true skips retryIf', async () => {
    const retryIf = vi.fn(() => false);
    expect(await decideFailure(input({ ctxFail: { retry: true }, retryIf }))).toMatchObject({ action: 'retry', delayMs: 100 });
    expect(retryIf).not.toHaveBeenCalled();
  });

  it('attempts: decision table order — row 4 retryIf false', async () => {
    expect(await decideFailure(input({ retryIf: () => false }))).toMatchObject({ action: 'fail', reason: 'not-retryable' });
  });

  it('attempts: decision table order — row 5 retry', async () => {
    expect(await decideFailure(input())).toEqual({ action: 'retry', delayMs: 100, reports: [] });
  });

  it('attempts: decision table order — precedence', async () => {
    expect(await decideFailure(input({ attempt: 3, err: new UnrecoverableError('x') }))).toMatchObject({ reason: 'unrecoverable' }); // 1 beats 2
    expect(await decideFailure(input({ attempt: 3, ctxFail: { retry: true } }))).toMatchObject({ reason: 'attempts-exhausted' }); // 2 beats 3
    const retryIf = vi.fn(() => true);
    expect(await decideFailure(input({ err: new UnrecoverableError('x'), retryIf }))).toMatchObject({ reason: 'unrecoverable' }); // 1 beats 4
    expect(retryIf).not.toHaveBeenCalled();
  });

  it('attempts: maxAttempts 1 never retries', async () => {
    const retryIf = vi.fn(() => true);
    const mine = vi.fn(() => 5);
    const r = await decideFailure(input({ attempt: 1, maxAttempts: 1, retryIf, backoff: { type: 'mine', delay: 1, jitter: 'none' }, strategies: { mine } }));
    expect(r).toMatchObject({ action: 'fail', reason: 'attempts-exhausted' });
    expect(retryIf).not.toHaveBeenCalled();
    expect(mine).not.toHaveBeenCalled();
  });

  it('attempts: cause chain unwrapping follows unwrapCause', async () => {
    const err = new Error('x', { cause: new UnrecoverableError('y') });
    expect(await decideFailure(input({ err }))).toMatchObject({ reason: 'unrecoverable' });
    expect(await decideFailure(input({ err, unwrapCause: false }))).toMatchObject({ action: 'retry' });
  });

  it('attempts: predicate and strategy failures are returned as reports', async () => {
    const r = await decideFailure(
      input({
        retryIf: () => {
          throw new TypeError('bad predicate');
        },
      }),
    );
    expect(r.action).toBe('retry');
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]!.error).toBeInstanceOf(RetryIfError);
    expect(r.reports[0]!.source).toBe('internal');
    const s = await decideFailure(input({ backoff: { type: 'missing', delay: 1, jitter: 'none' } }));
    expect(s).toMatchObject({ action: 'retry' });
    expect(s.reports[0]!.error).toBeInstanceOf(BackoffStrategyError);
    expect(s.reports[0]!.source).toBe('strategy');
  });

  it('attempts: backoff is not computed on fail paths', async () => {
    const mine = vi.fn(() => 5);
    const backoff = { type: 'mine', delay: 1, jitter: 'none' as const };
    await decideFailure(input({ backoff, strategies: { mine }, err: new UnrecoverableError('x') }));
    await decideFailure(input({ backoff, strategies: { mine }, attempt: 3 }));
    await decideFailure(input({ backoff, strategies: { mine }, retryIf: () => false }));
    expect(mine).not.toHaveBeenCalled();
    await decideFailure(input({ backoff, strategies: { mine } }));
    expect(mine).toHaveBeenCalledOnce();
  });
});
