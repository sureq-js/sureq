import { expectTypeOf, test } from 'vitest';
import { defineCapabilities, type StoreCapabilities } from '../../src/index.js';

test('capabilities: StoreCapabilities lists the six current flags, the later flags and limits', () => {
  expectTypeOf<keyof StoreCapabilities>().toEqualTypeOf<
    'transactions' | 'skipLocked' | 'notify' | 'ttl' | 'durable' | 'shared' | 'claimConstraints' | 'boundedAdd' | 'flows' |
    'logs' | 'archive' | 'audit' | 'metricsHistory' | 'changeFeed' | 'externalTransaction' | 'migrations' | 'singleNode' |
    'patch' | 'deadlines' | 'queueRecords' | 'limits'
  >();
  expectTypeOf<StoreCapabilities['ttl']>().toEqualTypeOf<boolean>();
  expectTypeOf<StoreCapabilities['limits']>().toEqualTypeOf<{ readonly maxIdBytes: number; readonly maxClaimLimit: number }>();
  expectTypeOf(defineCapabilities).returns.toEqualTypeOf<StoreCapabilities>();
  defineCapabilities({});
  defineCapabilities({ limits: { maxIdBytes: 64 } });
  // @ts-expect-error a flag is boolean
  defineCapabilities({ transactions: 1 });
  // @ts-expect-error a limit is a number
  defineCapabilities({ limits: { maxIdBytes: '64' } });
});
