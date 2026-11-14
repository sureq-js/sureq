import { expectTypeOf, test } from 'vitest';
import type {
  AttemptPage, AttemptRecord, DeadLetterInfo, Job, JobCancelResult, JobLease, Queue, RedriveOptions, RedriveOutcome, RedriveSummary, SerializedError,
} from '../../src/index.js';

test('meta: Job types', () => {
  expectTypeOf<Job['lease']>().toEqualTypeOf<{ readonly owner: string; readonly token: number; readonly expiresAt: number } | null>();
  expectTypeOf<Job['lease']>().toEqualTypeOf<JobLease | null>();
  expectTypeOf<Job['token']>().toEqualTypeOf<number>();
  expectTypeOf<Job['crashCount']>().toEqualTypeOf<number>();
  expectTypeOf<Job<{ a: number }, string>['data']>().toEqualTypeOf<{ a: number }>();
  expectTypeOf<ReturnType<Job<{ a: number }, string>['cancel']>>().toEqualTypeOf<Promise<JobCancelResult<Job<{ a: number }, string>>>>();
  expectTypeOf<Extract<JobCancelResult, { cancelled: false }>['state']>().toEqualTypeOf<'completed' | 'failed' | 'cancelled'>();
  expectTypeOf<ReturnType<Job['getAttempts']>>().toEqualTypeOf<Promise<AttemptRecord[]>>();
  expectTypeOf<ReturnType<Queue['getAttempts']>>().toEqualTypeOf<Promise<AttemptPage>>();
  expectTypeOf<AttemptPage['nextCursor']>().toEqualTypeOf<string | null>();
  expectTypeOf<AttemptRecord['error']>().toEqualTypeOf<SerializedError | null>();
  expectTypeOf<AttemptRecord['outcome']>().toEqualTypeOf<'running' | 'completed' | 'failed' | 'crashed' | 'cancelled' | 'released'>();
  expectTypeOf<Job['deadLetter']>().toEqualTypeOf<DeadLetterInfo | null>();
  expectTypeOf<Job['redriveCount']>().toEqualTypeOf<number>();
  expectTypeOf<Job['lastError']>().toEqualTypeOf<SerializedError | null>();
  expectTypeOf<Job['retry']>().toEqualTypeOf<(opts?: RedriveOptions) => Promise<RedriveOutcome>>();
  expectTypeOf<Queue['redrive']>().toEqualTypeOf<{ (id: string, opts?: RedriveOptions): Promise<RedriveOutcome>; (ids: string[], opts?: RedriveOptions): Promise<RedriveOutcome[]> }>();
  expectTypeOf<ReturnType<Queue['redriveAll']>>().toEqualTypeOf<Promise<RedriveSummary>>();
  expectTypeOf<Awaited<ReturnType<Queue<{ a: number }>['getDeadLetters']>>['jobs']>().toEqualTypeOf<Job<{ a: number }, unknown>[]>();
  const job = {} as Job;
  // @ts-expect-error: read-only
  job.state = 'waiting';
  // @ts-expect-error: read-only
  job.attempt = 2;
  // @ts-expect-error: read-only
  job.startedAt = 1;
});
