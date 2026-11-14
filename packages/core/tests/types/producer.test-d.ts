import { expectTypeOf, test } from 'vitest';
import { Producer, type AddOptions, type Duration, type FilterContext, type JobKeep, type Keep, type QueueClient } from '../../src/producer.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { AddResult } from '../../src/index.js';

test('producer: types accept Producer where QueueClient is expected', () => {
  const p = new Producer<{ to: string }, number>('q', { store: new MemoryStore() });
  expectTypeOf(p).toExtend<QueueClient<{ to: string }, number>>();
  expectTypeOf(new Queue<{ to: string }, number>('q')).toExtend<QueueClient<{ to: string }, number>>();
  expectTypeOf(p.add({ to: 'a' })).resolves.toEqualTypeOf<AddResult<{ to: string }, number>>();
  // @ts-expect-error: wrong payload type
  void p.add({ to: 1 });
  const needsQueue = (q: Queue) => q.name;
  // @ts-expect-error: a producer is not a queue
  needsQueue(new Producer('q', { store: new MemoryStore() }));
  // @ts-expect-error: store is required
  void new Producer('q', {});
});

test('producer: process and startScheduler are absent from the public types', () => {
  const p = new Producer('q', { store: new MemoryStore() });
  // @ts-expect-error: no workers on a producer
  void p.process;
  // @ts-expect-error: no scheduler on a producer
  void p.startScheduler;
  // @ts-expect-error: no alerts on a producer
  void p.getAlerts;
  // @ts-expect-error: worker-side events are not offered
  p.on('completed', () => {});
  p.on('added', (e) => void expectTypeOf(e.job.id).toEqualTypeOf<string>());
  p.on('duplicate', () => {});
  p.on('error', () => {});
  // @ts-expect-error: a producer emits no cancelled event (only a queue tells its workers)
  p.on('cancelled', () => {});
});

test('producer: the events a producer emits are offered, with the filter operation typed', () => {
  const p = new Producer('q', { store: new MemoryStore() });
  p.on('rejected', (e) => void expectTypeOf(e.operation).toEqualTypeOf<FilterContext['operation']>());
  p.on('redriven', (e) => void expectTypeOf(e.viaDeadLetter).toEqualTypeOf<boolean>());
  p.on('cleaned', (e) => void expectTypeOf(e.removed).toEqualTypeOf<number>());
  p.on('obliterated', (e) => void expectTypeOf(e.removed).toEqualTypeOf<number>());
  p.on('storeDisconnected', () => {});
  p.on('storeReconnected', (e) => void expectTypeOf(e.downForMs).toEqualTypeOf<number>());
  for (const name of ['schedulePaused', 'scheduleResumed', 'scheduleDeleted'] as const) p.on(name, (e) => void expectTypeOf(e.key).toEqualTypeOf<string>());
});

test('producer: the types its add options name are exported from the producer entry', () => {
  expectTypeOf<NonNullable<NonNullable<AddOptions['keep']>['failed']>>().toEqualTypeOf<JobKeep>();
  expectTypeOf<Keep>().toEqualTypeOf<boolean | number | { count?: number; age?: Duration }>();
});
