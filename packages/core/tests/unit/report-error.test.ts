import { describe, expect, it, vi } from 'vitest';
import { createReporter } from '../../src/events/report.js';
import { TypedEmitter } from '../../src/events/emitter.js';
import type { QueueEvents } from '../../src/events/types.js';
import { StoreError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { collect } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';

const storeErr = (msg = 'down') => new StoreError(msg, { operation: 'claim', retryable: true, outcomeUnknown: false });
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('reportError', () => {
  it('storeerr: error event without listener logs and does not throw', () => {
    const log = logger();
    const emitter = new TypedEmitter<QueueEvents>({ queue: 'q', logger: log });
    const report = createReporter({ emit: (e) => emitter.reportError(e), logger: log, now: () => 0, queue: 'q' });
    expect(() => report(storeErr(), 'store')).not.toThrow();
    expect(log.error).toHaveBeenCalled();
  });

  it('storeerr: error event with listener receives source, context and typed error', () => {
    const emit = vi.fn();
    const report = createReporter({ emit, logger: logger(), now: () => 0, queue: 'q', workerId: 'w1' });
    const err = storeErr();
    report(err, 'store', { operation: 'claim' });
    expect(emit).toHaveBeenCalledWith({ error: err, source: 'store', context: { operation: 'claim', queue: 'q', workerId: 'w1' } });
  });

  it('storeerr: logger that throws does not break SureQ', () => {
    const emit = vi.fn();
    const bad = {
      ...logger(),
      error: () => {
        throw new TypeError('logger down');
      },
    };
    const report = createReporter({ emit, logger: bad, now: () => 0, queue: 'q' });
    expect(() => report(storeErr(), 'store')).not.toThrow();
    expect(emit).toHaveBeenCalledOnce();
    const throwingEmit = createReporter({
      emit: () => {
        throw new TypeError('emit down');
      },
      logger: logger(),
      now: () => 0,
      queue: 'q',
    });
    expect(() => throwingEmit(storeErr(), 'store')).not.toThrow();
  });

  it('storeerr: logs are rate-limited per message; events are not', () => {
    const emit = vi.fn();
    const log = logger();
    let t = 0;
    const report = createReporter({ emit, logger: log, now: () => t, queue: 'q' });
    for (let i = 0; i < 1000; i++) report(storeErr('same'), 'store');
    expect(emit).toHaveBeenCalledTimes(1000);
    expect(log.error).toHaveBeenCalledTimes(1);
    t += 9_999;
    report(storeErr('same'), 'store');
    expect(log.error).toHaveBeenCalledTimes(1);
    t += 1;
    report(storeErr('same'), 'store');
    expect(log.error).toHaveBeenCalledTimes(2);
    report(storeErr('different'), 'store');
    expect(log.error).toHaveBeenCalledTimes(3);
  });

  it('storeerr: rateLimitMs 0 turns the limiter off', () => {
    const log = logger();
    const report = createReporter({ emit: () => {}, logger: log, now: () => 0, queue: 'q', rateLimitMs: 0 });
    for (let i = 0; i < 5; i++) report(storeErr('same'), 'store');
    expect(log.error).toHaveBeenCalledTimes(5);
  });

  it('storeerr: a worker rate-limits its logs on the monotonic clock, not the wall clock', async () => {
    let wall = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (wall += 60_000));
    const log = logger();
    const spy = spyStore(new MemoryStore(), { claim: () => Promise.reject(storeErr('claim broke')) });
    const q = new Queue('rl', { store: spy.store, logger: log });
    const w = q.process(() => {}, { acknowledgeVolatileStore: true });
    await collect(w, 'error', 2);
    await q.close();
    vi.restoreAllMocks();
    expect(log.error.mock.calls.filter(([m]) => String(m).includes('claim broke'))).toHaveLength(1);
  });
});
