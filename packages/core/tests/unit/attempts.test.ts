import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { harness, next, silent as quiet } from '../helpers/harness.js';
import { getJobVia } from '../helpers/get-job.js';
import { poll } from '../helpers/poll.js';

const silent = quiet;
const queues: Queue[] = [];
const queue = (opts: Record<string, unknown> = {}, store = new MemoryStore()) => {
  const q = new Queue('att', { store, logger: silent, ...opts });
  queues.push(q);
  return q;
};

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
});

describe('maxAttempts', () => {
  it('attempts: default maxAttempts is 3', async () => {
    expect((await queue().add({})).job.maxAttempts).toBe(3);
  });

  it('attempts: invalid maxAttempts (0, -1, 1.5, NaN) and legacy "attempts" throw', async () => {
    const q = queue();
    for (const maxAttempts of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) {
      const e = await q.add({}, { maxAttempts }).then(() => expect.unreachable(String(maxAttempts)), (x: unknown) => x);
      expect(e, String(maxAttempts)).toBeInstanceOf(InvalidOptionError);
      expect((e as InvalidOptionError).issues[0]!.path).toBe('maxAttempts');
    }
    await expect(q.add({}, { attempts: 5 } as never)).rejects.toThrow(/use "maxAttempts"/);
    expect(() => queue({ defaultJobOptions: { attempts: 5 } })).toThrow(/use "maxAttempts"/);
    expect(() => queue({ defaultJobOptions: { maxAttempts: 2 ** 53 } })).toThrow(InvalidOptionError);
  });

  it('attempts: queue default is stored per job and later changes do not affect it', async () => {
    const store = new MemoryStore();
    const a = queue({ defaultJobOptions: { maxAttempts: 5 } }, store);
    const b = queue({ defaultJobOptions: { maxAttempts: 2 } }, store);
    const { job: ja } = await a.add('a');
    const { job: jb } = await b.add('b');
    expect((await stored(store, a.internals.scope, ja.id))!.maxAttempts).toBe(5);
    expect((await stored(store, a.internals.scope, jb.id))!.maxAttempts).toBe(2);
  });
});

describe('retry wiring in the worker', () => {
  const instant = (extra: Record<string, unknown> = {}) => {
    const h = harness({ queue: { defaultJobOptions: { backoff: 0 }, ...extra } });
    queues.push(h.queue);
    return h;
  };

  it('attempts: attempt is 1 on the first run and increments per claim', async () => {
    const { queue } = instant();
    const seen: number[][] = [];
    const w = queue.process((job, ctx) => {
      seen.push([job.attempt, ctx.attempt]);
      throw new TypeError('again');
    }, { ...poll(5) });
    const failed = next(w, 'failed');
    await queue.add(1);
    await failed;
    expect(seen).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('attempts: ctx.isLastAttempt is true only on the final attempt', async () => {
    const { queue } = instant();
    const last: boolean[] = [];
    const w = queue.process((_job, ctx) => {
      last.push(ctx.isLastAttempt);
      throw new TypeError('again');
    }, { ...poll(5) });
    const failed = next(w, 'failed');
    await queue.add(1, { maxAttempts: 3 });
    await failed;
    expect(last).toEqual([false, false, true]);
  });

  it('attempts: retrying event fires for non-final failures and failed event only for the final', async () => {
    const { queue } = instant();
    const order: string[] = [];
    const w = queue.process(() => {
      throw new TypeError('nope');
    }, { ...poll(5) });
    const retrying: Array<Record<string, unknown>> = [];
    w.on('active', () => void order.push('active'));
    w.on('retrying', (p) => void (order.push('retrying'), retrying.push(p as never)));
    const failed = next<{ reason: string }>(w, 'failed');
    w.on('failed', () => void order.push('failed'));
    await queue.add(1, { maxAttempts: 3 });
    expect((await failed).reason).toBe('attempts-exhausted');
    expect(retrying).toHaveLength(2);
    for (const p of retrying) expect(p).toMatchObject({ delayMs: 0, runAt: expect.any(Number), error: { message: 'nope' } });
    expect(order).toEqual(['active', 'retrying', 'active', 'retrying', 'active', 'failed']);
  });

  it('attempts: failedReason holds the last error in serialized form', async () => {
    const { queue } = instant();
    let n = 0;
    const w = queue.process((job) => {
      if (job.data === 'always') throw new TypeError(`fail ${++n}`);
      if (job.attempt === 1) throw new TypeError('first try');
      return 'ok';
    }, { ...poll(5) });
    const failed = next(w, 'failed');
    const { job: a } = await queue.add('always', { maxAttempts: 2 });
    await failed;
    const fa = (await getJobVia(queue, a.id))!;
    expect(fa.failedReason).toMatchObject({ v: 1, name: 'TypeError', message: 'fail 2' });
    expect(fa.failedReason).toEqual(fa.error);
    const completed = next(w, 'completed');
    const { job: b } = await queue.add('flaky', { maxAttempts: 3 });
    await completed;
    const fb = (await getJobVia(queue, b.id))!;
    expect(fb).toMatchObject({ state: 'completed', attempt: 2 });
    expect(fb.failedReason!.message).toBe('first try');
  });

  it('attempts: oversized or unserializable result is failed once with reason unrecoverable, with attempts left', async () => {
    for (const [value, name] of [['x'.repeat(1024), 'ResultTooLargeError'], [1n, 'SerializationError']] as const) {
      const { queue } = instant({ maxResultBytes: 10 });
      let runs = 0;
      const w = queue.process(() => (runs++, value), { ...poll(5) });
      const retrying = vi.fn();
      w.on('retrying', retrying);
      const failed = next<{ reason: string }>(w, 'failed');
      const { job } = await queue.add(1, { maxAttempts: 5 });
      expect((await failed).reason).toBe('unrecoverable');
      await new Promise((r) => setTimeout(r, 20));
      expect(runs).toBe(1);
      expect(retrying).not.toHaveBeenCalled();
      expect((await getJobVia(queue, job.id))!.failedReason!.name).toBe(name);
    }
  });

  it('attempts: a non-Error throw fails with the value in failedReason', async () => {
    const { queue } = instant();
    const w = queue.process(() => {
      throw 'x marks the spot';
    }, { ...poll(5) });
    const failed = next(w, 'failed');
    const { job } = await queue.add(1, { maxAttempts: 1 });
    await failed;
    expect((await getJobVia(queue, job.id))!.failedReason!.message).toContain('x marks the spot');
  });

  it('attempts: handler runs exactly maxAttempts times when it always fails', async () => {
    for (const maxAttempts of [1, 2, 3, 10]) {
      const { queue } = instant();
      let runs = 0;
      const w = queue.process(() => {
        runs++;
        throw new TypeError('always');
      }, { ...poll(5) });
      const failed = next(w, 'failed');
      const { job } = await queue.add(1, { maxAttempts });
      await failed;
      expect(runs, String(maxAttempts)).toBe(maxAttempts);
      expect(await getJobVia(queue, job.id)).toMatchObject({ state: 'failed', attempt: maxAttempts });
    }
  });

  it('attempts: maxAttempts 1 never retries', async () => {
    const { queue } = instant();
    const retryIf = vi.fn(() => true);
    let runs = 0;
    const w = queue.process(() => {
      runs++;
      throw new TypeError('once');
    }, { ...poll(5), retryIf });
    const failed = next<{ reason: string }>(w, 'failed');
    await queue.add(1, { maxAttempts: 1 });
    expect((await failed).reason).toBe('attempts-exhausted');
    expect(runs).toBe(1);
    expect(retryIf).not.toHaveBeenCalled();
  });

  it('attempts: retry count survives a pod move', async () => {
    const h = harness({ queue: { defaultJobOptions: { backoff: 100 } } });
    queues.push(h.queue);
    const wa = h.queue.process(() => {
      throw new TypeError('pod A');
    }, { ...poll(5) });
    const retrying = next(wa, 'retrying');
    await h.queue.add(1, { maxAttempts: 3 });
    await retrying;
    await wa.close();
    const podB = new Queue('h', { store: h.raw, logger: silent });
    queues.push(podB);
    const seen: number[] = [];
    const wb = podB.process((_job, ctx) => void seen.push(ctx.attempt), { ...poll(5) });
    const done = next(wb, 'completed');
    h.clock.advance(100);
    await done;
    expect(seen).toEqual([2]);
  });

  it('attempts: counters are never kept outside the store', async () => {
    const h = harness({ queue: { defaultJobOptions: { backoff: 0 } } });
    const seen: number[] = [];
    await h.queue.add(1, { maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      const q = new Queue('h', { store: h.raw, logger: silent });
      const w = q.process((_job, ctx) => {
        seen.push(ctx.attempt);
        throw new TypeError('again');
      }, { ...poll(5) });
      await new Promise<void>((r) => (w.once('retrying', () => r()), w.once('failed', () => r())));
      await q.close();
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it('errser: failedReason and failed event carry the same serialized error', async () => {
    const { queue } = instant();
    const w = queue.process(() => {
      throw new RangeError('out', { cause: new TypeError('inner') });
    }, { ...poll(5) });
    const failed = next<{ error: unknown }>(w, 'failed');
    const { job } = await queue.add(1, { maxAttempts: 1 });
    const payload = await failed;
    expect((await getJobVia(queue, job.id))!.failedReason).toEqual(payload.error);
  });
});
