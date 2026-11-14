'use strict';
import { describe, expect, it, vi } from 'vitest';
import { toJob, type JobBinding } from '../../src/job/job.js';
import type { JobRecord as StoreRecord } from '../../src/store/contract.js';
import { FORMAT_SUPPORT } from '../../src/format/support.js';

const rec = (over: Partial<StoreRecord> = {}): StoreRecord => ({
  formatVersion: 1, namespace: 'n', queue: 'q', id: 'j1', name: null, data: '{"a":1}', state: 'waiting', priority: 0, seq: 1,
  runAt: 1000, attempt: 0, maxAttempts: 3, crashCount: 0, lease: null, token: 0, result: null, error: null, createdAt: 1000,
  startedAt: null, finishedAt: null, workerId: null, backoff: null, timeout: null, lastFinal: null, rev: 1, dataVersion: null, idempotencyKey: null,
  uniqueWhile: 'pending', singletonKey: null, singletonHeld: false, deadLetter: null, retainUntil: null, keep: null, progress: null,
  batchProgress: null, redriveCount: 0, lastError: null, attemptsTruncated: 0, scheduleKey: null, scheduledFor: null, cancelReason: null, ...over,
});
const binding = (): JobBinding & { remove: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } => ({
  remove: vi.fn(async () => true), cancel: vi.fn(), getAttempts: vi.fn(async () => []), retry: vi.fn(async () => ({ id: 'x', status: 'redriven' as const, state: 'waiting' as const, viaDeadLetter: true })), deserialize: JSON.parse, format: FORMAT_SUPPORT,
});

const PUBLIC_KEYS = [
  'id', 'name', 'queue', 'namespace', 'state', 'priority', 'seq', 'attempt', 'maxAttempts', 'crashCount', 'createdAt',
  'runAt', 'startedAt', 'finishedAt', 'workerId', 'lease', 'token', 'data', 'result', 'error', 'failedReason', 'progress', 'batchProgress', 'idempotencyKey',
  'schedule', 'remove', 'cancel', 'getAttempts', 'deadLetter', 'redriveCount', 'lastError', 'retry', 'retainUntil',
].sort();

describe('meta (Job snapshot)', () => {
  it('idem: toJob derives the key from namespace, queue, id and seq, and returns a stored key unchanged', () => {
    expect(toJob(rec({ seq: 4 }), 2000, binding()).idempotencyKey).toBe('n:q:j1:4');
    expect(toJob(rec({ idempotencyKey: 'charge:o1' }), 2000, binding()).idempotencyKey).toBe('charge:o1');
  });

  it('meta: toJob projects the stored lease and token', () => {
    const active = rec({ state: 'active', lease: { owner: 'w', token: 7, expiresAt: 31_000, claimId: 'c' }, token: 7, attempt: 1, startedAt: 1000, workerId: 'w' });
    const job = toJob(active, 2000, binding());
    expect(job.lease).toEqual({ owner: 'w', token: 7, expiresAt: 31_000 });
    expect(job.token).toBe(7);
    expect(Object.isFrozen(job.lease)).toBe(true);
    expect(toJob(rec(), 2000, binding()).lease).toBeNull();
    expect(toJob(rec({ state: 'completed', finishedAt: 1500 }), 2000, binding()).lease).toBeNull();
  });

  it('meta: Job has no queuedMs or processedMs helpers', () => {
    const job = toJob(rec(), 1000, binding());
    expect('queuedMs' in job).toBe(false);
    expect('processedMs' in job).toBe(false);
    expect(Object.keys(job).sort()).toEqual(PUBLIC_KEYS);
  });

  it('meta: fields are read-only (assignment throws in strict mode / types forbid it)', () => {
    const job = toJob(rec(), 1000, binding());
    expect(Object.isFrozen(job)).toBe(true);
    expect(() => {
      (job as unknown as { state: string }).state = 'x';
    }).toThrow(TypeError);
  });

  it('meta: toJob applies effective state', () => {
    expect(toJob(rec({ state: 'delayed', runAt: 900 }), 1000, binding()).state).toBe('waiting');
    expect(toJob(rec({ state: 'delayed', runAt: 1100 }), 1000, binding()).state).toBe('delayed');
    expect(toJob(rec({ state: 'failed', finishedAt: 1 }), 1000, binding()).state).toBe('failed');
  });

  it('meta: toJob result mapping', () => {
    const b = binding();
    expect(toJob(rec({ result: null }), 1, b).result).toBeUndefined();
    expect(toJob(rec({ result: '0' }), 1, b).result).toBe(0);
    expect(toJob(rec({ result: 'null' }), 1, b).result).toBeNull();
    expect(toJob(rec({ result: '""' }), 1, b).result).toBe('');
    expect(toJob<{ a: number }>(rec(), 1, b).data).toEqual({ a: 1 });
  });

  it('meta: toJob remove delegates', async () => {
    const b = binding();
    const job = toJob(rec({ id: 'gone' }), 1, b);
    expect(await job.remove()).toBe(true);
    expect(b.remove).toHaveBeenCalledOnce();
    expect(b.remove).toHaveBeenCalledWith('gone');
  });

  it('dlq: toJob projects the dead-letter fields and retry delegates', async () => {
    const b = binding();
    const job = toJob(rec({ id: 'dl', state: 'failed', finishedAt: 5, deadLetter: { at: 5, reason: 'exhausted' }, redriveCount: 2, lastError: '{"v":1,"name":"E","message":"m"}' }), 9, b);
    expect([job.deadLetter, job.redriveCount, job.lastError]).toEqual([{ at: 5, reason: 'exhausted' }, 2, { v: 1, name: 'E', message: 'm' }]);
    expect(Object.isFrozen(job.deadLetter)).toBe(true);
    await job.retry({ delay: 10 });
    expect(b.retry).toHaveBeenCalledWith('dl', job.seq, { delay: 10 });
  });
});
