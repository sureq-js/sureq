import { describe, expect, it, vi } from 'vitest';
import { BulkAddError, DuplicateJobError, InvalidOptionError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { fakeClock } from '../helpers/store.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function setup() {
  const { clock } = fakeClock();
  const store = new MemoryStore({ clock });
  const q = new Queue<unknown>('q', { store, logger: silent });
  const dups: unknown[] = [];
  q.on('duplicate', (e) => void dups.push(e));
  return { store, q, dups, scope: q.internals.scope };
}

describe('singleton keys through the queue', () => {
  it('singleton: second add with same key while waiting returns the first with added false', async () => {
    const { q } = setup();
    const first = (await q.add(1, { singletonKey: 'k' })).job;
    const r = await q.add(2, { singletonKey: 'k' });
    expect(r).toMatchObject({ added: false, duplicate: { action: 'ignored', existingState: 'waiting', by: 'singletonKey' } });
    expect(r.job.id).toBe(first.id);
    expect((await q.getCounts()).waiting).toBe(1);
  });

  it('singleton: onDuplicate reject throws DuplicateJobError with by singletonKey', async () => {
    const { q } = setup();
    const first = (await q.add(1, { singletonKey: 'k' })).job;
    const e = await q.add(2, { singletonKey: 'k', onDuplicate: 'reject' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DuplicateJobError);
    expect(e).toMatchObject({ jobId: first.id, existingState: 'waiting', by: 'singletonKey' });
  });

  it('singleton: duplicate event fires with by singletonKey', async () => {
    const { q, dups } = setup();
    const first = (await q.add(1, { singletonKey: 'k' })).job;
    await q.add(2, { singletonKey: 'k' });
    expect(dups).toEqual([{ id: first.id, action: 'ignored', existingState: 'waiting', by: 'singletonKey' }]);
  });

  it('singleton: id conflict wins over singleton conflict', async () => {
    const { q } = setup();
    await q.add(1, { id: 'a' });
    await q.add(2, { singletonKey: 'k' });
    const r = await q.add(3, { id: 'a', singletonKey: 'k' });
    expect(r).toMatchObject({ duplicate: { by: 'id' }, job: { id: 'a' } });
  });

  it('singleton: free id and held key is a singleton conflict', async () => {
    const { q } = setup();
    await q.add(1, { id: 'a', singletonKey: 'k' });
    const r = await q.add(2, { id: 'b', singletonKey: 'k' });
    expect(r).toMatchObject({ added: false, duplicate: { by: 'singletonKey' }, job: { id: 'a' } });
    expect(await q.getJob('b')).toBeNull();
  });

  it('singleton: replace and merge function degrade to ignored on a key conflict', async () => {
    const { q } = setup();
    await q.add('held', { id: 'a', singletonKey: 'k' });
    const fn = vi.fn((e: { data: unknown }) => e.data);
    for (const onDuplicate of ['replace' as const, fn]) {
      const r = await q.add('new', { id: 'b', singletonKey: 'k', onDuplicate });
      expect(r).toMatchObject({ added: false, duplicate: { action: 'ignored', by: 'singletonKey' }, job: { id: 'a', data: 'held' } });
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('singleton: conflicting add never modifies the holder', async () => {
    const { q, store, scope } = setup();
    await q.add('held', { id: 'a', singletonKey: 'k', priority: 3, delay: 1000 });
    const before = await store.get(scope, 'a');
    await q.add('x', { id: 'b', singletonKey: 'k', priority: 9, delay: 5, onDuplicate: 'replace' });
    expect(await store.get(scope, 'a')).toEqual(before);
  });

  it('singleton: addBulk in-call duplicates and per-input outcomes in order', async () => {
    const { q } = setup();
    const out = await q.addBulk([{ data: 1, opts: { singletonKey: 'k' } }, { data: 2, opts: { singletonKey: 'k' } }, { data: 3, opts: { singletonKey: 'o' } }]);
    expect(out).toMatchObject([
      { ok: true, added: true },
      { ok: true, added: false, duplicate: { action: 'ignored', by: 'singletonKey' } },
      { ok: true, added: true },
    ]);
  });

  it('singleton: addBulk atomic with reject writes nothing', async () => {
    const { q } = setup();
    await q.add(0, { singletonKey: 'k' });
    const before = await q.getCounts();
    const e = await q
      .addBulk([{ data: 1 }, { data: 2, opts: { singletonKey: 'k', onDuplicate: 'reject' } }], { atomic: true })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BulkAddError);
    expect((e as BulkAddError).cause).toMatchObject({ by: 'singletonKey' });
    expect(await q.getCounts()).toEqual(before);
  });

  it('singleton: invalid key throws InvalidOptionError without a store call', async () => {
    const { q, store } = setup();
    const add = vi.spyOn(store, 'add');
    for (const key of ['', 'k'.repeat(256), 42]) await expect(q.add(1, { singletonKey: key as string })).rejects.toThrow(InvalidOptionError);
    expect(add).not.toHaveBeenCalled();
    const r = await q.add(1, { singletonKey: null });
    expect(r.added).toBe(true);
    expect((await q.add(2, { singletonKey: null })).added).toBe(true);
  });
});
