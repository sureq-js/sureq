import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { defineCapabilities } from '../../src/store/capabilities.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

const withLimit = (maxIdBytes: number) =>
  new (class extends MemoryStore {
    override readonly capabilities = defineCapabilities({ transactions: true, notify: true, limits: { maxIdBytes } });
  })();

describe('capabilities in core', () => {
  it('capabilities: no notify means polling only', async () => {
    useFakeTime();
    class Polled extends MemoryStore {
      override readonly capabilities = defineCapabilities({ transactions: true, notify: false });
    }
    const store = new Polled();
    const spy = spyStore(store);
    const q = new Queue('n', { store: spy.store, logger: silent, pollMin: 100, pollMax: 100, pollJitter: 0 });
    // another pod adds, so no in-process wake-up reaches the worker
    const producer = new Queue('n', { store, logger: silent });
    queues.push(q, producer);
    const done = vi.fn();
    q.process(done);
    await vi.advanceTimersByTimeAsync(250);
    await producer.add({});
    // no wake-up: the job waits for the next poll
    await vi.advanceTimersByTimeAsync(20);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledTimes(1);
    expect(spy.calls.filter((c) => c.op === 'subscribe')).toEqual([]);
  });

  it('capabilities: id limit is min of 255 and maxIdBytes', async () => {
    for (const [maxIdBytes, limit] of [[40, 40], [1000, 255]] as const) {
      const q = new Queue('i', { store: withLimit(maxIdBytes), logger: silent });
      queues.push(q);
      await expect(q.add({}, { id: 'x'.repeat(limit) })).resolves.toMatchObject({ added: true });
      await expect(q.add({}, { id: 'y'.repeat(limit + 1) })).rejects.toThrow(InvalidOptionError);
    }
  });

  it('capabilities: non-durable store logs one startup warning and health reports durable false', async () => {
    const warn = vi.fn();
    const logger = { ...silent, warn };
    const store = new MemoryStore();
    const a = new Queue('d', { store, logger });
    const b = new Queue('e', { store, logger });
    queues.push(a, b);
    a.process(() => {}, { autorun: false });
    a.process({ x: () => {} }, { autorun: false });
    b.process(() => {}, { autorun: false });
    // once per store object, whatever the number of queues and workers
    expect(warn.mock.calls.filter(([m]) => m === 'store is not durable; jobs are lost on restart')).toHaveLength(1);
    expect((await a.health()).store.durable).toBe(false);

    const quiet = vi.fn();
    const c = new Queue('d', { store: new MemoryStore(), logger: { ...silent, warn: quiet } });
    queues.push(c);
    c.process(() => {}, { autorun: false, acknowledgeVolatileStore: true });
    expect(quiet).not.toHaveBeenCalled();
    expect(() => c.process({ y: () => {} }, { acknowledgeVolatileStore: 'yes' } as never)).toThrow(InvalidOptionError);

    class Durable extends MemoryStore {
      override readonly capabilities = defineCapabilities({ transactions: true, notify: true, durable: true });
    }
    const dw = vi.fn();
    const d = new Queue('d', { store: new Durable(), logger: { ...silent, warn: dw } });
    queues.push(d);
    d.process(() => {}, { autorun: false });
    expect(dw).not.toHaveBeenCalled();
    expect((await d.health()).store.durable).toBe(true);
  });
});
