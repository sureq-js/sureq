import { expectTypeOf, test } from 'vitest';
import type { AlertEvent, ConnectionState, HealthReport, HealthWarning, Worker } from '../../src/index.js';
import { Queue } from '../../src/queue/queue.js';

test('health: report and option types', () => {
  const q = new Queue('q');
  expectTypeOf(q.health()).resolves.toEqualTypeOf<HealthReport>();
  expectTypeOf(q.health).parameter(0).toEqualTypeOf<{ timeoutMs?: number } | undefined>();
  expectTypeOf(q.ready).parameter(0).toEqualTypeOf<{ timeoutMs?: number } | undefined>();
  expectTypeOf<HealthReport['status']>().toEqualTypeOf<'ok' | 'degraded' | 'down'>();
  expectTypeOf<HealthReport['store']['state']>().toEqualTypeOf<'connected' | 'reconnecting' | 'closed'>();
  expectTypeOf<HealthReport['store']['latencyMs']>().toEqualTypeOf<number | null>();
  expectTypeOf<HealthReport['store']['durable']>().toEqualTypeOf<boolean>();
  expectTypeOf<HealthReport['workers'][number]['state']>().toEqualTypeOf<'created' | 'running' | 'stopping' | 'stopped'>();
  expectTypeOf<HealthReport['workers'][number]['lastLoopAt']>().toEqualTypeOf<number | null>();
  expectTypeOf<HealthReport['warnings'][number]>().toEqualTypeOf<HealthWarning>();
  expectTypeOf<HealthWarning>().toEqualTypeOf<{ code: string; message: string }>();
  expectTypeOf<HealthReport['alerts']>().toEqualTypeOf<AlertEvent[]>();
  expectTypeOf<Worker['isRunning']>().returns.toEqualTypeOf<boolean>();
});

test('reconnect: connectionState has an exported type', () => {
  const q = new Queue('q');
  expectTypeOf(q.connectionState).toEqualTypeOf<ConnectionState>();
  expectTypeOf<ConnectionState>().toEqualTypeOf<'connected' | 'reconnecting' | 'closed'>();
});
