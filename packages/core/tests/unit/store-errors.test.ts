import { describe, expect, it } from 'vitest';
import { wrapStoreError } from '../../src/errors/store.js';
import { isStoreError } from '../../src/index.js';
import { InvalidOptionError, StoreError, StoreUnavailableError } from '../../src/errors/catalog.js';
import { serializeError } from '../../src/serialize/error.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { failing } from '../helpers/faults.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('store error wrapping', () => {
  it('storeerr: arbitrary store exception becomes StoreError with operation and cause', () => {
    const boom = new TypeError('boom');
    const e = wrapStoreError('claim', boom) as StoreError;
    expect(e).toBeInstanceOf(StoreError);
    expect(e).toMatchObject({ operation: 'claim', message: "Store operation 'claim' failed" });
    expect(e.cause).toBe(boom);
    for (const raw of ['str', undefined]) {
      const w = wrapStoreError('claim', raw) as StoreError;
      expect(w.message).toBe("Store operation 'claim' failed");
      expect(w.cause).toBe(raw);
    }
    const known = new InvalidOptionError('x', []);
    expect(wrapStoreError('claim', known)).toBe(known);
  });

  it('storeerr: wrapped flags follow the operation', () => {
    expect(wrapStoreError('add', new TypeError('x'))).toMatchObject({ retryable: true, outcomeUnknown: true });
    expect(wrapStoreError('get', new TypeError('x'))).toMatchObject({ retryable: true, outcomeUnknown: false });
    expect((wrapStoreError('complete', new TypeError('x'), 'job-1') as StoreError).jobId).toBe('job-1');
  });

  it('storeerr: every store write fails outcome-unknown and no read does', () => {
    const writes = [
      'add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'setPaused', 'clean', 'obliterate', 'redrive',
      'setProgress', 'registerWorker', 'heartbeatWorker', 'unregisterWorker', 'purgeWorkers', 'ensureNamespaceMeta', 'putSchedule', 'deleteSchedule',
      'fireSchedule',
    ];
    const reads = ['now', 'get', 'list', 'counts', 'isPaused', 'stats', 'getAttempts', 'listWorkers', 'getNamespaceMeta', 'getSchedule', 'listSchedules', 'listDueSchedules'];
    for (const op of writes) expect(wrapStoreError(op, new TypeError('x')), op).toMatchObject({ outcomeUnknown: true });
    for (const op of reads) expect(wrapStoreError(op, new TypeError('x')), op).toMatchObject({ outcomeUnknown: false });
  });

  it('storeerr: any foreign store error becomes StoreUnavailableError with retryable true', () => {
    for (const raw of [Object.assign(new TypeError('net'), { code: 'ECONNRESET' }), new TypeError('x'), 'str', undefined]) {
      const e = wrapStoreError('claim', raw);
      expect(e).toBeInstanceOf(StoreUnavailableError);
      expect(e).toMatchObject({ code: 'STORE_UNAVAILABLE', retryable: true });
    }
  });

  it('storeerr: add rejects with StoreUnavailableError', async () => {
    const store = new MemoryStore({ faults: failing((op) => (op === 'add' ? new TypeError('x') : undefined)) });
    const q = new Queue('q', { store, logger: silent });
    const e = (await q.add({}).catch((x: unknown) => x)) as StoreError;
    expect(e).toBeInstanceOf(StoreError);
    expect(e).toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'add', outcomeUnknown: true });
    expect(e.jobIds).toHaveLength(1);
    await q.close();
    // A wrapped write has an unknown outcome, so addBulk reports it as BulkAddError with the store error as cause.
    // A fresh store: the failed add above left that one reconnecting, where addBulk is refused before it is sent.
    const bulkStore = new MemoryStore({ faults: failing((op) => (op === 'add' ? new TypeError('x') : undefined)) });
    const bq = new Queue('q', { store: bulkStore, logger: silent });
    const b = (await bq.addBulk([{ data: 1 }]).catch((x: unknown) => x)) as Error;
    await bq.close();
    expect(b).toMatchObject({ code: 'BULK_ADD_FAILED', cause: { code: 'STORE_UNAVAILABLE', operation: 'add' } });
  });

  it('storeerr: isStoreError works on an error from another module copy', () => {
    expect(isStoreError(Object.assign(new Error('x'), { [Symbol.for('sureq.error')]: true, code: 'STORE_ERROR' }))).toBe(true);
    expect(isStoreError(Object.assign(new Error('x'), { [Symbol.for('sureq.error')]: true, code: 'STORE_UNAVAILABLE' }))).toBe(true);
    expect(isStoreError(new Error('x'))).toBe(false);
    expect(isStoreError(new StoreError('x', { operation: 'get', retryable: false, outcomeUnknown: false }))).toBe(true);
  });

  it('storeerr: repeating complete or fail with the same token is idempotent', async () => {
    const store = new MemoryStore();
    const q = new Queue('q', { store, logger: silent });
    const scope = q.internals.scope;
    await q.addBulk([{ data: 1 }, { data: 2 }]);
    const [a, b] = await claimJobs(store, scope, { workerId: 'w', limit: 2, order: 'fifo' });
    expect(await store.complete(scope, { id: a!.id, token: a!.lease!.token, result: null })).toEqual({ ok: true, now: expect.any(Number) });
    expect(await store.complete(scope, { id: a!.id, token: a!.lease!.token, result: null })).toEqual({ ok: true, now: expect.any(Number), repeated: true });
    const error = JSON.stringify(serializeError(new TypeError('x'), { maxErrorBytes: 16_384, storeStacks: false }));
    expect(await store.fail(scope, { id: b!.id, token: b!.lease!.token, error })).toMatchObject({ ok: true });
    expect(await store.fail(scope, { id: b!.id, token: b!.lease!.token, error })).toMatchObject({ ok: true, repeated: true });
  });

  it('errors: store exceptions that are not SureQError are wrapped as StoreUnavailableError', async () => {
    const store = new MemoryStore({ faults: failing((op) => (op === 'get' ? new TypeError('boom') : undefined)) });
    const e = await new Queue('q', { store, logger: silent }).getJob('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreUnavailableError);
    expect(((e as StoreError).cause as Error).message).toBe('boom');
  });
});
