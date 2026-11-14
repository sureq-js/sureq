import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, PayloadTooLargeError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { defineCapabilities } from '../../src/store/capabilities.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function setup(store = new MemoryStore(), opts: Record<string, unknown> = {}) {
  const add = vi.spyOn(store, 'add');
  const q = new Queue<unknown>('q', { store, logger: silent, ...opts });
  return { q, add, store };
}

afterEach(() => vi.restoreAllMocks());

describe('caller-supplied ids', () => {
  it('dedup: invalid id throws InvalidOptionError without a store call', async () => {
    const { q, add } = setup();
    for (const id of ['', 'a'.repeat(256), 'é'.repeat(128), 'order#7', 'order#-2', 42]) {
      await expect(q.add(1, { id: id as string }), String(id).slice(0, 10)).rejects.toThrow(InvalidOptionError);
    }
    expect(add).not.toHaveBeenCalled();
    await expect(q.add(1, { id: 'a'.repeat(255) })).resolves.toMatchObject({ added: true });
    await expect(q.add(1, { id: 'order#x7' })).resolves.toMatchObject({ added: true });

    class SmallIds extends MemoryStore {
      override readonly capabilities = defineCapabilities({ transactions: true, notify: true, limits: { maxIdBytes: 40 } });
    }
    const small = setup(new SmallIds());
    await expect(small.q.add(1, { id: 'x'.repeat(41) })).rejects.toThrow(InvalidOptionError);
    expect(small.add).not.toHaveBeenCalled();
    await expect(small.q.add(1, { id: 'x'.repeat(40) })).resolves.toMatchObject({ job: { id: 'x'.repeat(40) } });
  });

  it('dedup: id function is called once per add with the original data and its result is the job id', async () => {
    class Invoice {
      constructor(readonly n: number) {}
    }
    const data = new Invoice(7);
    const fn = vi.fn((d: Invoice) => `inv-${d.n}`);
    const q = new Queue<Invoice>('q', { logger: silent });
    const { job } = await q.add(data, { id: fn });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toBe(data);
    expect(job.id).toBe('inv-7');
  });

  it('dedup: id function result is validated like a string id', async () => {
    const { q, add } = setup();
    for (const id of ['x#9', '', 'x'.repeat(300)]) await expect(q.add(1, { id: () => id })).rejects.toThrow(InvalidOptionError);
    expect(add).not.toHaveBeenCalled();
  });

  it('dedup: throwing or non-string id function throws InvalidOptionError with cause and no store call', async () => {
    const { q, add } = setup();
    const boom = new Error('boom');
    const e = await q.add(1, { id: () => { throw boom; } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect((e as Error).cause).toBe(boom);
    for (const result of [undefined, 5, Promise.resolve('x')]) {
      await expect(q.add(1, { id: (() => result) as never })).rejects.toThrow(InvalidOptionError);
    }
    expect(add).not.toHaveBeenCalled();
  });

  it('dedup: queue-level id function applies and per-add id overrides it', async () => {
    const q = new Queue<string>('q', { id: (d) => `q-${d}`, logger: silent });
    expect((await q.add('a')).job.id).toBe('q-a');
    expect((await q.add('a', { id: 'own' })).job.id).toBe('own');
    expect((await q.add('b', { id: undefined })).job.id).toBe('q-b');
  });

  it('dedup: validation runs before duplicate handling', async () => {
    const { q, add } = setup(new MemoryStore(), { maxPayloadBytes: 10 });
    await q.add(1, { id: 'held' });
    add.mockClear();
    await expect(q.add('x'.repeat(20), { id: 'held' })).rejects.toThrow(PayloadTooLargeError);
    expect(add).not.toHaveBeenCalled();
  });
  it('dedup: two adds whose id function returns the same value are duplicates', async () => {
    const q = new Queue<{ order: number; note: string }>('q', { logger: silent, id: (d) => `order-${d.order}` });
    const first = await q.add({ order: 7, note: 'a' });
    const second = await q.add({ order: 7, note: 'b' });
    expect(first.added).toBe(true);
    expect(second).toMatchObject({ added: false, job: { id: 'order-7', data: { note: 'a' } } });
    expect((await q.getCounts()).waiting).toBe(1);
    await q.close();
  });
});
