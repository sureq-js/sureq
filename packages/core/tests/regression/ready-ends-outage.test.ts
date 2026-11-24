import { describe, expect, it } from 'vitest';
import { Producer } from '../../src/producer.js';
import { Queue } from '../../src/queue/queue.js';
import { silent } from '../helpers/harness.js';
import { outageStore } from '../helpers/outage.js';

// Store down at start-up, then back: once ready() resolves the queue is connected and adds go through, without
// waiting for the reconnect prober's next backoff probe (up to reconnect.maxDelay). Before 1.0.3, ready() resolved
// while still 'reconnecting' and add() failed with STORE_UNAVAILABLE until the probe.
describe('ready() after a start-up outage (regression)', () => {
  it('regression: queue.ready() ends a start-up outage; add() and health() work at once', () => afterOutage('queue'));
  it('regression: producer.ready() ends a start-up outage; add() and health() work at once', () => afterOutage('producer'));
});

async function afterOutage(kind: 'queue' | 'producer'): Promise<void> {
  const { store, ctl } = outageStore();
  ctl.down = true;
  // A long backoff makes the old behaviour obvious: the probe would not come for about 60 s.
  const opts = { store, logger: silent, reconnect: { initialDelay: '60s', maxDelay: '60s' } } as const;
  const client = kind === 'queue' ? new Queue('ready', opts) : new Producer('ready', opts);
  const reconnected: number[] = [];
  // both classes emit storeReconnected; one handle keeps the overloads apart for the type checker
  (client as unknown as Queue).on('storeReconnected', () => void reconnected.push(Date.now()));
  expect((await client.health({ timeoutMs: 50 })).ready).toBe(false);
  expect(client.connectionState).toBe('reconnecting');

  ctl.down = false;
  await client.ready({ timeoutMs: 1000 });
  expect(client.connectionState).toBe('connected');
  expect(reconnected).toHaveLength(1);
  await expect(client.add({ a: 1 })).resolves.toMatchObject({ job: { state: 'waiting' } });
  expect((await client.health()).ready).toBe(true);
  expect(reconnected).toHaveLength(1);
  await client.close();
}
