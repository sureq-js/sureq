import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devDocsRoot, hasDevDocs } from '../helpers/dev-docs.js';
import * as ns from '../../src/index.js';
import {
  SureQError,
  errorCatalogue,
  PayloadTooLargeError,
  ResultTooLargeError,
  InvalidJobStateError,
  StoreFormatError,
  StoreError,
  StoreUnavailableError,
  isStoreError,
  InvalidOptionError,
  SerializationError,
  DeserializationError,
  QueueClosedError,
  WorkerClosedError,
  InternalError,
  UnrecoverableError,
  BackoffStrategyError,
  RetryIfError,
  ListenerError,
  DuplicateHandlerError,
  BulkAddError,
  StoreRequestError,
  StoreContractVersionError,
  StoreNotReadyError,
  CapabilityError,
  LeaseLostError,
  JobTimeoutError,
  JobCancelledError,
  ShutdownError,
  StalledJobError,
  PoisonPillError,
  DuplicateJobError,
  MergeConflictError,
  InvalidMergeResultError,
  JobNotFoundError,
  JobRejectedError,
  FilterError,
  AlreadySettledError,
  BatchResultMismatchError,
  ScheduleNotFoundError,
  ScheduleConflictError,
  QueueObliteratingError,
  QueueNotIdleError,
  UnsupportedRuntimeError,
} from '../../src/index.js';

const root = resolve(import.meta.dirname, '../..');
const EXPECTED_CODES = [
  'SUREQ_ERROR', 'INVALID_OPTION', 'SERIALIZATION_FAILED', 'DESERIALIZATION_FAILED', 'PAYLOAD_TOO_LARGE',
  'RESULT_TOO_LARGE', 'INVALID_JOB_STATE', 'QUEUE_CLOSED', 'WORKER_CLOSED', 'UNRECOVERABLE', 'BACKOFF_STRATEGY_ERROR',
  'RETRY_IF_ERROR', 'STORE_ERROR', 'STORE_UNAVAILABLE', 'LISTENER_ERROR', 'STORE_FORMAT_UNSUPPORTED',
  'DUPLICATE_HANDLER', 'BULK_ADD_FAILED', 'INTERNAL_ERROR',
  'STORE_BAD_REQUEST', 'STORE_CONTRACT_VERSION', 'UNSUPPORTED_CAPABILITY', 'STORE_NOT_READY', 'LEASE_LOST', 'JOB_TIMEOUT',
  'JOB_CANCELLED', 'SHUTDOWN', 'JOB_STALLED', 'POISON_PILL', 'DUPLICATE_JOB', 'MERGE_CONFLICT', 'INVALID_MERGE_RESULT',
  'JOB_NOT_FOUND', 'JOB_REJECTED', 'FILTER_ERROR', 'ALREADY_SETTLED', 'BATCH_RESULT_MISMATCH', 'SCHEDULE_NOT_FOUND',
  'SCHEDULE_CONFLICT', 'QUEUE_OBLITERATING', 'QUEUE_NOT_IDLE', 'UNSUPPORTED_RUNTIME',
];

const srcFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });

const errorClasses = (): Array<typeof SureQError> =>
  Object.values(ns).filter(
    (v): v is typeof SureQError => typeof v === 'function' && (v === SureQError || v.prototype instanceof SureQError),
  );

describe('errors (catalogue)', () => {
  it('errors: every SureQError subclass is in errorCatalogue with a unique code', () => {
    const classes = errorClasses();
    const values = Object.values(errorCatalogue);
    for (const cls of classes) {
      expect(values).toContain(cls);
      const code = new (cls as new (...a: never[]) => SureQError)(...(sampleArgs(cls) as never[])).code;
      expect(errorCatalogue[code]).toBe(cls);
    }
    expect(values.length).toBe(classes.length);
    expect(Object.keys(errorCatalogue).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it('errors: the catalogue lists 42 codes and an unsupported runtime is not retryable', () => {
    expect(Object.keys(errorCatalogue)).toHaveLength(42);
    const e = new UnsupportedRuntimeError();
    expect(e.code).toBe('UNSUPPORTED_RUNTIME');
    expect(e.message).toBe('SureQ requires Node.js; this runtime is not supported');
    expect(isStoreError(e)).toBe(false);
    expect(e).not.toHaveProperty('retryable');
  });

  it('errors: codes match /^[A-Z][A-Z0-9_]*$/', () => {
    for (const code of Object.keys(errorCatalogue)) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it.runIf(hasDevDocs)('errors: the error catalogue table in the dev docs lists every class and code in errorCatalogue', () => {
    const doc = readFileSync(join(devDocsRoot, 'docs/features/M13-config-validation-error-catalogue.md'), 'utf8');
    const rows = new Map([...doc.matchAll(/^\| `(\w+)` \| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => [m[1], m[2]]));
    for (const [code, cls] of Object.entries(errorCatalogue)) expect(rows.get(cls.name), cls.name).toBe(code);
  });

  it('errors: typed fields are top-level and mirrored into details', () => {
    const p = new PayloadTooLargeError({ size: 2, limit: 1, queue: 'q' });
    expect(p.size).toBe(2);
    expect(p.toJSON().details).toEqual({ size: 2, limit: 1, queue: 'q', field: 'data' });
    expect(p.field).toBe('data');
    const r = new ResultTooLargeError({ size: 5, limit: 4, jobId: 'j1' });
    expect([r.size, r.limit, r.jobId]).toEqual([5, 4, 'j1']);
    expect(r.toJSON().details).toEqual({ size: 5, limit: 4, jobId: 'j1' });
    const s = new InvalidJobStateError({ jobId: 'j2', state: 'active' });
    expect([s.jobId, s.state]).toEqual(['j2', 'active']);
    expect(s.toJSON().details).toEqual({ jobId: 'j2', state: 'active' });
    const f = new StoreFormatError({ reason: 'too-new', found: 2, supported: 1, recordKind: 'job', recordId: 'x' });
    expect([f.reason, f.found, f.supported, f.recordKind, f.recordId]).toEqual(['too-new', 2, 1, 'job', 'x']);
    expect(f.toJSON().details).toEqual({ reason: 'too-new', found: 2, supported: 1, recordKind: 'job', recordId: 'x' });
  });

  it('errors: StoreUnavailableError is a StoreError with retryable true', () => {
    const e = new StoreUnavailableError('down', { operation: 'claim', retryable: false, outcomeUnknown: false });
    expect(e).toBeInstanceOf(StoreError);
    expect(e.retryable).toBe(true);
    expect(e.code).toBe('STORE_UNAVAILABLE');
  });

  it('errors: isStoreError accepts a brand-carrying foreign object', () => {
    const foreign = Object.assign(Object.create({ [Symbol.for('sureq.error')]: true }), {
      code: 'STORE_ERROR', operation: 'get', retryable: true, outcomeUnknown: false,
    });
    expect(isStoreError(foreign)).toBe(true);
    expect(isStoreError(new SureQError('x'))).toBe(false);
    expect(isStoreError(new StoreError('y', { operation: 'add', retryable: false, outcomeUnknown: true }))).toBe(true);
  });

  it('errors: no bare Error is thrown from src', () => {
    for (const file of srcFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\bnew Error\(/);
      if (!file.endsWith('errors/base.ts')) expect(text, file).not.toMatch(/throw new (Type|Range)Error/);
    }
  });

  it('errors: details never contain job data, result or meta', () => {
    for (const cls of errorClasses()) {
      const err = new (cls as new (...a: never[]) => SureQError)(...(sampleArgs(cls) as never[]));
      const keys = Object.keys(err.toJSON().details ?? {});
      for (const banned of ['data', 'result', 'meta']) expect(keys, cls.name).not.toContain(banned);
    }
  });
});

describe('errors (batch, filter, schedule and admin)', () => {
  it('errors: batch, filter, schedule and admin errors carry their fields top-level and in details', () => {
    const cause = new TypeError('boom');
    const rejected = new JobRejectedError({ reason: 'too big', reasonCode: 'SIZE', details: { max: 3 }, operation: 'merge', jobId: 'j1' });
    expect(rejected).toMatchObject({ code: 'JOB_REJECTED', reason: 'too big', reasonCode: 'SIZE', operation: 'merge', jobId: 'j1' });
    expect(rejected.toJSON().details).toEqual({ reason: 'too big', reasonCode: 'SIZE', operation: 'merge', jobId: 'j1', details: { max: 3 } });
    const plain = new JobRejectedError({ reason: 'filtered', operation: 'add', jobId: null });
    expect(plain.toJSON().details).toEqual({ reason: 'filtered', operation: 'add', jobId: null });
    expect(plain.reasonCode).toBeUndefined();
    const filter = new FilterError({ timedOut: true, cause });
    expect(filter).toMatchObject({ code: 'FILTER_ERROR', timedOut: true, cause });
    expect(filter.toJSON().details).toEqual({ timedOut: true });
    expect(new FilterError({ timedOut: false }).message).not.toBe(filter.message);
    const cases: Array<[SureQError, string, Record<string, unknown>]> = [
      [new AlreadySettledError({ jobId: 'j1' }), 'ALREADY_SETTLED', { jobId: 'j1' }],
      [new BatchResultMismatchError({ expected: 3, got: 2 }), 'BATCH_RESULT_MISMATCH', { expected: 3, got: 2 }],
      [new ScheduleNotFoundError({ key: 'nightly' }), 'SCHEDULE_NOT_FOUND', { key: 'nightly' }],
      [new ScheduleConflictError({ key: 'nightly' }), 'SCHEDULE_CONFLICT', { key: 'nightly' }],
      [new QueueObliteratingError({ queue: 'emails' }), 'QUEUE_OBLITERATING', { queue: 'emails' }],
      [new QueueNotIdleError({ queue: 'emails', active: 4 }), 'QUEUE_NOT_IDLE', { queue: 'emails', active: 4 }],
    ];
    for (const [err, code, fields] of cases) {
      expect(err.code).toBe(code);
      expect(err).toMatchObject(fields);
      expect(err.toJSON().details).toEqual(fields);
    }
    expect(new QueueNotIdleError({ queue: 'emails', active: 4 }).message).toBe('Queue "emails" has 4 active job(s); stop the workers or pass force');
    expect(new ScheduleNotFoundError({ key: 'nightly' }).message).toBe('Schedule "nightly" was not found');
  });
});

/** Minimal valid constructor arguments for each catalogue class. */
function sampleArgs(cls: typeof SureQError): unknown[] {
  const store = { operation: 'add', retryable: false, outcomeUnknown: false };
  const table = new Map<unknown, unknown[]>([
    [InvalidOptionError, ['Queue "q"', [{ path: 'concurrency', code: 'invalid_value', message: 'bad' }]]],
    [PayloadTooLargeError, [{ size: 2, limit: 1, queue: 'q' }]],
    [ResultTooLargeError, [{ size: 2, limit: 1, jobId: 'SECRET-12345' }]],
    [InvalidJobStateError, [{ jobId: 'SECRET-12345', state: 'active' }]],
    [BackoffStrategyError, [{ reason: 'unknown' }]],
    [StoreError, ['m', store]],
    [StoreUnavailableError, ['m', store]],
    [ListenerError, [{ event: 'completed', cause: new SureQError('c') }]],
    [StoreFormatError, [{ reason: 'missing', found: null, supported: 1, recordKind: 'meta' }]],
    [DuplicateHandlerError, [{ jobName: 'send-email' }]],
    [BulkAddError, ['m', { jobIds: ['SECRET-12345'], cause: new SureQError('c') }]],
    [StoreRequestError, ['m', { operation: 'open' }]],
    [StoreContractVersionError, [{ core: [1, 1], store: 2 }]],
    [StoreNotReadyError, ['m', { timeoutMs: 5 }]],
    [CapabilityError, ['transactions']],
    [LeaseLostError, [{ jobId: 'SECRET-12345', token: 1, reason: 'expired' }]],
    [JobTimeoutError, [{ jobId: 'SECRET-12345', attempt: 1, timeoutMs: 1, graceMs: 1, abandoned: false }]],
    [JobCancelledError, [{ jobId: 'SECRET-12345' }]],
    [PoisonPillError, [{ jobId: 'SECRET-12345', crashCount: 3, maxCrashes: 3 }]],
    [DuplicateJobError, [{ jobId: 'SECRET-12345', existingState: 'waiting', by: 'id' }]],
    [MergeConflictError, [{ jobId: 'SECRET-12345' }]],
    [InvalidMergeResultError, [{ jobId: 'SECRET-12345' }]],
    [JobNotFoundError, [{ jobId: 'SECRET-12345' }]],
    [JobRejectedError, [{ reason: 'filtered', operation: 'add', jobId: 'SECRET-12345' }]],
    [FilterError, [{ timedOut: false }]],
    [AlreadySettledError, [{ jobId: 'SECRET-12345' }]],
    [BatchResultMismatchError, [{ expected: 2, got: 1 }]],
    [ScheduleNotFoundError, [{ key: 'SECRET-12345' }]],
    [ScheduleConflictError, [{ key: 'SECRET-12345' }]],
    [QueueObliteratingError, [{ queue: 'q' }]],
    [QueueNotIdleError, [{ queue: 'q', active: 2 }]],
  ]);
  for (const c of [SureQError, SerializationError, DeserializationError, QueueClosedError, WorkerClosedError, InternalError, UnrecoverableError, RetryIfError, ShutdownError, StalledJobError, UnsupportedRuntimeError]) {
    table.set(c, ['m']);
  }
  const args = table.get(cls);
  if (!args) throw new TypeError(`no sample args for ${cls.name}`);
  return args;
}
