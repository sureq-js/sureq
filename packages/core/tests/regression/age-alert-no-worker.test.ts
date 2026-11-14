import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../../src/metrics/alerts.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { harness } from '../helpers/harness.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('age alert without a worker', () => {
  it('regression: job with no worker raises an age alert', async () => {
    useFakeTime();
    const { queue, clock } = harness({ queue: { alerts: { interval: '1s', age: { aboveMs: 30_000 } } } });
    const events: AlertEvent[] = [];
    queue.on('alert', (e) => void events.push(e));
    await queue.add({}, { name: 'orphan' });
    await queue.add({}, { name: 'orphan' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([]);
    clock.advance(31_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([{ type: 'age', status: 'firing', value: 31, threshold: 30, namespace: 'default', queue: 'h', at: clock.now }]);
    vi.useRealTimers();
    await queue.close();
  });
});
