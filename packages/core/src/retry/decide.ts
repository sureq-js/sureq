import type { SureQError } from '../errors/base.js';
import { RetryIfError } from '../errors/catalog.js';
import type { ErrorSource, FailureReason } from '../events/types.js';
import type { Job } from '../job/job.js';
import { computeBackoff, type BackoffFn, type StoredBackoff } from './backoff.js';
import { isUnrecoverable } from './unrecoverable.js';

export type RetryIf = (err: Error, job: Job) => boolean | Promise<boolean>;

/** What `retryIf` sees for a non-Error throw: an Error named NonErrorThrown whose `cause` is the value. */
export function asRetryIfError(v: unknown): Error {
  if (v instanceof Error) return v;
  const e = Reflect.construct(Error, [typeof v === 'string' ? v : 'Non-Error value thrown', { cause: v }]) as Error;
  e.name = 'NonErrorThrown';
  return e;
}

/** A read-only copy of the job's fields, so a predicate cannot change the job it is judging. */
function snapshot(job: Job): Job {
  const plain = Object.fromEntries(Object.entries(job).filter(([, v]) => typeof v !== 'function'));
  return deepFreeze(structuredClone(plain)) as Job;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}

export type Decision = ({ action: 'retry'; delayMs: number } | { action: 'fail'; reason: FailureReason }) & {
  /** Errors the caller must report: RetryIfError (source `internal`), BackoffStrategyError (source `strategy`). */
  reports: Array<{ error: SureQError; source: ErrorSource }>;
};

/**
 * What happens after a failed attempt, rows checked top to bottom:
 * 1. unrecoverable (branded error, `ctx.fail(err, { retry: false })`, core-marked result errors) → fail;
 * 2. no attempts left → fail; 3. `ctx.fail(err, { retry: true })` → retry, skipping `retryIf`;
 * 4. `retryIf` says false → fail; 5. otherwise retry after the job's backoff.
 */
export async function decideFailure(input: {
  err: unknown;
  job: Job;
  ctxFail?: { retry: boolean };
  retryIf?: RetryIf;
  attempt: number;
  maxAttempts: number;
  unwrapCause: boolean;
  backoff: StoredBackoff;
  strategies: Readonly<Record<string, BackoffFn>>;
  random: () => number;
}): Promise<Decision> {
  const reports: Decision['reports'] = [];
  if (input.ctxFail?.retry === false || isUnrecoverable(input.err, input.unwrapCause)) return { action: 'fail', reason: 'unrecoverable', reports };
  if (input.attempt >= input.maxAttempts) return { action: 'fail', reason: 'attempts-exhausted', reports };
  if (input.ctxFail?.retry !== true) {
    const verdict = await evaluateRetryIf(input.retryIf, input.err, input.job);
    if (verdict.error) reports.push({ error: verdict.error, source: 'internal' });
    if (!verdict.retry) return { action: 'fail', reason: 'not-retryable', reports };
  }
  const b = computeBackoff(input.backoff, input.attempt, input.strategies, input.random, { error: asRetryIfError(input.err), job: input.job });
  if (b.error) reports.push({ error: b.error, source: 'strategy' });
  return { action: 'retry', delayMs: b.delayMs, reports };
}

/**
 * Ask the worker's `retryIf` whether a failed attempt may retry. Never throws: no predicate
 * means retry; a throw, rejection or non-boolean result also means retry, with a RetryIfError to report.
 */
export async function evaluateRetryIf(retryIf: RetryIf | undefined, err: unknown, job: Job): Promise<{ retry: boolean; error?: RetryIfError }> {
  if (!retryIf) return { retry: true };
  try {
    const r: unknown = await retryIf(asRetryIfError(err), snapshot(job));
    if (typeof r === 'boolean') return { retry: r };
    return { retry: true, error: new RetryIfError(`retryIf returned ${r === null ? 'null' : typeof r}, not a boolean; retrying`) };
  } catch (cause) {
    return { retry: true, error: new RetryIfError('retryIf threw; retrying', { cause }) };
  }
}
