import { expectTypeOf, test } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { TaskFailure, type AddOptions, type AddResult, type BatchResults, type BatchWorker } from '../../src/index.js';
import type { Job } from '../../src/job/job.js';

test('add: types reject wrong payload at compile time', () => {
  const q = new Queue<{ to: string }, number>('q');
  // @ts-expect-error: wrong payload type
  void q.add({ to: 1 });
  expectTypeOf(q.add({ to: 'a' })).resolves.toEqualTypeOf<AddResult<{ to: string }, number>>();
  expectTypeOf<AddResult<unknown, unknown>['added']>().toEqualTypeOf<boolean>();
  expectTypeOf<NonNullable<AddResult['duplicate']>['action']>().toEqualTypeOf<'ignored' | 'replaced' | 'merged'>();
  expectTypeOf<AddResult<{ to: string }, number>['job']>().toEqualTypeOf<Job<{ to: string }, number>>();
});

test('dedup: AddOptions id takes a function of the data and merge functions see read-only values', () => {
  expectTypeOf<(d: { n: number }) => string>().toExtend<NonNullable<AddOptions<{ n: number }>['id']>>();
  expectTypeOf<'order-1'>().toExtend<NonNullable<AddOptions<{ n: number }>['id']>>();
  type Merge = Extract<NonNullable<AddOptions<{ n: number }>['onDuplicate']>, (...a: never[]) => unknown>;
  expectTypeOf<Parameters<Merge>[0]>().toEqualTypeOf<Readonly<Job<{ n: number }>>>();
  expectTypeOf<Parameters<Merge>[1]>().toEqualTypeOf<Readonly<{ n: number }>>();
  const q = new Queue<{ n: number }>('q', { id: (d) => `n-${d.n}` });
  void q.add({ n: 1 }, { id: (d) => `x-${d.n}`, onDuplicate: (e, i) => ({ n: e.data.n + i.n }) });
  // @ts-expect-error: the id function gets the queue's data type
  void q.add({ n: 1 }, { id: (d: string) => d });
});

test('filter: the filter gets the queue data type', () => {
  void new Queue<{ a: number }>('q', { filter: (d, ctx) => (d.a > 0 ? true : { reject: `bad ${ctx.operation}`, code: 'E1' }) });
  void new Queue<{ a: number }>('q', { filter: async (d) => d.a > 0 });
  // @ts-expect-error: the filter gets the queue's data type
  void new Queue<{ a: number }>('q', { filter: (_d: string) => true });
});

test('batch: processBatch types the batch, its jobs and the results', () => {
  const q = new Queue<{ to: string }, number>('q');
  const w = q.processBatch(async (batch, ctx) => {
    expectTypeOf(batch.id).toEqualTypeOf<string>();
    expectTypeOf(batch.jobs[0]!.data).toEqualTypeOf<{ to: string }>();
    expectTypeOf(batch.jobs[0]!.signal).toEqualTypeOf<AbortSignal>();
    expectTypeOf(batch.jobs[0]!.cancelled).toEqualTypeOf<boolean>();
    expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
    return batch.jobs.map((j, i) => (i === 0 ? new TaskFailure(new Error('x'), { retry: false }) : j.data.to.length));
  }, { batchSize: 10, batchDelay: '50ms' });
  expectTypeOf(w).toEqualTypeOf<BatchWorker<{ to: string }, number>>();
  expectTypeOf(w.batch.flush()).resolves.toEqualTypeOf<number>();
  expectTypeOf<BatchResults<number>>().toEqualTypeOf<ReadonlyArray<number | TaskFailure>>();
  // @ts-expect-error: batchSize is required
  q.processBatch(async () => {}, {});
  // @ts-expect-error: a result of the wrong type
  q.processBatch(async () => ['x'], { batchSize: 2 });
});
