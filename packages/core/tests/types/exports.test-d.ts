import { expectTypeOf, test } from 'vitest';
import type {
  FormatReason, Jitter, JobDefaults, LeaseOptions, Listener, NameData, NameResult, PollingOptions, Producer, ProducerEvent, Queue, QueueBase, QueueOptions, ReconnectOptions, RecordKind, SerializeOptions, StoreErrorOptions, StoredBackoff, TimeoutOptions,
} from '../../src/index.js';
import type * as Main from '../../src/index.js';
import type * as ProducerEntry from '../../src/producer.js';

type Names = { email: { data: { to: string }; result: { id: string } }; ping: { data: number } };

test('exports: option building blocks are nameable and fit the options they belong to', () => {
  expectTypeOf<JobDefaults>().toExtend<NonNullable<QueueOptions['defaultJobOptions']>>();
  expectTypeOf<ReconnectOptions>().toExtend<NonNullable<QueueOptions['reconnect']>>();
  expectTypeOf<LeaseOptions>().toBeObject();
  expectTypeOf<PollingOptions>().toBeObject();
  expectTypeOf<TimeoutOptions>().toBeObject();
  expectTypeOf<SerializeOptions>().toEqualTypeOf<{ maxErrorBytes: number; storeStacks: boolean }>();
  expectTypeOf<StoreErrorOptions['operation']>().toEqualTypeOf<string>();
  expectTypeOf<Jitter>().toEqualTypeOf<'none' | 'full' | 'equal'>();
  expectTypeOf<StoredBackoff['jitter']>().toEqualTypeOf<Jitter>();
  expectTypeOf<FormatReason>().toEqualTypeOf<'too-new' | 'too-old' | 'missing'>();
  expectTypeOf<RecordKind>().toEqualTypeOf<'job' | 'attempt' | 'schedule' | 'settings' | 'meta'>();
});

test('exports: name map helpers, listener and producer events are nameable', () => {
  expectTypeOf<NameData<Names, 'email'>>().toEqualTypeOf<{ to: string }>();
  expectTypeOf<NameResult<Names, 'email'>>().toEqualTypeOf<{ id: string }>();
  expectTypeOf<NameResult<Names, 'ping'>>().toEqualTypeOf<unknown>();
  expectTypeOf<Listener<number, string, 'completed'>>().toBeFunction();
  expectTypeOf<'added'>().toExtend<ProducerEvent>();
  expectTypeOf<Producer>().toExtend<QueueBase<unknown, unknown, ProducerEvent>>();
  expectTypeOf<Queue>().toExtend<QueueBase>();
});

test('exports: source entry points do not re-export internal helpers (the published declarations are guarded by the API report)', () => {
  // @ts-expect-error: internal
  type _A = Main.QueueInternals;
  // @ts-expect-error: internal
  type _B = Main.WorkerHost;
  // @ts-expect-error: internal
  type _C = Main.FaultHooks;
  // @ts-expect-error: internal
  type _D = Main.StoreSnapshot;
  // @ts-expect-error: internal
  type _E = Main.IsTyped<object>;
  // @ts-expect-error: internal
  type _F = Main.Batching;
  // @ts-expect-error: internal
  type _G = Main.Polling;
  // @ts-expect-error: internal
  type _H = ProducerEntry.QueueInternals;
  expectTypeOf<ProducerEntry.QueueBase>().toEqualTypeOf<Main.QueueBase>();
  expectTypeOf<ProducerEntry.ProducerEvent>().toEqualTypeOf<Main.ProducerEvent>();
});
