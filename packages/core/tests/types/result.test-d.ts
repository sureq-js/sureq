import { expectTypeOf, test } from 'vitest';
import { Queue } from '../../src/queue/queue.js';

test('result: result is typed by Queue<Data, Result> (type test)', () => {
  const q = new Queue<{ n: number }, { ok: boolean }>('q');
  q.process(async (job) => {
    expectTypeOf(job.result).toEqualTypeOf<{ ok: boolean } | null | undefined>();
    return { ok: job.data.n > 0 };
  });
  // @ts-expect-error: handler must return the queue's Result type
  q.process(async () => 'str');
  q.on('completed', ({ result }) => {
    expectTypeOf(result).toEqualTypeOf<{ ok: boolean }>();
  });
});
