import { describe, expect, it, vi } from 'vitest';
import { StoreContractVersionError, StoreUnavailableError } from '../../src/errors/catalog.js';
import { clientFor } from '../../src/store/client.js';
import { SUPPORTED_CONTRACT_VERSIONS } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import { silent } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';
import { SCOPE, claimReq } from '../helpers/store.js';

const READS = ['now', 'get', 'list', 'counts', 'isPaused'] as const;
const WRITES = ['add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'setPaused'] as const;

describe('StoreClient', () => {
  it('contract: core refuses a store with unsupported contractVersion with StoreContractVersionError', async () => {
    const raw = new MemoryStore();
    Object.defineProperty(raw, 'contractVersion', { value: 3 });
    const open = vi.spyOn(raw, 'open');
    const e = await clientFor(raw).open().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreContractVersionError);
    expect(e).toMatchObject({ store: 3, core: [...SUPPORTED_CONTRACT_VERSIONS] });
    await expect(clientFor(raw).open()).rejects.toBe(e);
    expect(open).not.toHaveBeenCalled();
  });

  it('contract: a store built for 0.3 (contract version 2) is refused directly and through a queue', async () => {
    const raw = new MemoryStore();
    Object.defineProperty(raw, 'contractVersion', { value: 2 });
    const open = vi.spyOn(raw, 'open');
    await expect(clientFor(raw).open()).rejects.toMatchObject({ name: 'StoreContractVersionError', store: 2, core: [1, 1] });
    const other = new MemoryStore();
    Object.defineProperty(other, 'contractVersion', { value: 2 });
    const queue = new Queue('v2', { store: other, logger: silent });
    await expect(queue.ready()).rejects.toBeInstanceOf(StoreContractVersionError);
    await expect(queue.add({ n: 1 })).rejects.toBeInstanceOf(StoreContractVersionError);
    expect(other.dump()).toEqual({ meta: {}, jobs: [], attempts: [], tombstones: [], schedules: [] });
    expect(open).not.toHaveBeenCalled();
    await queue.close();
  });

  it('contract: raw driver errors from a store are wrapped as StoreUnavailableError', async () => {
    const throwing = spyStore(new MemoryStore(), {
      claim: () => Promise.reject('boom'),
      get: () => {
        throw undefined;
      },
    }).store;
    const c = clientFor(throwing);
    const e = (await c.call('claim', SCOPE, claimReq()).catch((x: unknown) => x)) as StoreUnavailableError;
    expect(e).toBeInstanceOf(StoreUnavailableError);
    expect(e).toMatchObject({ operation: 'claim', outcomeUnknown: true, retryable: true, message: "Store operation 'claim' failed" });
    expect(e.cause).toBe('boom');
    const g = (await c.call('get', SCOPE, 'x').catch((x: unknown) => x)) as StoreUnavailableError;
    expect(g).toBeInstanceOf(StoreUnavailableError);
    expect(g.outcomeUnknown).toBe(false);
    expect(g.cause).toBeUndefined();
  });

  it('contract: store SureQError passes through unchanged', async () => {
    const own = new StoreUnavailableError('down', { operation: 'renew', retryable: true, outcomeUnknown: false });
    const { store } = spyStore(new MemoryStore(), { renew: () => Promise.reject(own) });
    await expect(clientFor(store).call('renew', SCOPE, { id: 'x', token: 1, leaseMs: 1000 })).rejects.toBe(own);
  });

  it('contract: wrapped writes have outcomeUnknown true and reads false', async () => {
    for (const [ops, unknown] of [[READS, false], [WRITES, true]] as const) {
      for (const op of ops) {
        const { store } = spyStore(new MemoryStore(), { [op]: () => Promise.reject(new TypeError(op)) });
        const c = clientFor(store) as unknown as { call(op: string, ...a: unknown[]): Promise<unknown> };
        const e = await c.call(op, SCOPE, {}).catch((x: unknown) => x);
        expect(e, op).toBeInstanceOf(StoreUnavailableError);
        expect((e as StoreUnavailableError).outcomeUnknown, op).toBe(unknown);
      }
    }
  });

  it('contract: clientFor returns one client per store object', () => {
    const s = new MemoryStore();
    expect(clientFor(s)).toBe(clientFor(s));
    expect(clientFor(s)).not.toBe(clientFor(new MemoryStore()));
  });

  it('contract: concurrent open calls share one store open and a failed open can be retried', async () => {
    const shared = spyStore(new MemoryStore());
    await Promise.all([clientFor(shared.store).open(), clientFor(shared.store).open()]);
    expect(shared.calls.filter((c) => c.op === 'open')).toHaveLength(1);

    const raw = new MemoryStore();
    let fail = true;
    const flaky = spyStore(raw, { open: () => (fail ? Promise.reject(new Error('down')) : raw.open()) });
    const c = clientFor(flaky.store);
    const e = await c.open().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreUnavailableError);
    expect(((e as Error).cause as Error).message).toBe('down');
    fail = false;
    await expect(c.open()).resolves.toBeUndefined();
    expect(flaky.calls.filter((x) => x.op === 'open')).toHaveLength(2);
  });

  it('contract: queue closes only a store it created', async () => {
    const owned = spyStore(new MemoryStore());
    const c = clientFor(owned.store);
    c.attach(false);
    c.attach(false);
    c.attach(true);
    await c.open();
    await c.close();
    await c.close();
    expect(owned.calls.filter((x) => x.op === 'close')).toHaveLength(0);
    await c.close();
    expect(owned.calls.filter((x) => x.op === 'close')).toHaveLength(1);

    const shared = spyStore(new MemoryStore());
    const s = clientFor(shared.store);
    s.attach(false);
    s.attach(false);
    await s.open();
    await s.close();
    await s.close();
    await s.close();
    expect(shared.calls.filter((x) => x.op === 'close')).toHaveLength(0);
  });
});
