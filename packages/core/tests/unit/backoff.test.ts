import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKOFF, computeBackoff, normalizeBackoff, validateBackoffStrategies } from '../../src/retry/backoff.js';
import type { Job } from '../../src/job/job.js';
import { BackoffStrategyError, InvalidOptionError } from '../../src/errors/catalog.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { MAX_DELAY_MS } from '../../src/util/duration.js';
import { harness } from '../helpers/harness.js';
import { getJobVia } from '../helpers/get-job.js';
import { poll } from '../helpers/poll.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const ctx = { error: new TypeError('boom'), job: {} as Job };
const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidOptionError);
    return (e as InvalidOptionError).issues;
  }
  return expect.unreachable('did not throw');
};

describe('normalizeBackoff', () => {
  it('backoff: default spec is resolved and stored at add when none given', async () => {
    expect(normalizeBackoff(undefined, 'backoff')).toEqual({ type: 'exponential', delay: 1000, factor: 2, maxDelay: 3_600_000, jitter: 'full' });
    expect(DEFAULT_BACKOFF).toEqual(normalizeBackoff(undefined, 'backoff'));
    const store = new MemoryStore();
    const q = new Queue('b', { store, logger: silent });
    const { job } = await q.add({});
    expect((await stored(store, q.internals.scope, job.id))!.backoff).toEqual(DEFAULT_BACKOFF);
  });

  it('backoff: number shorthand equals fixed', () => {
    const fixed = { type: 'fixed', delay: 5000, jitter: 'none' };
    expect(normalizeBackoff(5000, 'b')).toEqual(fixed);
    expect(normalizeBackoff({ type: 'fixed', delay: 5000 }, 'b')).toEqual(fixed);
    expect(normalizeBackoff('5s', 'b')).toEqual(fixed);
  });

  it('backoff: fixed and the number shorthand default to jitter none; exponential to full', () => {
    expect(normalizeBackoff({ type: 'fixed', delay: 10 }, 'b').jitter).toBe('none');
    expect(normalizeBackoff(10, 'b').jitter).toBe('none');
    expect(normalizeBackoff({ type: 'exponential' }, 'b')).toEqual({ type: 'exponential', delay: 1000, factor: 2, maxDelay: 3_600_000, jitter: 'full' });
  });

  it('backoff: Duration strings convert to ms', () => {
    expect(normalizeBackoff({ type: 'exponential', delay: '2s', factor: 3, jitter: 'none', maxDelay: '10m' }, 'b')).toEqual({
      type: 'exponential',
      delay: 2000,
      factor: 3,
      maxDelay: 600_000,
      jitter: 'none',
    });
  });

  it('backoff: custom spec keeps maxDelay only when given and defaults jitter to none', () => {
    expect(normalizeBackoff({ type: 'mine' }, 'b')).toEqual({ type: 'mine', delay: 1000, jitter: 'none' });
    expect(normalizeBackoff({ type: 'mine', maxDelay: 4000, factor: 3 }, 'b')).toEqual({ type: 'mine', delay: 1000, factor: 3, maxDelay: 4000, jitter: 'none' });
  });

  it('backoff: fixed is never capped and maxDelay on fixed throws InvalidOptionError', () => {
    expect(issuesOf(() => normalizeBackoff({ type: 'fixed', delay: 5000, maxDelay: 1000 }, 'backoff'))[0]).toMatchObject({ path: 'backoff.maxDelay', code: 'conflict' });
    expect(issuesOf(() => normalizeBackoff({ type: 'fixed', maxDelay: '1s' }, 'backoff'))[0]!.code).toBe('conflict');
  });

  it('backoff: invalid specs throw InvalidOptionError', () => {
    const bad: unknown[] = [
      { type: 'exponential', delay: -1 },
      { type: 'exponential', factor: 1 },
      { type: 'exponential', factor: 0.5 },
      { type: 'exponential', jitter: 'half' },
      { type: '' },
      { type: 'x'.repeat(65) },
      -5,
      () => 1,
      { delay: 5 },
      { type: 'fixed', bogus: 1 },
    ];
    for (const spec of bad) expect.soft(() => normalizeBackoff(spec as never, 'b'), String(JSON.stringify(spec))).toThrow(InvalidOptionError);
  });

  it('backoff: NaN, Infinity and delays above MAX_DELAY_MS are rejected; zero delay with overflow gives 0', () => {
    const bad: unknown[] = [
      { type: 'fixed', delay: NaN },
      { type: 'fixed', delay: Infinity },
      { type: 'exponential', factor: Infinity },
      { type: 'fixed', delay: MAX_DELAY_MS + 1 },
      { type: 'exponential', maxDelay: Infinity },
      MAX_DELAY_MS + 1,
    ];
    for (const spec of bad) expect.soft(() => normalizeBackoff(spec as never, 'b'), String(spec)).toThrow(InvalidOptionError);
    expect(normalizeBackoff({ type: 'fixed', delay: 0 }, 'b').delay).toBe(0);
  });

  it('backoff: invalid backoff is reported at add and in defaultJobOptions', async () => {
    const store = new MemoryStore();
    expect(() => new Queue('b', { store, logger: silent, defaultJobOptions: { backoff: { type: 'fixed', maxDelay: 1 } } })).toThrow(InvalidOptionError);
    const q = new Queue('b', { store, logger: silent });
    await expect(q.add(1, { backoff: { type: 'exponential', factor: 1 } })).rejects.toThrow(InvalidOptionError);
  });

  it('backoff: the stored job backoff is used; a worker pod with another queue default does not change it', async () => {
    const store = new MemoryStore();
    const a = new Queue('b', { store, logger: silent, defaultJobOptions: { backoff: 100 } });
    const b = new Queue('b', { store, logger: silent, defaultJobOptions: { backoff: 9999 } });
    const { job } = await a.add(1);
    expect(((await stored(store, a.internals.scope, job.id))!.backoff as { delay: number }).delay).toBe(100);
    expect(((await stored(store, b.internals.scope, job.id))!.backoff as { delay: number }).delay).toBe(100);
  });

  it('backoff: backoffStrategies named fixed or exponential throw InvalidOptionError', () => {
    expect(issuesOf(() => validateBackoffStrategies({ fixed: () => 1 }))[0]).toMatchObject({ path: 'backoffStrategies.fixed' });
    expect(() => validateBackoffStrategies({ exponential: () => 1 })).toThrow(InvalidOptionError);
    expect(() => validateBackoffStrategies({ mine: 1 as never })).toThrow(InvalidOptionError);
    expect(() => validateBackoffStrategies({ mine: () => 1 })).not.toThrow();
    expect(() => validateBackoffStrategies(undefined)).not.toThrow();
    const q = new Queue('b', { store: new MemoryStore(), logger: silent });
    expect(() => q.process(() => 1, { backoffStrategies: { fixed: () => 1 } })).toThrow(InvalidOptionError);
  });
});

describe('computeBackoff', () => {
  const none = (type: string, extra: Record<string, number> = {}) => ({ type, delay: 1000, ...extra, jitter: 'none' as const });
  const at = (spec: Parameters<typeof computeBackoff>[0], attempt: number, random = () => 0.5) => computeBackoff(spec, attempt, {}, random).delayMs;

  it('backoff: fixed returns delay for every attempt', () => {
    for (const n of [1, 2, 50]) expect(at({ type: 'fixed', delay: 5000, jitter: 'none' }, n)).toBe(5000);
  });

  it('backoff: exponential with jitter none doubles per attempt 1s 2s 4s', () => {
    const spec = none('exponential', { factor: 2, maxDelay: 3_600_000 });
    expect([1, 2, 3].map((n) => at(spec, n))).toEqual([1000, 2000, 4000]);
  });

  it('backoff: exponential honours factor', () => {
    const spec = none('exponential', { factor: 3, maxDelay: 3_600_000 });
    expect([1, 2, 3].map((n) => at(spec, n))).toEqual([1000, 3000, 9000]);
  });

  it('backoff: default spec is exponential 1s factor 2 with full jitter and a 1h cap; seeded random gives values in [0, 1s], [0, 2s], [0, 4s]', () => {
    expect([1, 2, 3].map((n) => at(DEFAULT_BACKOFF, n, () => 0.5))).toEqual([500, 1000, 2000]);
    expect([1, 2, 3].map((n) => at(DEFAULT_BACKOFF, n, () => 0.999999))).toEqual([999, 1999, 3999]);
    expect(at(DEFAULT_BACKOFF, 3, () => 0)).toBe(0);
  });

  it('backoff: maxDelay caps exponential and, when explicit, custom results', () => {
    expect(at(DEFAULT_BACKOFF, 30, () => 1 - 1e-9)).toBeLessThanOrEqual(3_600_000);
    const capped = none('exponential', { factor: 2, maxDelay: 5000 });
    expect([1, 2, 3, 4, 5].map((n) => at(capped, n))).toEqual([1000, 2000, 4000, 5000, 5000]);
    const fn = () => 10_000;
    expect(computeBackoff({ type: 'mine', delay: 1000, maxDelay: 4000, jitter: 'none' }, 1, { mine: fn }, Math.random, ctx).delayMs).toBe(4000);
    expect(computeBackoff({ type: 'mine', delay: 1000, jitter: 'none' }, 1, { mine: fn }, Math.random, ctx).delayMs).toBe(10_000);
  });

  it('backoff: exponential overflow is capped to maxDelay', () => {
    expect(at(none('exponential', { factor: 2, maxDelay: 3_600_000 }), 5000)).toBe(3_600_000);
    expect(at({ type: 'exponential', delay: 0, factor: 2, maxDelay: 3_600_000, jitter: 'none' }, 5000)).toBe(0);
  });

  it('backoff: jitter none, full and equal stay within their ranges', () => {
    const base = (jitter: 'none' | 'full' | 'equal') => ({ type: 'fixed', delay: 8000, jitter });
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      expect(at(base('none'), 1, Math.random)).toBe(8000);
      const f = at(base('full'), 1, Math.random);
      expect(f >= 0 && f <= 8000).toBe(true);
      sum += f;
      const e = at(base('equal'), 1, Math.random);
      expect(e >= 4000 && e <= 8000).toBe(true);
    }
    expect(Math.abs(sum / 10_000 - 4000)).toBeLessThan(400);
  });

  it('backoff: result is a non-negative integer', () => {
    for (let i = 0; i < 200; i++) {
      const v = at(DEFAULT_BACKOFF, 1 + (i % 10), Math.random);
      expect(Number.isInteger(v) && v >= 0).toBe(true);
    }
    expect(computeBackoff({ type: 'mine', delay: 1, jitter: 'none' }, 1, { mine: () => 1234.7 }, Math.random, ctx).delayMs).toBe(1234);
  });

  it('backoff: zero delay retries immediately', () => {
    expect(at({ type: 'fixed', delay: 0, jitter: 'none' }, 1)).toBe(0);
    expect(at({ type: 'fixed', delay: 0, jitter: 'full' }, 1, Math.random)).toBe(0);
  });

  it('backoff: user guide examples', () => {
    const run = (spec: Parameters<typeof normalizeBackoff>[0], attempts: number[], random = () => 0.5) =>
      attempts.map((n) => at(normalizeBackoff(spec, 'b'), n, random));
    expect(run(undefined, [1, 2, 3])).toEqual([500, 1000, 2000]);
    expect(run(5000, [1, 2, 3])).toEqual([5000, 5000, 5000]);
    expect(run('5s', [1, 2, 3])).toEqual([5000, 5000, 5000]);
    expect(run({ type: 'fixed', delay: '30s' }, [1])).toEqual([30_000]);
    expect(run({ type: 'exponential', delay: '2s', factor: 3, jitter: 'none', maxDelay: '10m' }, [1, 2, 3, 4, 5, 6, 7, 8])).toEqual([
      2000, 6000, 18_000, 54_000, 162_000, 486_000, 600_000, 600_000,
    ]);
    expect(run(undefined, [19], () => 0.999999)[0]).toBeLessThanOrEqual(3_600_000);
  });
});

describe('custom strategies', () => {
  const random = () => 0.5;
  const mine = { type: 'mine', delay: 1000, jitter: 'none' as const };
  const fallback = (n: number) => computeBackoff(DEFAULT_BACKOFF, n, {}, random).delayMs;

  it('backoff: custom strategy receives attempt, error, job and spec', () => {
    const fn = vi.fn(() => 777);
    expect(computeBackoff(mine, 3, { mine: fn }, random, ctx)).toEqual({ delayMs: 777 });
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(3, ctx.error, ctx.job, mine);
  });

  it('backoff: named strategy is applied to jobs that reference it', () => {
    const retryAfter = (_a: number, err: Error) => (err as { retryAfterMs?: number }).retryAfterMs ?? 1000;
    const error = Object.assign(new TypeError('429'), { retryAfterMs: 42_000 });
    expect(computeBackoff(mine, 1, { mine: retryAfter }, random, { error, job: ctx.job }).delayMs).toBe(42_000);
  });

  it('backoff: unregistered strategy falls back to default and emits error event', () => {
    const r = computeBackoff(mine, 2, {}, random, ctx);
    expect(r.delayMs).toBe(fallback(2));
    expect(r.error).toBeInstanceOf(BackoffStrategyError);
    expect(r.error).toMatchObject({ reason: 'unknown', code: 'BACKOFF_STRATEGY_ERROR' });
  });

  it('backoff: throwing strategy falls back to default and emits error event', () => {
    const thrown = new TypeError('strategy bug');
    const r = computeBackoff(mine, 1, { mine: () => { throw thrown; } }, random, ctx);
    expect(r.delayMs).toBe(fallback(1));
    expect(r.error).toMatchObject({ reason: 'threw' });
    expect(r.error!.cause).toBe(thrown);
    const s = computeBackoff(mine, 1, { mine: () => { throw 'a string'; } }, random, ctx);
    expect(s.error).toMatchObject({ reason: 'threw' });
  });

  it('backoff: invalid strategy results fall back to default', () => {
    for (const v of [NaN, -1, Infinity, '5', undefined, MAX_DELAY_MS + 1, Promise.resolve(5)]) {
      const r = computeBackoff(mine, 1, { mine: () => v as never }, random, ctx);
      expect(r.error, String(v)).toMatchObject({ reason: 'invalid-result' });
      expect(r.delayMs).toBe(fallback(1));
    }
  });
});

describe('backoff via worker', () => {
  const queues: Queue[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  });
  /** Fail the first attempt of one job and return the retrying payload. */
  const firstRetry = async (backoff: unknown, workerOpts: Record<string, unknown> = {}) => {
    const h = harness({ queue: { defaultJobOptions: { backoff: backoff as never } } });
    queues.push(h.queue);
    const w = h.queue.process(() => Promise.reject(Object.assign(new TypeError('x'), { retryAfterMs: 4321 })), { ...poll(5), ...workerOpts });
    const retrying = new Promise<{ delayMs: number; runAt: number; job: { id: string } }>((r) => w.once('retrying', r as never));
    const errors: Array<{ source: string; error: { code: string } }> = [];
    w.on('error', (e) => void errors.push(e as never));
    await h.queue.add(1, { maxAttempts: 3 });
    return { ...h, w, payload: await retrying, errors };
  };

  it('backoff: retrying event reports delayMs and runAt', async () => {
    const { payload, raw } = await firstRetry(100);
    expect(payload.delayMs).toBe(100);
    expect(payload.runAt).toBe((await raw.now()) + 100);
  });

  it('backoff: retry delay uses store clock under pod clock skew', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_000);
    const { payload, clock } = await firstRetry(100);
    expect(payload.runAt).toBe(clock.now + 100);
  });

  it('backoff: zero delay retries immediately (end to end)', async () => {
    const { payload, queue } = await firstRetry(0);
    expect(payload.delayMs).toBe(0);
    const state = (await getJobVia(queue, payload.job.id))!.state;
    expect(['waiting', 'active', 'failed']).toContain(state);
    expect(state).not.toBe('delayed');
  });

  it('backoff: unregistered strategy falls back to default and emits error event (end to end)', async () => {
    const { payload, errors } = await firstRetry({ type: 'missing' }, { random: () => 0.5 });
    expect(payload.delayMs).toBe(500);
    expect(errors[0]).toMatchObject({ source: 'strategy', error: { code: 'BACKOFF_STRATEGY_ERROR' } });
  });

  it('backoff: throwing strategy falls back to default and emits error event (end to end)', async () => {
    const boom = () => {
      throw new TypeError('strategy bug');
    };
    const { payload, errors } = await firstRetry({ type: 'boom' }, { random: () => 0.5, backoffStrategies: { boom } });
    expect(payload.delayMs).toBe(500);
    expect(errors[0]).toMatchObject({ source: 'strategy', error: { code: 'BACKOFF_STRATEGY_ERROR' } });
  });

  it('backoff: named strategy is applied to jobs that reference it (end to end)', async () => {
    const retryAfter = (_a: number, err: Error) => (err as { retryAfterMs?: number }).retryAfterMs ?? 1000;
    const { payload } = await firstRetry({ type: 'retry-after' }, { backoffStrategies: { 'retry-after': retryAfter } });
    expect(payload.delayMs).toBe(4321);
  });

  it('backoff: the stored job backoff is used; a worker pod with another queue default does not change it (end to end)', async () => {
    const h = harness({ queue: { defaultJobOptions: { backoff: 100 } } });
    queues.push(h.queue);
    const podB = new Queue('h', { store: h.raw, logger: silent, defaultJobOptions: { backoff: 9999 } });
    queues.push(podB);
    const w = podB.process(() => Promise.reject(new TypeError('x')), { ...poll(5) });
    const retrying = new Promise<{ delayMs: number }>((r) => w.once('retrying', r as never));
    await h.queue.add(1);
    expect((await retrying).delayMs).toBe(100);
  });
});
