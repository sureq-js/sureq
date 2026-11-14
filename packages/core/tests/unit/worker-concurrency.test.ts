import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import type { Worker } from '../../src/worker/worker.js';
import { poll } from '../helpers/poll.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const queues: Queue[] = [];
const setup = () => {
  const store = new MemoryStore();
  const q = new Queue('conc', { store, logger: silent });
  queues.push(q);
  return { store, q, scope: q.internals.scope };
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolve when `n` jobs have finished (completed or failed) on `w`. */
const finished = (w: Worker<unknown, unknown>, n: number) =>
  new Promise<void>((r) => {
    let k = 0;
    const one = () => void (++k === n && r());
    w.on('completed', one);
    w.on('failed', one);
  });
const tracker = () => {
  const t = { now: 0, max: 0 };
  return {
    t,
    enter: () => void (t.max = Math.max(t.max, ++t.now)),
    exit: () => void t.now--,
  };
};
/** Seeded LCG so durations reproduce. */
const lcg = (seed: number) => () => (seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32;

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
});

describe('per-worker concurrency', () => {
  it('concurrency: default is 1 and runs jobs strictly one at a time', async () => {
    const { q } = setup();
    const { t, enter, exit } = tracker();
    const w = q.process(async () => {
      enter();
      await tick(2);
      exit();
    });
    expect(w.concurrency).toBe(1);
    const done = finished(w, 5);
    await q.addBulk(Array.from({ length: 5 }, (_, i) => ({ data: i })));
    await done;
    expect(t.max).toBe(1);
  });

  it('concurrency: never exceeds N with 1000 jobs of random duration', async () => {
    const { q } = setup();
    const { t, enter, exit } = tracker();
    const rand = lcg(42);
    let maxRunning = 0;
    const w = q.process(
      async () => {
        enter();
        maxRunning = Math.max(maxRunning, w.inFlight);
        await tick(Math.floor(rand() * 6));
        exit();
      },
      { concurrency: 7 },
    );
    const done = finished(w, 1000);
    await q.addBulk(Array.from({ length: 1000 }, (_, i) => ({ data: i })));
    await done;
    expect(t.max).toBeLessThanOrEqual(7);
    expect(maxRunning).toBeLessThanOrEqual(7);
  }, 30_000);

  it('concurrency: reaches N when enough jobs are waiting', async () => {
    const { q } = setup();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { t, enter } = tracker();
    const w = q.process(
      async () => {
        enter();
        await gate;
      },
      { concurrency: 5 },
    );
    await q.addBulk(Array.from({ length: 20 }, (_, i) => ({ data: i })));
    await vi.waitFor(() => expect(t.now).toBe(5));
    await tick(20);
    expect(t.now).toBe(5);
    expect(w.inFlight).toBe(5);
    open();
  });

  it('concurrency: freed slot is refilled without waiting for a poll', async () => {
    const { q } = setup();
    const w = q.process(() => tick(1), { concurrency: 1, ...poll(60_000) });
    const done = finished(w, 10);
    const t0 = Date.now();
    await q.addBulk(Array.from({ length: 10 }, (_, i) => ({ data: i })));
    await done;
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('concurrency: claim limit equals free slots', async () => {
    const { store, q } = setup();
    const claim = vi.spyOn(store, 'claim');
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = q.process((job) => (job.data === 'busy' ? gate : undefined), { concurrency: 3, autorun: false, ...poll(60_000) });
    await q.add('busy');
    await w.run();
    await vi.waitFor(() => expect(w.inFlight).toBe(1));
    claim.mockClear();
    await q.add('x');
    await vi.waitFor(() => expect(claim).toHaveBeenCalled());
    expect(claim.mock.calls[0]![1].limit).toBe(2);
    open();
  });

  it('concurrency: no claim is made while every slot is busy', async () => {
    const { store, q } = setup();
    const claim = vi.spyOn(store, 'claim');
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = q.process(() => gate, { concurrency: 2, ...poll(5) });
    await q.addBulk([{ data: 1 }, { data: 2 }]);
    await vi.waitFor(() => expect(w.inFlight).toBe(2));
    claim.mockClear();
    await q.add(3);
    await tick(40);
    expect(claim).not.toHaveBeenCalled();
    open();
  });

  it('concurrency: two workers on one queue run up to the sum of their limits', async () => {
    const { q } = setup();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { t, enter, exit } = tracker();
    const handler = async () => {
      enter();
      await gate;
      exit();
    };
    const w1 = q.process(handler, { concurrency: 5 });
    const w2 = q.process(handler, { concurrency: 5 });
    const done = Promise.all([finished(w1, 1), finished(w2, 1)]);
    await q.addBulk(Array.from({ length: 30 }, (_, i) => ({ data: i })));
    await vi.waitFor(() => expect(t.now).toBe(10));
    await tick(20);
    expect(t.max).toBe(10);
    open();
    await done;
  });

  it('concurrency: invalid values (0, -1, 1.5, NaN, "2") throw InvalidOptionError', () => {
    const { q } = setup();
    for (const concurrency of [0, -1, 1.5, NaN, '2']) {
      try {
        q.process(() => 1, { concurrency: concurrency as never });
        expect.unreachable(String(concurrency));
      } catch (e) {
        expect(e, String(concurrency)).toBeInstanceOf(InvalidOptionError);
        expect((e as InvalidOptionError).issues[0]!.path).toBe('concurrency');
      }
    }
  });

  it('concurrency: slot is freed when handler throws synchronously', async () => {
    const { store, scope, q } = setup();
    const w = q.process(
      () => {
        throw new TypeError('s');
      },
      { concurrency: 1 },
    );
    const done = finished(w, 3);
    await q.addBulk([1, 2, 3].map((data) => ({ data, opts: { maxAttempts: 1 } })));
    await done;
    expect((await store.counts(scope)).failed).toBe(3);
    await tick(0);
    expect(w.inFlight).toBe(0);
  });

  it('concurrency: slot is freed when handler rejects with a non-Error value', async () => {
    const { store, scope, q } = setup();
    let i = 0;
    const w = q.process(
      () => {
        if (i++ % 2 === 0) return Promise.reject(42);
        throw undefined;
      },
      { concurrency: 1 },
    );
    const done = finished(w, 4);
    await q.addBulk([1, 2, 3, 4].map((data) => ({ data, opts: { maxAttempts: 1 } })));
    await done;
    expect((await store.counts(scope)).failed).toBe(4);
    await tick(0);
    expect(w.inFlight).toBe(0);
  });

  it('concurrency: slot is freed when a listener throws', async () => {
    const { store, scope, q } = setup();
    const w = q.process(() => 1, { concurrency: 1 });
    w.on('active', () => {
      throw new TypeError('a');
    });
    w.on('completed', () => {
      throw new TypeError('c');
    });
    const done = finished(w, 5);
    await q.addBulk([1, 2, 3, 4, 5].map((data) => ({ data })));
    await done;
    expect((await store.counts(scope)).completed).toBe(5);
    await tick(0);
    expect(w.inFlight).toBe(0);
  });

  it('concurrency: slot is freed exactly once per attempt', async () => {
    const { q } = setup();
    const samples: number[] = [];
    const w = q.process(
      (_job, ctx) => {
        try {
          ctx.fail(new TypeError('x'));
        } finally {
          throw new TypeError('again');
        }
      },
      { concurrency: 2 },
    );
    w.on('failed', () => void samples.push(w.inFlight));
    const done = finished(w, 6);
    await q.addBulk(Array.from({ length: 6 }, (_, i) => ({ data: i, opts: { maxAttempts: 1 } })));
    await done;
    await tick(0);
    expect(samples.every((n) => n >= 0 && n <= 2)).toBe(true);
    expect(w.inFlight).toBe(0);
  });

  it('worker: a backlog of fast jobs does not starve timers', async () => {
    const { q } = setup();
    const n = 5000;
    const w = q.process(() => undefined, { concurrency: 10, autorun: false });
    let completed = 0;
    w.on('completed', () => void completed++);
    const done = finished(w, n);
    for (let k = 0; k < n / 1000; k++) await q.addBulk(Array.from({ length: 1000 }, (_, i) => ({ data: i })));
    const atTimer = new Promise<number>((r) => setTimeout(() => r(completed), 1));
    await w.run();
    await done;
    // The 1 ms timer must get a turn while the backlog drains, not only after it.
    expect(await atTimer).toBeLessThan(n);
  });

  it('concurrency: warns above the measured threshold', async () => {
    const warn = vi.fn();
    const q = new Queue('conc', { store: new MemoryStore(), logger: { ...silent, warn } });
    queues.push(q);
    q.process(() => 1, { concurrency: 1000, acknowledgeVolatileStore: true });
    expect(warn).not.toHaveBeenCalled();
    q.process(() => 1, { concurrency: 1001, acknowledgeVolatileStore: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/concurrency 1001/);
  });

  it('concurrency: autorun false uses no slots until run()', async () => {
    const { store, q } = setup();
    const claim = vi.spyOn(store, 'claim');
    const w = q.process(() => 1, { autorun: false });
    await q.add(1);
    await tick(20);
    expect(w.inFlight).toBe(0);
    expect(claim).not.toHaveBeenCalled();
    const done = finished(w, 1);
    await w.run();
    await done;
    expect(claim).toHaveBeenCalled();
  });
});
