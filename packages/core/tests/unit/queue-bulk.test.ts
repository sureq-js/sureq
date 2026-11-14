import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs, stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { BulkAddError, CapabilityError, DuplicateJobError, InvalidOptionError, PayloadTooLargeError, StoreError } from '../../src/errors/catalog.js';
import { defineCapabilities } from '../../src/store/capabilities.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const queue = (name: string, opts: Record<string, unknown> = {}) => new Queue(name, { logger: silent, ...opts });

describe('queue.addBulk', () => {
  it('bulk: empty input resolves empty array without store call', async () => {
    const store = new MemoryStore();
    const spy = vi.spyOn(store, 'add');
    await expect(queue('q', { store }).addBulk([])).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('bulk: items that are not an array throw InvalidOptionError, not a TypeError', async () => {
    const q = queue('q-items');
    for (const items of ['abc', null, { length: 1 }, 42]) {
      await expect(q.addBulk(items as never)).rejects.toMatchObject({
        code: 'INVALID_OPTION', issues: [expect.objectContaining({ path: 'items', code: 'invalid_type' })],
      });
    }
  });

  it('bulk: above maxBulkSize throws InvalidOptionError', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({ data: i }));
    await expect(queue('q').addBulk(items)).rejects.toThrow(InvalidOptionError);
    await expect(queue('q2').addBulk(items.slice(0, 1000))).resolves.toHaveLength(1000);
    await expect(queue('q3', { maxBulkSize: 2 }).addBulk(items.slice(0, 3))).rejects.toThrow(InvalidOptionError);
    expect(() => queue('q4', { maxBulkSize: Number.MAX_SAFE_INTEGER + 1 })).toThrow(InvalidOptionError);
  });

  it('bulk: unknown call option is rejected', async () => {
    await expect(queue('q').addBulk([{ data: 1 }], { atomik: true } as never)).rejects.toThrow(/did you mean "atomic"/);
    await expect(queue('q').addBulk([{ data: 1 }], { atomic: 'yes' } as never)).rejects.toThrow(InvalidOptionError);
  });

  it('bulk: atomic as a queue default and per-input atomic are rejected', async () => {
    expect(() => queue('q', { defaultJobOptions: { atomic: true } as never })).toThrow(InvalidOptionError);
    await expect(queue('q').addBulk([{ data: 1, opts: { atomic: true } as never }])).resolves.toMatchObject([{ ok: false }]);
  });

  const setup = (opts: Record<string, unknown> = {}) => {
    const store = new MemoryStore();
    const q = queue('bulk', { store, ...opts });
    const scope = q.internals.scope;
    const empty = async () => store.dump().jobs.length === 0;
    return { store, q, scope, empty };
  };
  const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => expect.unreachable('resolved'), (e: unknown) => e);

  it('bulk: returns one outcome per input in input order', async () => {
    const { q } = setup();
    const outcomes = await q.addBulk([0, 1, 2, 3, 4].map((data) => ({ data })));
    outcomes.forEach((o, i) => expect(o.ok && o.job.data).toBe(i));
    expect(new Set(outcomes.map((o) => o.ok && o.job.id)).size).toBe(5);
  });

  it('bulk: non-atomic reports invalid input in its slot and adds the rest', async () => {
    const { store, q, scope } = setup();
    const outcomes = await q.addBulk([0, 1, 2, 3, 4].map((data) => ({ data, ...(data === 2 && { opts: { priority: 1.5 } }) })));
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, false, true, true]);
    expect(!outcomes[2]!.ok && outcomes[2]!.error).toBeInstanceOf(InvalidOptionError);
    expect((await store.counts(scope)).waiting).toBe(4);
  });

  it('bulk: non-atomic keeps successful jobs when others are rejected', async () => {
    const { store, q, scope } = setup({ maxPayloadBytes: 10 });
    const outcomes = await q.addBulk([{ data: 'x'.repeat(50) }, { data: 1 }, { data: 2 }]);
    expect(outcomes.map((o) => o.ok)).toEqual([false, true, true]);
    expect((await store.counts(scope)).waiting).toBe(2);
  });

  it('payload: addBulk non-atomic puts the error in that slot only', async () => {
    const { q } = setup({ maxPayloadBytes: 10 });
    const outcomes = await q.addBulk([{ data: 1 }, { data: 'x'.repeat(50) }]);
    expect(outcomes[0]!.ok).toBe(true);
    const bad = outcomes[1]!;
    expect(!bad.ok && bad.error).toBeInstanceOf(PayloadTooLargeError);
    expect(!bad.ok && bad.error).toMatchObject({ size: 52, limit: 10 });
  });

  it('payload: addBulk atomic with one oversized input writes nothing', async () => {
    const { q, empty } = setup({ maxPayloadBytes: 10 });
    const e = (await caught(q.addBulk([{ data: 1 }, { data: 2 }, { data: 'x'.repeat(50) }], { atomic: true }))) as BulkAddError;
    expect(e).toBeInstanceOf(BulkAddError);
    expect(e.index).toBe(2);
    expect(e.cause).toBeInstanceOf(PayloadTooLargeError);
    expect(await empty()).toBe(true);
  });

  it('bulk: atomic with one invalid input rejects with BulkAddError index and writes nothing', async () => {
    const { q, empty } = setup();
    const e = (await caught(q.addBulk([{ data: 0 }, { data: 1, opts: { priority: 1.5 } }, { data: 2 }], { atomic: true }))) as BulkAddError;
    expect(e).toMatchObject({ code: 'BULK_ADD_FAILED', index: 1 });
    // Refused before any id was assigned: nothing to check in the store.
    expect(e.jobIds).toEqual([]);
    expect(e.cause).toBeInstanceOf(InvalidOptionError);
    expect(await empty()).toBe(true);
  });

  it('bulk: atomic success returns only ok:true entries', async () => {
    const { q } = setup();
    const outcomes = await q.addBulk([{ data: 0 }, { data: 1 }, { data: 2 }], { atomic: true });
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it('bulk: added event fires only for jobs actually added', async () => {
    const { q } = setup();
    const seen: unknown[] = [];
    q.on('added', ({ job }) => void seen.push(job.data));
    await q.addBulk([{ data: 'a' }, { data: 'b', opts: { priority: 1.5 } }, { data: 'c' }]);
    expect(seen).toEqual(['a', 'c']);
    seen.length = 0;
    await caught(q.addBulk([{ data: 'a' }, { data: 'b', opts: { priority: 1.5 } }], { atomic: true }));
    expect(seen).toEqual([]);
  });

  it('bulk: atomic add is all-or-nothing under injected failure at every position', async () => {
    const store = new MemoryStore({
      faults: {
        before: (op) => {
          if (op === 'add') throw new StoreError('down', { operation: 'add', retryable: true, outcomeUnknown: false });
        },
      },
    });
    const q = queue('bulk', { store });
    await expect(q.addBulk([{ data: 1 }, { data: 2 }, { data: 3 }], { atomic: true })).rejects.toThrow();
    expect(store.dump().jobs).toEqual([]);
  });

  const storeFailing = (outcomeUnknown: boolean) => {
    const store = new MemoryStore();
    store.add = async () => {
      throw new StoreError('lost', { operation: 'add', retryable: false, outcomeUnknown });
    };
    return store;
  };

  it('bulk: ambiguous store failure rejects with BulkAddError carrying all jobIds', async () => {
    const e = (await caught(queue('q', { store: storeFailing(true) }).addBulk([{ data: 1 }, { data: 2 }]))) as BulkAddError;
    expect(e).toBeInstanceOf(BulkAddError);
    expect(e.jobIds).toHaveLength(2);
    expect(e.cause).toBeInstanceOf(StoreError);
  });

  it('bulk: a definite store failure rethrows the store error unchanged', async () => {
    const e = await caught(queue('q', { store: storeFailing(false) }).addBulk([{ data: 1 }]));
    expect(e).toBeInstanceOf(StoreError);
    expect(e).not.toBeInstanceOf(BulkAddError);
  });

  it('bulk: ids are assigned before the store call and match the stored jobs', async () => {
    const seen: string[] = [];
    const store = new MemoryStore();
    const orig = store.add.bind(store);
    store.add = async (scope, jobs) => {
      seen.push(...jobs.map((j) => j.id));
      return orig(scope, jobs);
    };
    const outcomes = await queue('q', { store }).addBulk([{ data: 1 }, { data: 2 }, { data: 3 }]);
    expect(outcomes.map((o) => o.ok && o.job.id)).toEqual(seen);
  });

  const claimData = async (s: ReturnType<typeof setup>) =>
    (await claimJobs(s.store, s.scope, { workerId: 'w', limit: 100, order: s.q.internals.order })).map((r) => JSON.parse(r.data as string) as unknown);
  const okJob = (o: { ok: boolean }) => (o as unknown as { job: { id: string; state: string } }).job;

  it('defaults: addBulk applies defaults per item', async () => {
    const s = setup({ defaultJobOptions: { priority: 5 } });
    const outcomes = await s.q.addBulk([{ data: 'a' }, { data: 'b', opts: { priority: 0 } }]);
    const prios = await Promise.all(outcomes.map(async (o) => (await stored(s.store, s.scope, okJob(o).id))!.priority));
    expect(prios).toEqual([5, 0]);
  });

  it('delay: addBulk mixes delayed and immediate jobs', async () => {
    const { q } = setup();
    const outcomes = await q.addBulk([{ data: 1 }, { data: 2, opts: { delay: '10s' } }]);
    expect(outcomes.map((o) => okJob(o).state)).toEqual(['waiting', 'delayed']);
  });

  it('priority: first in addBulk reverses the bulk order', async () => {
    const withFirst = setup();
    await withFirst.q.addBulk(['a', 'b', 'c'].map((data) => ({ data, opts: { first: true } })));
    expect(await claimData(withFirst)).toEqual(['c', 'b', 'a']);
    const plain = setup();
    await plain.q.addBulk(['a', 'b', 'c'].map((data) => ({ data })));
    expect(await claimData(plain)).toEqual(['a', 'b', 'c']);
  });

  it('order: lifo addBulk runs last input first', async () => {
    const s = setup({ order: 'lifo' });
    await s.q.addBulk(['a', 'b', 'c'].map((data) => ({ data })));
    expect(await claimData(s)).toEqual(['c', 'b', 'a']);
  });

  it('bulk: 1000 inputs get strictly increasing seq in input order', async () => {
    const s = setup();
    const outcomes = await s.q.addBulk(Array.from({ length: 1000 }, (_, i) => ({ data: i })));
    const seqs = await Promise.all(outcomes.map(async (o) => (await stored(s.store, s.scope, okJob(o).id))!.seq));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it('bulk: closed queue throws QueueClosedError', async () => {
    const q = queue('q');
    await q.close();
    await expect(q.addBulk([{ data: 1 }])).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    await expect(q.addBulk([])).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
  });

  const watched = (opts: Record<string, unknown> = {}) => {
    const s = setup(opts);
    const events = { added: 0, duplicate: 0 };
    s.q.on('added', () => void events.added++);
    s.q.on('duplicate', () => void events.duplicate++);
    return { ...s, events };
  };

  it('dedup: addBulk returns per-input outcomes in order with in-batch duplicates', async () => {
    const { q, events } = watched();
    const out = await q.addBulk([{ data: 1, opts: { id: 'a' } }, { data: 2, opts: { id: 'a' } }, { data: 3, opts: { id: 'b' } }]);
    expect(out).toMatchObject([
      { ok: true, added: true, job: { id: 'a', data: 1 } },
      { ok: true, added: false, duplicate: { action: 'ignored', by: 'id', existingState: 'waiting' }, job: { id: 'a', data: 1 } },
      { ok: true, added: true, job: { id: 'b' } },
    ]);
    expect(events).toEqual({ added: 2, duplicate: 1 });
  });

  it('dedup: addBulk non-atomic reject duplicate fills that slot with DuplicateJobError', async () => {
    const { q, events } = watched();
    await q.add(0, { id: 'a' });
    const out = await q.addBulk([{ data: 1, opts: { id: 'x' } }, { data: 2, opts: { id: 'a', onDuplicate: 'reject' } }, { data: 3, opts: { id: 'y' } }]);
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect((out[1] as { error: unknown }).error).toBeInstanceOf(DuplicateJobError);
    expect(events).toEqual({ added: 3, duplicate: 1 });
  });

  it('dedup: addBulk atomic with a reject duplicate writes nothing', async () => {
    const { q, events } = watched();
    await q.add(0, { id: 'a' });
    const before = await q.getCounts();
    const e = (await caught(
      q.addBulk([{ data: 1, opts: { id: 'x' } }, { data: 2, opts: { id: 'a', onDuplicate: 'reject' } }, { data: 3 }], { atomic: true }),
    )) as BulkAddError;
    expect(e).toBeInstanceOf(BulkAddError);
    expect(e.index).toBe(1);
    expect(e.cause).toBeInstanceOf(DuplicateJobError);
    expect(e.jobIds).toHaveLength(3);
    expect(e.jobIds.slice(0, 2)).toEqual(['x', 'a']);
    expect(await q.getCounts()).toEqual(before);
    expect(events).toEqual({ added: 1, duplicate: 0 });
  });

  it('dedup: addBulk atomic with ignore duplicate adds the rest', async () => {
    const { q } = watched();
    await q.add(0, { id: 'a' });
    const out = await q.addBulk([{ data: 1, opts: { id: 'x' } }, { data: 2, opts: { id: 'a' } }], { atomic: true });
    expect(out).toMatchObject([{ ok: true, added: true }, { ok: true, added: false, duplicate: { action: 'ignored' } }]);
  });

  it('dedup: addBulk with id function reports a bad input in its own slot', async () => {
    const { q } = watched();
    const items = [{ data: 1, opts: { id: () => 'ok-1' } }, { data: 2, opts: { id: () => 'bad#1' } }, { data: 3 }];
    const out = await q.addBulk(items);
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect((out[1] as { error: unknown }).error).toBeInstanceOf(InvalidOptionError);
    const e = (await caught(watched().q.addBulk(items, { atomic: true }))) as BulkAddError;
    expect(e).toMatchObject({ index: 1 });
  });

  it('bulk: atomic on store without transactions throws CapabilityError and writes nothing', async () => {
    class NoTx extends MemoryStore {
      override readonly capabilities = defineCapabilities({ transactions: false });
    }
    const store = new NoTx();
    const add = vi.spyOn(store, 'add');
    const q = queue('q', { store });
    await expect(q.addBulk([{ data: 1 }], { atomic: true })).rejects.toThrow(CapabilityError);
    expect(add).not.toHaveBeenCalled();
    await expect(q.addBulk([{ data: 1 }])).resolves.toMatchObject([{ ok: true, added: true }]);
  });
});
