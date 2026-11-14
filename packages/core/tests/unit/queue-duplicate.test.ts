import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuplicateJobError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import type { NewJob } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs, fakeClock } from '../helpers/store.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function setup(opts: Record<string, unknown> = {}) {
  const { c, clock } = fakeClock();
  const store = new MemoryStore({ clock });
  const q = new Queue<unknown>('q', { store, logger: silent, ...opts });
  const dups: unknown[] = [];
  q.on('duplicate', (e) => void dups.push(e));
  return { c, store, q, dups, scope: q.internals.scope };
}

afterEach(() => vi.restoreAllMocks());

describe('duplicate ids through the queue', () => {
  it('dedup: add with new id returns added true', async () => {
    const { q } = setup();
    const r = await q.add(1, { id: 'a' });
    expect(r.added).toBe(true);
    expect(r).not.toHaveProperty('duplicate');
  });

  it('dedup: ignore returns existing job and added false', async () => {
    const { q } = setup();
    await q.add('first', { id: 'a' });
    const r = await q.add('second', { id: 'a' });
    expect(r).toMatchObject({ added: false, duplicate: { action: 'ignored', existingState: 'waiting', by: 'id' } });
    expect(r.job.data).toBe('first');
  });

  it('dedup: replace result reports replaced', async () => {
    const { q } = setup({ defaultJobOptions: { priority: 5 } });
    await q.add('first', { id: 'a', priority: 9 });
    const r = await q.add('second', { id: 'a', onDuplicate: 'replace' });
    expect(r).toMatchObject({ added: false, duplicate: { action: 'replaced', existingState: 'waiting', by: 'id' } });
    expect(r.job.data).toBe('second');
    expect(r.job.priority).toBe(9);
    expect((await q.add('third', { id: 'a', priority: 1, onDuplicate: 'replace' })).job.priority).toBe(1);
  });

  it('dedup: reject throws DuplicateJobError', async () => {
    const { q } = setup();
    await q.add(1, { id: 'a', delay: 1000 });
    const e = await q.add(2, { id: 'a', onDuplicate: 'reject' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DuplicateJobError);
    expect(e).toMatchObject({ jobId: 'a', existingState: 'delayed', by: 'id' });
    const qr = setup({ onDuplicate: 'reject' }).q;
    await qr.add(1, { id: 'a' });
    await expect(qr.add(2, { id: 'a' })).rejects.toThrow(DuplicateJobError);
  });

  it('dedup: duplicate event fires once per duplicate including reject', async () => {
    const { q, dups } = setup();
    const added = vi.fn();
    q.on('added', added);
    q.on('duplicate', () => {
      throw new Error('listener');
    });
    await q.add(1, { id: 'a' });
    expect(dups).toEqual([]);
    await q.add(2, { id: 'a' });
    await q.add(3, { id: 'a', onDuplicate: 'replace' });
    await expect(q.add(4, { id: 'a', onDuplicate: 'reject' })).rejects.toThrow(DuplicateJobError);
    expect(dups).toEqual([
      { id: 'a', action: 'ignored', existingState: 'waiting', by: 'id' },
      { id: 'a', action: 'replaced', existingState: 'waiting', by: 'id' },
      { id: 'a', action: 'rejected', existingState: 'waiting', by: 'id' },
    ]);
    expect(added).toHaveBeenCalledTimes(1);
  });

  it('dedup: pending id is free again after the job finished', async () => {
    const { q, store, scope } = setup();
    const first = (await q.add(1, { id: 'x' })).job;
    const [job] = await claimJobs(store, scope);
    await store.complete(scope, { id: 'x', token: job!.token, result: null });
    const again = await q.add(2, { id: 'x' });
    expect(again.added).toBe(true);
    expect(again.job.seq).toBeGreaterThan(first.seq);
    expect(await q.getJob(`x#${first.seq}`)).toBeNull();
    expect((await q.getJob('x'))?.state).toBe('waiting');
    expect((await q.getCounts()).completed).toBe(0);
  });

  it('dedup: replace through the queue never sends a queue default as a caller value', async () => {
    const { q, store } = setup({ defaultJobOptions: { maxAttempts: 7 } });
    const add = vi.spyOn(store, 'add');
    await q.add(1, { id: 'a', priority: 2, onDuplicate: 'replace' });
    const sent = add.mock.calls[0]![1][0]!;
    expect(sent.defaulted).toEqual(['maxAttempts', 'backoff']);
    expect(sent).toMatchObject({ priority: 2, maxAttempts: 7, onDuplicate: 'replace', uniqueWhile: 'pending' });
    expect(sent).not.toHaveProperty('singletonKey');
    expect(sent).not.toHaveProperty('name');
    expect(sent).not.toHaveProperty('delayMs');
  });

  it('dedup: store add is given no undefined-valued keys', async () => {
    const { q, store } = setup();
    const add = vi.spyOn(store, 'add');
    await q.add(1);
    await q.add(1, { id: 'b', name: 'n', delay: 10, singletonKey: null, idempotencyKey: 'k', first: true, onDuplicate: () => 2 });
    const sent = add.mock.calls.map((c) => c[1][0]!);
    for (const job of sent) for (const [k, v] of Object.entries(job)) expect(v, k).not.toBeUndefined();
    expect(sent[1]).toMatchObject({ name: 'n', delayMs: 10, singletonKey: null, idempotencyKey: 'k', first: true, onDuplicate: 'ignore' });
    expect((sent[0] as NewJob).defaulted).toEqual(['priority', 'maxAttempts', 'backoff']);
  });
});
