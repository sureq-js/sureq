import { expectTypeOf, test } from 'vitest';
import type { ErrorEvent, ErrorSource, EventOrigin, FailureReason, QueueEvents, WorkerEvents } from '../../src/events/types.js';
import type { QUEUE_EVENT_NAMES } from '../../src/events/types.js';
import type { StoreFormatError } from '../../src/errors/catalog.js';
import type { DeadLetterReason } from '../../src/store/contract.js';

test('events: payload types', () => {
  expectTypeOf<keyof QueueEvents>().toEqualTypeOf<(typeof QUEUE_EVENT_NAMES)[number]>();
  expectTypeOf<keyof WorkerEvents>().toEqualTypeOf<
    Exclude<
      (typeof QUEUE_EVENT_NAMES)[number],
      'added' | 'duplicate' | 'rejected' | 'cancelled' | 'stalled' | 'redriven' | 'cleaned' | 'obliterated' | 'storeDisconnected' | 'storeReconnected' | 'degraded' | 'versionSkew' | 'schedulePaused' | 'scheduleResumed' | 'scheduleDeleted'
      | 'scheduleFired' | 'scheduleSkipped' | 'scheduleQueued' | 'alert'
    >
  >();
  expectTypeOf<QueueEvents['schedulePaused' | 'scheduleResumed' | 'scheduleDeleted']>().toEqualTypeOf<{ key: string }>();
  expectTypeOf<QueueEvents['cleaned']>().toEqualTypeOf<{ state: 'completed' | 'failed' | 'cancelled' | 'waiting' | 'delayed'; removed: number; origin?: EventOrigin }>();
  expectTypeOf<QueueEvents['obliterated']>().toEqualTypeOf<{ removed: number; origin?: EventOrigin }>();
  expectTypeOf<QueueEvents['degraded']>().toEqualTypeOf<{ error: StoreFormatError }>();
  expectTypeOf<QueueEvents['versionSkew']>().toEqualTypeOf<{ workers: { workerId: string; sureqVersion: string }[] }>();
  expectTypeOf<QueueEvents['scheduleFired']>().toEqualTypeOf<{ key: string; scheduledFor: number; jobId: string }>();
  expectTypeOf<QueueEvents['scheduleSkipped']>().toEqualTypeOf<{ key: string; scheduledFor: number; reason: 'overlap' | 'backlog-full' }>();
  expectTypeOf<QueueEvents['scheduleQueued']>().toEqualTypeOf<{ key: string; scheduledFor: number }>();
  expectTypeOf<QueueEvents<{ id: string }, number>['completed']>().toMatchTypeOf<{ job: { id: string }; result: number; durationMs: number }>();
  expectTypeOf<QueueEvents<{ id: string }>['stalled']>().toMatchTypeOf<{ job: { id: string }; previousWorkerId: string; crashCount: number; action: 'requeued' | 'failed' }>();
  expectTypeOf<QueueEvents<{ id: string }>['cancelled']>().toEqualTypeOf<{ job: { id: string }; previousState: 'waiting' | 'delayed' | 'active'; origin?: EventOrigin }>();
  expectTypeOf<QueueEvents['rejected']>().toEqualTypeOf<{ id: string | null; reason: string; reasonCode?: string; operation: 'add' | 'replace' | 'merge' | 'schedule'; origin?: EventOrigin }>();
  expectTypeOf<QueueEvents<{ id: string }>['deadLettered']>().toEqualTypeOf<{ job: { id: string }; reason: DeadLetterReason; origin?: EventOrigin }>();
  expectTypeOf<WorkerEvents<{ id: string }>['deadLettered']>().toEqualTypeOf<QueueEvents<{ id: string }>['deadLettered']>();
  expectTypeOf<QueueEvents['redriven']>().toEqualTypeOf<{ id: string; state: 'waiting' | 'delayed'; viaDeadLetter: boolean; origin?: EventOrigin }>();
  expectTypeOf<ErrorEvent['source']>().toEqualTypeOf<ErrorSource>();
  expectTypeOf<QueueEvents['failed']['reason']>().toEqualTypeOf<FailureReason>();
});
