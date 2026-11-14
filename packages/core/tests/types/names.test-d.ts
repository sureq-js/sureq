import { expectTypeOf, test } from 'vitest';
import { Queue, type HandlerMap } from '../../src/queue/queue.js';
import type { Job } from '../../src/job/job.js';
import type { AddResult } from '../../src/index.js';

type Names = {
  'send-email': { data: { to: string }; result: { id: string } };
  resize: { data: { url: string } };
};

test('names: type map gives typed data and result for add and process (type test)', () => {
  const q = new Queue<unknown, unknown, Names>('q');
  expectTypeOf(q.add({ to: 'a' }, { name: 'send-email' })).resolves.toEqualTypeOf<AddResult<{ to: string }, { id: string }>>();
  void q.add({ url: 'u' }, { name: 'resize' });
  // @ts-expect-error: wrong data for the name
  void q.add({ url: 1 }, { name: 'resize' });
  // @ts-expect-error: unknown name
  void q.add({ to: 'a' }, { name: 'nope' });
  q.process({
    'send-email': async (job) => {
      expectTypeOf(job).toEqualTypeOf<Job<{ to: string }, { id: string }>>();
      return { id: job.data.to };
    },
    resize: (job) => {
      expectTypeOf(job.data).toEqualTypeOf<{ url: string }>();
    },
  });
  // @ts-expect-error: must return { id: string }
  const wrongReturn: NonNullable<HandlerMap<Names>['send-email']> = async () => 5;
  q.process({ 'send-email': wrongReturn });
});

test('names: add(name, data) and process(name, handler) do not type-check (type test)', () => {
  const q = new Queue<unknown, unknown, Names>('q');
  // @ts-expect-error: no add(name, data) shape
  void q.add('send-email', { to: 'x' });
  // @ts-expect-error: no process(name, handler) shape
  q.process('send-email', async () => {});
  const plain = new Queue<{ n: number }, string>('p');
  void plain.add({ n: 1 }, { name: 'any-string' });
  plain.process({ whatever: (job) => job.id });
  // @ts-expect-error: no process(name, handler) shape on an untyped queue either
  plain.process('a', () => 'x');
});
