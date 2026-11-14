import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError, ListenerError, PayloadTooLargeError, SerializationError, StoreError } from '../../src/errors/catalog.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const setup = (opts: Record<string, unknown> = {}) => {
  const c = { t: 1_000_000 };
  const store = new MemoryStore({ clock: () => c.t });
  const queue = new Queue('mail', { store, logger: silent, ...opts });
  const scope = queue.internals.scope;
  const empty = async () => store.dump().jobs.length === 0;
  return { c, store, queue, scope, empty };
};

describe('queue.add', () => {
  it('add: new job is waiting with attempt 0, createdAt set from store time', async () => {
    const { c, store, queue, scope } = setup();
    const { job, added } = await queue.add({ to: 'a@b' });
    expect(added).toBe(true);
    expect(job).toMatchObject({ state: 'waiting', attempt: 0, createdAt: c.t, namespace: 'default', queue: 'mail', data: { to: 'a@b' } });
    expect((await stored(store, scope, job.id))!.formatVersion).toBe(1);
  });

  it('add: resolves only after the store write is durable', async () => {
    const { store, queue, scope } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realAdd = store.add.bind(store);
    vi.spyOn(store, 'add').mockImplementation(async (...args) => {
      await gate;
      return realAdd(...args);
    });
    let settled = false;
    const p = queue.add(1).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    release();
    const { job } = await p;
    expect(await stored(store, scope, job.id)).toBeDefined();
  });

  it('add: delay makes the job delayed with runAt = store now + delay', async () => {
    const { c, queue } = setup();
    const { job } = await queue.add(1, { delay: '30s' });
    expect(job).toMatchObject({ state: 'delayed', runAt: c.t + 30_000 });
  });

  it('add: name option is stored and visible on the job; invalid name throws InvalidOptionError', async () => {
    const { queue } = setup();
    expect((await queue.add(1, { name: 'send' })).job.name).toBe('send');
    expect((await queue.add(1)).job.name).toBeNull();
    await expect(queue.add(1, { name: 'a b' })).rejects.toThrow(InvalidOptionError);
  });

  it('add: add option overrides queue default; undefined option does not', async () => {
    const { queue } = setup({ defaultJobOptions: { priority: 5 } });
    expect((await queue.add(1, { priority: 1 })).job.priority).toBe(1);
    expect((await queue.add(1, { priority: undefined })).job.priority).toBe(5);
  });

  it('add: defaults are snapshotted into the stored job', async () => {
    const { store, queue, scope } = setup({ defaultJobOptions: { maxAttempts: 5, backoff: { type: 'fixed', delay: 1000 } } });
    const { job } = await queue.add(1);
    expect(await stored(store, scope, job.id)).toMatchObject({ maxAttempts: 5, backoff: { type: 'fixed', delay: 1000 } });
  });

  it('add: undefined data is stored as null', async () => {
    const { store, queue, scope } = setup();
    const { job } = await queue.add(undefined);
    expect(job.data).toBeNull();
    expect((await stored(store, scope, job.id))!.data).toBe('null');
  });

  it('add: unserializable data throws SerializationError and writes nothing', async () => {
    const { queue, empty } = setup();
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    for (const bad of [cyc, 1n, () => 1]) await expect(queue.add(bad)).rejects.toThrow(SerializationError);
    expect(await empty()).toBe(true);
  });

  it('add: oversized payload throws PayloadTooLargeError before any store call', async () => {
    const { store, queue } = setup({ maxPayloadBytes: 10 });
    const spy = vi.spyOn(store, 'add');
    await expect(queue.add('x'.repeat(20))).rejects.toThrow(PayloadTooLargeError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('add: after close throws QueueClosedError', async () => {
    const { queue, empty } = setup();
    await queue.close();
    let p: Promise<unknown> | undefined;
    expect(() => (p = queue.add(1))).not.toThrow();
    await expect(p).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    expect(await empty()).toBe(true);
  });

  it('add: added event fires once after the write; throwing listener does not reject add', async () => {
    const { store, queue, scope } = setup();
    const seen: unknown[] = [];
    queue.on('added', async ({ job }) => {
      seen.push(await stored(store, scope, job.id));
    });
    queue.on('added', () => {
      throw new TypeError('listener boom');
    });
    const errors: unknown[] = [];
    queue.on('error', (e) => void errors.push(e.error));
    const { job } = await queue.add(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: job.id });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ListenerError);
  });

  it('add: ids are unique and sort by creation time (UUIDv7)', async () => {
    const { c, queue } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      c.t += i % 3; // advancing, sometimes the same millisecond
      ids.push((await queue.add(i)).job.id);
    }
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('queue.add store failures', () => {
  const failingStore = (outcomeUnknown: boolean) => {
    const store = new MemoryStore();
    store.add = async () => {
      throw new StoreError(outcomeUnknown ? 'lost' : 'down', { operation: 'add', retryable: false, outcomeUnknown });
    };
    return store;
  };

  it('add: ambiguous store failure (outcomeUnknown) carries jobIds', async () => {
    const e = (await new Queue('q', { store: failingStore(true), logger: silent }).add(1).catch((x: unknown) => x)) as StoreError;
    expect(e).toBeInstanceOf(StoreError);
    expect(e.jobIds).toHaveLength(1);
    expect(e.jobIds![0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(e.details['jobIds']).toEqual(e.jobIds);
  });

  it('add: a definite store failure has no jobIds', async () => {
    const e = (await new Queue('q', { store: failingStore(false), logger: silent }).add(1).catch((x: unknown) => x)) as StoreError;
    expect(e).toBeInstanceOf(StoreError);
    expect(e.jobIds).toBeUndefined();
  });
});
