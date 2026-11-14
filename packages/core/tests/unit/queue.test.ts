'use strict';
import { describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs, stored } from '../helpers/store.js';
import { newJob, seed } from '../helpers/seed.js';

const catchErr = (fn: () => unknown): InvalidOptionError => {
  try {
    fn();
  } catch (e) {
    return e as InvalidOptionError;
  }
  throw new TypeError('expected a throw');
};
const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('queues (construction)', () => {
  it('queues: invalid queue name throws InvalidOptionError', () => {
    for (const bad of ['', 'a'.repeat(101), 'a:b', 'a/b', 'a b']) expect.soft(() => new Queue(bad, { logger: silent })).toThrow(InvalidOptionError);
    expect(catchErr(() => new Queue('a:b', { logger: silent })).issues[0]).toMatchObject({ path: 'name' });
    expect(() => new Queue('a'.repeat(100), { logger: silent })).not.toThrow();
  });

  it('ns: invalid namespace throws InvalidOptionError', () => {
    for (const bad of ['', 'n'.repeat(65), 'a:b', 'a/b', 'a b']) expect.soft(() => new Queue('q', { namespace: bad })).toThrow(InvalidOptionError);
    expect(catchErr(() => new Queue('q', { namespace: 'a/b' })).issues[0]!.path).toBe('namespace');
  });

  it('ns: default namespace is default and logs one info line', () => {
    const info = vi.fn();
    const logger = { debug() {}, info, warn() {}, error() {} };
    expect(new Queue('q', { logger }).namespace).toBe('default');
    expect(info).toHaveBeenCalledTimes(1);
    new Queue('q', { logger, namespace: 'billing-prod' });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('ns: namespace is exposed read-only on queue and job', () => {
    const q = new Queue('q', { namespace: 'billing-prod' });
    expect(q.namespace).toBe('billing-prod');
    expect(() => {
      (q as { namespace: string }).namespace = 'x';
    }).toThrow(TypeError);
  });

  it('queue: formatVersion is exposed read-only', () => {
    const q = new Queue('q', { logger: silent });
    expect(q.formatVersion).toBe(1);
    expect(() => {
      (q as { formatVersion: number }).formatVersion = 2;
    }).toThrow(TypeError);
  });


  it('config: unknown queue option names the closest valid one', () => {
    expect(() => new Queue('q', { maxPayloadByte: 1 } as never)).toThrow(/did you mean "maxPayloadBytes"/);
  });

  it('config: a bad name and bad options are reported in one error', () => {
    const e = catchErr(() => new Queue('a b', { namespace: 'x/y', maxBulkSize: 0 } as never));
    expect(e.issues.map((i) => i.path).sort()).toEqual(['maxBulkSize', 'name', 'namespace']);
  });
});

describe('queues (scoping and sharing)', () => {
  const two = () => {
    const store = new MemoryStore();
    void store.open();
    return { store, emails: new Queue('emails', { store, logger: silent }), reports: new Queue('reports', { store, logger: silent }) };
  };

  it('queues: jobs in one queue are invisible to another queue', async () => {
    const { store, emails, reports } = two();
    const [id] = await seed(emails);
    expect((await store.counts(reports.internals.scope)).waiting).toBe(0);
    expect(await stored(store, reports.internals.scope, id!)).toBeNull();
    expect(await claimJobs(store, reports.internals.scope)).toEqual([]);
  });

  it('queues: same id can exist in two queues', async () => {
    const { store, emails, reports } = two();
    await store.add(emails.internals.scope, [newJob({ id: 'shared-id' })]);
    await store.add(reports.internals.scope, [newJob({ id: 'shared-id' })]);
    expect(await stored(store, emails.internals.scope, 'shared-id')).not.toBeNull();
    expect(await stored(store, reports.internals.scope, 'shared-id')).not.toBeNull();
  });

  it('queues: names are case-sensitive', async () => {
    const store = new MemoryStore();
    const upper = new Queue('Emails', { store, logger: silent });
    const lower = new Queue('emails', { store, logger: silent });
    await seed(upper);
    expect((await store.counts(lower.internals.scope)).waiting).toBe(0);
  });

  it('queues: counts are per queue', async () => {
    const { store, emails, reports } = two();
    await seed(emails, 2);
    await seed(reports, 1);
    expect((await store.counts(emails.internals.scope)).waiting).toBe(2);
    expect((await store.counts(reports.internals.scope)).waiting).toBe(1);
  });

  it('queues: two Queue objects with same store, namespace and name share jobs', async () => {
    const store = new MemoryStore();
    const a = new Queue('emails', { store, maxBulkSize: 5, logger: silent });
    const b = new Queue('emails', { store, logger: silent });
    const [id] = await seed(a);
    expect(await stored(store, b.internals.scope, id!)).not.toBeNull();
    expect(a.internals.maxBulkSize).not.toBe(b.internals.maxBulkSize);
  });

  it('queues: same name in different namespaces are separate queues', async () => {
    const store = new MemoryStore();
    const a = new Queue('emails', { store, namespace: 'a' });
    const b = new Queue('emails', { store, namespace: 'b' });
    await seed(a);
    expect((await store.counts(b.internals.scope)).waiting).toBe(0);
  });

  it('queues: closing one queue leaves other queues and the shared store working', async () => {
    const { store, emails, reports } = two();
    await emails.close();
    await emails.close(); // idempotent
    expect(emails.closed).toBe(true);
    await seed(reports);
    expect((await store.counts(reports.internals.scope)).waiting).toBe(1);
  });

  it('queues: queue that created its private store closes it; user-supplied store stays open', async () => {
    const own = new Queue('own', { logger: silent });
    const other = new Queue('own', { logger: silent });
    expect(own.internals.ownsStore).toBe(true);
    expect(own.internals.client).not.toBe(other.internals.client); // private stores never share data
    await seed(own);
    expect((await other.getCounts()).waiting).toBe(0);
    await own.close();
    expect(own.closed).toBe(true);
    await expect(own.internals.client.store.now()).rejects.toThrow(); // its private store was closed
    const store = new MemoryStore();
    const shared = new Queue('shared', { store, logger: silent });
    expect(shared.internals.ownsStore).toBe(false);
    await shared.getCounts(); // the queue opened it
    await shared.close();
    await expect(store.counts(shared.internals.scope)).resolves.toBeDefined();
  });

  it('queues: remove never touches another queue', async () => {
    const { store, emails, reports } = two();
    await store.add(emails.internals.scope, [newJob({ id: 'r1' })]);
    await store.add(reports.internals.scope, [newJob({ id: 'r1' })]);
    expect(await store.remove(emails.internals.scope, { id: 'r1' })).toMatchObject({ removed: true });
    expect(await stored(store, reports.internals.scope, 'r1')).not.toBeNull();
  });
});
