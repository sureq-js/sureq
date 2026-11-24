import { describe, expect, it } from 'vitest';
import { isSureQError } from '../../src/errors/base.js';
import { InvalidMergeResultError } from '../../src/errors/catalog.js';
import { Producer } from '../../src/producer.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';

// A merge function that throws: add() rejects with InvalidMergeResultError carrying the thrown value as `cause`,
// the same as addBulk, so callers that branch on SureQ codes see it. Before 1.0.3 the raw value escaped.
describe('a throwing merge function (regression)', () => {
  const thrown: unknown[] = [new Error('boom'), 'str', { odd: true }];

  for (const kind of ['queue', 'producer'] as const) {
    it.each(thrown)(`regression: ${kind}.add wraps a thrown %o in InvalidMergeResultError`, async (value) => {
      const store = new MemoryStore();
      const q = new Queue('merge', { store, logger: silent });
      const client = kind === 'queue' ? q : new Producer('merge', { store, logger: silent });
      await q.add({ a: 1 }, { id: 'x' });
      const err: unknown = await client.add({ a: 2 }, { id: 'x', onDuplicate: () => { throw value; } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidMergeResultError);
      expect(isSureQError(err) && err.code).toBe('INVALID_MERGE_RESULT');
      expect((err as InvalidMergeResultError).cause).toBe(value);
      expect((await q.getJob('x'))?.data).toEqual({ a: 1 });
      if (client !== q) await client.close();
      await q.close();
    });
  }

  it('regression: addBulk (plain and atomic) still reports InvalidMergeResultError with the cause', async () => {
    const q = new Queue('merge-bulk', { store: new MemoryStore(), logger: silent });
    await q.add({ a: 1 }, { id: 'x' });
    const boom = new Error('boom');
    const [r] = await q.addBulk([{ data: { a: 2 }, opts: { id: 'x', onDuplicate: () => { throw boom; } } }]);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_MERGE_RESULT', cause: boom } });
    const atomic: unknown = await q.addBulk([{ data: { a: 3 }, opts: { id: 'x', onDuplicate: () => { throw boom; } } }], { atomic: true }).catch((e: unknown) => e);
    expect(atomic).toMatchObject({ code: 'BULK_ADD_FAILED' });
    expect(isSureQError((atomic as { cause?: unknown }).cause) && (atomic as { cause: { code: string } }).cause.code).toBe('INVALID_MERGE_RESULT');
    expect((await q.getJob('x'))?.data).toEqual({ a: 1 });
    await q.close();
  });
});
