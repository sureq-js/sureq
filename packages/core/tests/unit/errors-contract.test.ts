import { describe, expect, it } from 'vitest';
import {
  CapabilityError,
  DuplicateJobError,
  InvalidMergeResultError,
  JobCancelledError,
  JobNotFoundError,
  JobTimeoutError,
  LeaseLostError,
  MergeConflictError,
  PoisonPillError,
  ShutdownError,
  StalledJobError,
  StoreContractVersionError,
  StoreError,
  StoreNotReadyError,
  StoreRequestError,
  UnrecoverableError,
  errorCatalogue,
  isStoreError,
  isUnrecoverable,
} from '../../src/index.js';

/** An error with a code and a JSON form. */
type CodedError = Error & { code: string; toJSON(): { details?: Record<string, unknown>; code: string; name: string } };
/** One error, the typed fields it must carry, and its code. */
type FieldCase = [error: CodedError, fields: Record<string, unknown>, code: string];

describe('errors (store contract and worker safety)', () => {
  it('errors: new classes carry their typed fields top-level and mirrored into details', () => {
    const cases: FieldCase[] = [
      [new LeaseLostError({ jobId: 'j', token: 3, reason: 'expired' }), { jobId: 'j', token: 3, reason: 'expired' }, 'LEASE_LOST'],
      [new JobTimeoutError({ jobId: 'j', attempt: 2, timeoutMs: 10, graceMs: 5, abandoned: true }), { jobId: 'j', attempt: 2, timeoutMs: 10, graceMs: 5, abandoned: true }, 'JOB_TIMEOUT'],
      [new JobCancelledError({ jobId: 'j' }), { jobId: 'j' }, 'JOB_CANCELLED'],
      [new PoisonPillError({ jobId: 'j', crashCount: 3, maxCrashes: 3 }), { jobId: 'j', crashCount: 3, maxCrashes: 3 }, 'POISON_PILL'],
      [new DuplicateJobError({ jobId: 'j', existingState: 'waiting', by: 'singletonKey' }), { jobId: 'j', existingState: 'waiting', by: 'singletonKey' }, 'DUPLICATE_JOB'],
      [new MergeConflictError({ jobId: 'j' }), { jobId: 'j' }, 'MERGE_CONFLICT'],
      [new InvalidMergeResultError({ jobId: 'j' }), { jobId: 'j' }, 'INVALID_MERGE_RESULT'],
      [new JobNotFoundError({ jobId: 'j' }), { jobId: 'j' }, 'JOB_NOT_FOUND'],
      [new CapabilityError('transactions'), { capability: 'transactions' }, 'UNSUPPORTED_CAPABILITY'],
    ];
    for (const [err, fields, code] of cases) {
      for (const [k, v] of Object.entries(fields)) expect((err as unknown as Record<string, unknown>)[k], `${err.name}.${k}`).toEqual(v);
      expect(err.toJSON().details).toEqual(fields);
      expect(err.code).toBe(code);
      expect(err.toJSON().code).toBe(code);
      expect(err.name).toBe(err.constructor.name);
    }
    const v = new StoreContractVersionError({ core: [1, 1], store: 2 });
    expect(v.toJSON().details).toMatchObject({ core: [1, 1], store: 2 });
    expect(new ShutdownError().code).toBe('SHUTDOWN');
    expect(new StalledJobError().code).toBe('JOB_STALLED');
  });

  it('errors: PoisonPillError is an UnrecoverableError and is never retried', () => {
    const e = new PoisonPillError({ jobId: 'j', crashCount: 3, maxCrashes: 3 });
    expect(e).toBeInstanceOf(UnrecoverableError);
    expect(isUnrecoverable(e)).toBe(true);
    expect(e.code).toBe('POISON_PILL');
    expect(errorCatalogue.POISON_PILL).toBe(PoisonPillError);
  });

  it('errors: store error subclasses are StoreErrors with the right retryable and outcomeUnknown', () => {
    const bad = new StoreRequestError('bad', { operation: 'claim', jobId: 'j' });
    expect(bad).toBeInstanceOf(StoreError);
    expect([bad.retryable, bad.outcomeUnknown, bad.operation, bad.jobId]).toEqual([false, false, 'claim', 'j']);
    const v = new StoreContractVersionError({ core: [1, 1], store: 2 });
    expect(v).toBeInstanceOf(StoreError);
    expect(v.core).toEqual([1, 1]);
    expect(v.store).toBe(2);
    expect(v.message).toContain('2');
    expect(v.message).toContain('1');
    expect([v.retryable, v.outcomeUnknown, v.operation]).toEqual([false, false, 'open']);
    const cause = new TypeError('root');
    const n = new StoreNotReadyError('not ready', { timeoutMs: 5, cause });
    expect([n.retryable, n.outcomeUnknown, n.operation, n.cause]).toEqual([true, false, 'ready', cause]);
    expect(n.toJSON().details).toMatchObject({ timeoutMs: 5 });
  });

  it('errors: isStoreError accepts the new store error classes', () => {
    expect(isStoreError(new StoreRequestError('x', { operation: 'add' }))).toBe(true);
    expect(isStoreError(new StoreContractVersionError({ core: [1, 1], store: 2 }))).toBe(true);
    expect(isStoreError(new StoreNotReadyError('x'))).toBe(true);
    expect(isStoreError(new CapabilityError('transactions'))).toBe(false);
  });

  it('errors: CapabilityError names the capability', () => {
    const e = new CapabilityError('transactions');
    expect(e.capability).toBe('transactions');
    expect(e.message).toContain('transactions');
    expect(new CapabilityError('transactions', 'custom').message).toBe('custom');
  });
});
