import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrainedLatch } from '../../src/queue/drained.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import type { JobState } from '../../src/store/types.js';
import { next, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

type Counts = Record<JobState, number>;
const zero = (): Counts => ({ waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0 });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** One test body registered under two spec names. */
const both = (names: string[], fn: () => Promise<void>) => names.forEach((n) => it(n, fn));

describe('DrainedLatch', () => {
  it('drained: two concurrent finishes emit it once', async () => {
    const latch = new DrainedLatch(async () => zero());
    const emit = vi.fn();
    latch.arm();
    await Promise.all([latch.evaluate(emit), latch.evaluate(emit)]);
    expect(emit).toHaveBeenCalledOnce();
  });

  it('drained: a job added during the evaluation prevents the event', async () => {
    let release!: () => void;
    let reads = 0;
    const latch = new DrainedLatch(async () => {
      reads++;
      if (reads === 1) {
        await new Promise<void>((r) => (release = r));
        return zero();
      }
      return { ...zero(), waiting: 1 };
    });
    const emit = vi.fn();
    latch.arm();
    const p = latch.evaluate(emit);
    await tick();
    latch.addStarted();
    release();
    await p;
    expect(emit).not.toHaveBeenCalled();
    expect(reads).toBe(2);
  });

  it('drained: an initially empty queue never fires; it fires again after new work finishes', async () => {
    const latch = new DrainedLatch(async () => zero());
    const emit = vi.fn();
    await latch.evaluate(emit);
    expect(emit).not.toHaveBeenCalled();
    latch.arm();
    await latch.evaluate(emit);
    await latch.evaluate(emit);
    expect(emit).toHaveBeenCalledTimes(1);
    latch.arm();
    await latch.evaluate(emit);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe('drained via queue and worker', () => {
  const queues: Queue[] = [];
  afterEach(async () => {
    await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  });
  const make = (opts: Record<string, unknown> = {}) => {
    const q = new Queue('q', { store: new MemoryStore(), logger: silent, ...opts });
    queues.push(q);
    const drained = vi.fn();
    q.on('drained', drained);
    return { q, drained };
  };

  it('drained: fires once when the last job completes', async () => {
    const { q, drained } = make();
    const seen: number[] = [];
    const w = q.process(async () => {
      seen.push(drained.mock.calls.length);
      await tick(1);
    });
    const done = next(q, 'drained');
    await q.addBulk([1, 2, 3].map((data) => ({ data })));
    expect(await done).toEqual({ queue: 'q' });
    await tick(10);
    expect(drained).toHaveBeenCalledOnce();
    expect(seen).toEqual([0, 0, 0]);
    expect(w.inFlight).toBe(0);
  });

  it('events: drained fires once when everything finishes', async () => {
    const { q, drained } = make();
    q.process(() => 'ok');
    const done = next(q, 'drained');
    await q.addBulk([1, 2, 3].map((data) => ({ data })));
    await done;
    await tick(10);
    expect(drained).toHaveBeenCalledOnce();
  });

  both(['drained: fires when the last job fails terminally', 'events: drained fires when the last job fails terminally'], async () => {
    const { q, drained } = make();
    const order: string[] = [];
    q.on('failed', () => void order.push('failed'));
    q.on('drained', () => void order.push('drained'));
    q.process(() => Promise.reject(new TypeError('x')));
    const done = next(q, 'drained');
    await q.add(1, { maxAttempts: 1 });
    await done;
    expect(drained).toHaveBeenCalledOnce();
    expect(order).toEqual(['failed', 'drained']);
  });

  both(['drained: does not fire while a delayed retry exists', 'events: drained does not fire while a delayed retry exists'], async () => {
    const a = make({ defaultJobOptions: { backoff: '1h' } });
    a.q.process(() => Promise.reject(new TypeError('x')));
    const retrying = next(a.q, 'retrying');
    await a.q.add(1, { maxAttempts: 3 });
    await retrying;
    await tick(20);
    expect(a.drained).not.toHaveBeenCalled();
  });

  both(['drained: does not fire while a not-due delayed job exists', 'events: drained does not fire while a not-due delayed job exists'], async () => {
    const b = make();
    b.q.process(() => 'ok');
    await b.q.add('later', { delay: '1h' });
    const completed = next(b.q, 'completed');
    await b.q.add('now');
    await completed;
    await tick(20);
    expect(b.drained).not.toHaveBeenCalled();
  });

  it('drained: does not fire while a due delayed job waits for a slot', async () => {
    const c = { t: 1_000_000 };
    const store = new MemoryStore({ clock: () => c.t });
    const q3 = new Queue('q', { store, logger: silent });
    queues.push(q3);
    const d3 = vi.fn();
    q3.on('drained', d3);
    q3.process((job) => (job.data === 'due' ? new Promise(() => {}) : 'ok'), { concurrency: 1, ...poll(60_000) });
    await q3.add('due', { delay: '1s' });
    await tick(10); // let the claim woken by that add finish while the job is not due
    c.t += 1000; // due, but the only slot will be taken by the next job
    const done3 = next(q3, 'completed');
    await q3.add('now', { priority: 10 });
    await done3;
    await tick(20);
    expect(d3).not.toHaveBeenCalled();
  });

  both(['drained: worker and queue listeners each see one emission per transition', 'events: a worker listener and a queue listener each see one drained per transition'], async () => {
    const { q, drained } = make();
    const w = q.process(() => 'ok');
    const onWorker = vi.fn();
    w.on('drained', onWorker);
    for (let round = 1; round <= 2; round++) {
      const done = next(q, 'drained');
      await q.add(round);
      await done;
      await tick(10);
      expect(drained).toHaveBeenCalledTimes(round);
      expect(onWorker).toHaveBeenCalledTimes(round);
    }
  });

  it('events: drained does not fire for an initially empty queue', async () => {
    const { q, drained } = make();
    q.process(() => 'ok', { ...poll(5) });
    await tick(20);
    expect(drained).not.toHaveBeenCalled();
  });

  it('events: drained fires again after new work finishes', async () => {
    const { q, drained } = make();
    q.process(() => 'ok');
    let done = next(q, 'drained');
    await q.add(1);
    await done;
    done = next(q, 'drained');
    await q.add(2);
    await done;
    expect(drained).toHaveBeenCalledTimes(2);
  });

  it('drained: 20 concurrent completions of the last 20 jobs fire drained once', async () => {
    for (let round = 0; round < 50; round++) {
      const { q, drained } = make();
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const w = q.process(() => gate, { concurrency: 20 });
      let completed = 0;
      const all = new Promise<void>((r) => q.on('completed', () => void (++completed === 20 && r())));
      await q.addBulk(Array.from({ length: 20 }, (_, i) => ({ data: i })));
      await vi.waitFor(() => expect(w.inFlight).toBe(20));
      open();
      await all;
      await vi.waitFor(() => expect(drained).toHaveBeenCalled());
      await tick(5);
      expect(drained, `round ${round}`).toHaveBeenCalledOnce();
      await q.close();
    }
  }, 30_000);
});
