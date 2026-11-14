import { expectTypeOf, test } from 'vitest';
import type { Schedule, ScheduleDefinition, UpsertResult } from '../../src/index.js';
import { Queue } from '../../src/queue/queue.js';

test('schedule-upsert: definition types', () => {
  const q = new Queue('q');
  expectTypeOf(q.upsertSchedule<{ n: number }>('k', { every: '1m', template: { data: { n: 1 } } })).resolves.toEqualTypeOf<UpsertResult<{ n: number }>>();
  expectTypeOf<UpsertResult<{ n: number }>['schedule']['template']['data']>().toEqualTypeOf<{ n: number }>();
  expectTypeOf<Schedule['nextRunAt']>().toEqualTypeOf<number>();
  // @ts-expect-error: the schedule owns delay
  void q.upsertSchedule('k', { every: '1m', template: { data: 1, opts: { delay: 1000 } } });
  // @ts-expect-error: a singleton key is one per job, not per schedule
  void q.upsertSchedule('k', { every: '1m', template: { data: 1, opts: { singletonKey: 's' } } });
  // @ts-expect-error: cron and every together
  const both: ScheduleDefinition = { cron: '* * * * *', every: '1m', template: { data: 1 } };
  void both;
  // @ts-expect-error: wrong data type
  void q.upsertSchedule<{ n: number }>('k', { every: '1m', template: { data: { n: 'x' } } });
});
