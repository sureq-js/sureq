import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, JobCancelledError, LeaseLostError, PayloadTooLargeError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import type { SetProgressRequest } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { JobContext } from '../../src/worker/context.js';
import { deriveProgress, ProgressChannel, type JobProgress } from '../../src/worker/progress.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { collect, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

const steady = { ...poll(50), random: () => 0.5, sweepInterval: 3_600_000, progressInterval: '250ms' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

/** A queue on a spied memory store; `clock.t` is the store's clock unless `manual` is false (then it follows Date.now). */
function setup(over: Parameters<typeof spyStore>[1] = {}, manual = false) {
  useFakeTime();
  const clock = { t: Date.now() };
  const inner = new MemoryStore({ clock: () => (manual ? clock.t : Date.now()) });
  const spy = spyStore(inner, over);
  const q = new Queue('pw', { store: spy.store, logger: silent, leaseDuration: '3s', notify: false });
  queues.push(q);
  const writes = () => spy.calls.filter((c) => c.op === 'setProgress');
  const sent = (i: number) => JSON.parse((writes()[i]!.args[1] as SetProgressRequest).progress as string) as Record<string, unknown>;
  return { clock, inner, spy, q, writes, sent };
}

describe('progress (worker)', () => {
  it('progress: rapid calls are coalesced to one write per interval and the last value wins', async () => {
    const s = setup();
    const { job } = await s.q.add({});
    const settled: number[] = [];
    s.q.process(async (_j, ctx) => {
      const calls: Promise<void>[] = [];
      for (let n = 1; n <= 100; n++) {
        calls.push(ctx.progress(n, 100).then(() => void settled.push(n)));
        await sleep(10);
      }
      await Promise.all(calls);
      return 'ok';
    }, steady);
    await vi.advanceTimersByTimeAsync(1_500);
    const w = s.writes();
    expect(w).toHaveLength(5);
    expect(w.map((c) => c.at - w[0]!.at)).toEqual([0, 250, 500, 750, 1000]);
    expect(s.sent(4)).toMatchObject({ n: 100, total: 100 });
    expect(settled).toHaveLength(100);
    expect((await s.q.getJob(job.id))!.progress).toMatchObject({ kind: 'counter', n: 100, percent: 100 });
  });

  it('progress: final value is flushed before complete', async () => {
    const s = setup();
    const lost = vi.fn();
    s.q.on('leaseLost', lost);
    const { job } = await s.q.add({});
    s.q.process(async (_j, ctx) => {
      await ctx.progress(1, 2);
      void ctx.progress(2, 2);
      return 'done';
    }, steady);
    await vi.advanceTimersByTimeAsync(1_000);
    const ops = s.spy.calls.filter((c) => c.op === 'setProgress' || c.op === 'complete').map((c) => c.op);
    expect(ops).toEqual(['setProgress', 'setProgress', 'complete']);
    expect([s.sent(0)['n'], s.sent(1)['n']]).toEqual([1, 2]);
    expect(lost).not.toHaveBeenCalled();
    const done = (await s.q.getJob(job.id))!;
    expect(done.state).toBe('completed');
    expect(done.progress).toMatchObject({ n: 2, percent: 100, etaMs: 0 });
  });

  it('progress: lease loss rejects pending calls and aborts the signal', async () => {
    const s = setup({}, true);
    const lost = vi.fn();
    s.q.on('leaseLost', lost);
    const { job } = await s.q.add({});
    let ctx!: JobContext;
    let caught: unknown;
    const g = gate();
    s.q.process(async (_j, c) => {
      ctx = c;
      await c.progress(1, 10);
      const pending = c.progress(2, 10);
      g.open();
      await pending.catch((e: unknown) => (caught = e));
      return 'late';
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    await g.p;
    s.clock.t += 3_001;
    await vi.advanceTimersByTimeAsync(300);
    expect(caught).toBeInstanceOf(LeaseLostError);
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toBe(caught);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0]![0]).toMatchObject({ reason: 'expired' });
    expect(s.writes()).toHaveLength(2);
    expect((await s.inner.get(s.q.internals.scope, job.id))!.progress).toMatchObject({ value: expect.stringContaining('"n":1') });
    expect(s.spy.calls.some((c) => c.op === 'complete')).toBe(false);
  });

  it('progress: a cancel while a value is pending rejects the call with JobCancelledError', async () => {
    const s = setup();
    const lost = vi.fn();
    s.q.on('leaseLost', lost);
    const { job } = await s.q.add({});
    let caught: unknown;
    const g = gate();
    s.q.process(async (_j, c) => {
      await c.progress(1, 10);
      const pending = c.progress(2, 10);
      g.open();
      await pending.catch((e: unknown) => (caught = e));
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    await g.p;
    await s.q.cancel(job.id);
    await vi.advanceTimersByTimeAsync(300);
    expect(caught).toBeInstanceOf(JobCancelledError);
    expect(lost).not.toHaveBeenCalled();
    expect(s.writes()).toHaveLength(1);
  });

  it('progress: invalid arguments throw InvalidOptionError and do not fail the job', async () => {
    const s = setup();
    const { job } = await s.q.add({});
    const paths: unknown[] = [];
    s.q.process(async (_j, ctx) => {
      const p = ctx.progress as (...a: unknown[]) => Promise<void>;
      const bad: unknown[][] = [[-1], [NaN], [1, 0], [1, Infinity], [1, 2, 42], ['x'], [[]], [null], [{ big: 10n }]];
      for (const args of bad) {
        await p(...args).then(
          () => paths.push('resolved'),
          (e: unknown) => paths.push(e instanceof InvalidOptionError ? e.issues[0]!.path : e),
        );
      }
      return 'ok';
    }, steady);
    await vi.advanceTimersByTimeAsync(500);
    expect(paths).toEqual(['n', 'n', 'total', 'total', 'message', 'value', 'value', 'value', 'value']);
    expect(s.writes()).toHaveLength(0);
    expect((await s.q.getJob(job.id))!).toMatchObject({ state: 'completed', result: 'ok', progress: null });
  });

  it('progress: a long message is stored cut to 1000 characters', async () => {
    const s = setup();
    const { job } = await s.q.add({});
    s.q.process(async (_j, ctx) => void (await ctx.progress(1, 2, '\u{1F600}'.repeat(1500))), steady);
    await vi.advanceTimersByTimeAsync(500);
    const p = (await s.q.getJob(job.id))!.progress as Extract<JobProgress, { kind: 'counter' }>;
    expect(Array.from(p.message!)).toHaveLength(1000);
  });

  it('progress: object form stores any serializable value and rejects oversize', async () => {
    const s = setup();
    const { job } = await s.q.add({});
    const { job: big } = await s.q.add({});
    let tooLarge: unknown;
    let seen = 0;
    s.q.process(async (j, ctx) => {
      if (j.id === big.id) {
        await ctx.progress({ blob: 'x'.repeat(100) }).catch((e: unknown) => (tooLarge = e));
        await ctx.progress(3, 4);
        await ctx.progress({ stage: 'last' });
        return;
      }
      seen++;
      await ctx.progress(1, 4);
      await ctx.progress({ stage: 'resize', files: ['a'] });
    }, { ...steady, maxProgressBytes: 64 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen).toBe(1);
    const updatedAt = expect.any(Number) as number;
    expect((await s.q.getJob(job.id))!.progress).toEqual({ kind: 'object', value: { stage: 'resize', files: ['a'] }, updatedAt });
    expect(tooLarge).toBeInstanceOf(PayloadTooLargeError);
    expect(tooLarge).toMatchObject({ field: 'progress', limit: 64, size: JSON.stringify({ blob: 'x'.repeat(100) }).length });
    expect((tooLarge as Error).message).toMatch(/^Progress is \d+ bytes, over the 64-byte limit of queue "pw"$/);
    const last = (await s.q.getJob(big.id))!;
    expect(last.state).toBe('completed');
    expect(last.progress).toEqual({ kind: 'object', value: { stage: 'last' }, updatedAt });
  });

  it('progress: event fires once per persisted write', async () => {
    const s = setup();
    const { job } = await s.q.add({});
    const events = collect<{ job: Job; progress: JobProgress }>(s.q, 'progress', 5);
    const all = vi.fn();
    s.q.on('progress', all);
    s.q.process(async (_j, ctx) => {
      const calls: Promise<void>[] = [];
      for (let n = 1; n <= 100; n++) {
        calls.push(ctx.progress(n, 100));
        await sleep(10);
      }
      await Promise.all(calls);
    }, steady);
    await vi.advanceTimersByTimeAsync(1_500);
    const got = await events;
    expect(all).toHaveBeenCalledTimes(5);
    const { startedAt } = (await s.q.getJob(job.id))!;
    got.forEach((e, i) => {
      const w = s.writes()[i]!;
      const expected = deriveProgress({ value: (w.args[1] as SetProgressRequest).progress, updatedAt: w.at }, startedAt, JSON.parse);
      expect(e.progress).toEqual(expected);
      expect(e.job.progress).toEqual(expected);
      expect(e.job.id).toBe(job.id);
    });
  });

  it('progress: a store error on a progress write is reported and the job still completes', async () => {
    let failOnce = true;
    const s = setup({
      setProgress: async (scope, req) => {
        if (failOnce) {
          failOnce = false;
          throw new StoreUnavailableError('down', { operation: 'setProgress', retryable: true, outcomeUnknown: false });
        }
        return inner().setProgress(scope, req);
      },
    });
    const inner = () => s.inner;
    const errors: ErrorEvent[] = [];
    s.q.on('error', (e) => void errors.push(e));
    const { job } = await s.q.add({});
    let firstResolved = false;
    s.q.process(async (_j, ctx) => {
      await ctx.progress(1, 2);
      firstResolved = true;
      await ctx.progress(2, 2);
      return 'ok';
    }, steady);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstResolved).toBe(true);
    expect(errors.filter((e) => e.context.operation === 'setProgress')).toHaveLength(1);
    expect(s.writes()).toHaveLength(2);
    const done = (await s.q.getJob(job.id))!;
    expect(done.state).toBe('completed');
    expect(done.progress).toMatchObject({ n: 2 });
  });

  it('progress: failed progress writes are reported once per outage, again after a write got through', async () => {
    let down = true;
    const s = setup({
      setProgress: async (scope, req) => {
        if (down) throw new StoreUnavailableError('down', { operation: 'setProgress', retryable: true, outcomeUnknown: false });
        return s.inner.setProgress(scope, req);
      },
    });
    const errors: ErrorEvent[] = [];
    s.q.on('error', (e) => void errors.push(e));
    const reported = () => errors.filter((e) => e.context.operation === 'setProgress').length;
    await s.q.add({});
    await s.q.add({});
    let step = 0;
    s.q.process(async (_j, ctx) => {
      for (let n = 1; n <= 12; n++) {
        await ctx.progress(n, 12);
        step++;
        await sleep(300);
      }
      return 'ok';
    }, { ...steady, concurrency: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(step).toBeGreaterThanOrEqual(6);
    expect(reported()).toBe(1);
    down = false;
    await vi.advanceTimersByTimeAsync(700);
    down = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reported()).toBe(2);
  });

  it('progress: a flush behind a slow write never overlaps writes or leaves a timer behind', async () => {
    for (const latencies of [[200, 300], [300, 200]]) {
      let open = 0;
      let most = 0;
      let i = 0;
      const s = setup({
        setProgress: async (scope, req) => {
          most = Math.max(most, ++open);
          await sleep(latencies[i++] ?? 0);
          open--;
          return inner().setProgress(scope, req);
        },
      });
      const inner = () => s.inner;
      const errors = vi.fn();
      s.q.on('error', errors);
      const { job } = await s.q.add({});
      s.q.process(async (_j, ctx) => {
        void ctx.progress(1, 2);
        void ctx.progress(2, 2);
        return 'ok';
      }, steady);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(most, `${latencies}`).toBe(1);
      expect(s.writes(), `${latencies}`).toHaveLength(2);
      expect(errors).not.toHaveBeenCalled();
      expect((await s.q.getJob(job.id))!).toMatchObject({ state: 'completed', progress: { n: 2 } });
      await s.q.close({ timeoutMs: 100 });
    }
  });

  it('progress: a close timeout with a progress write in flight fires no leaseLost and nothing after closed', async () => {
    for (const ignoresAbort of [false, true]) {
      const s = setup({
        setProgress: async (scope, req) => {
          await sleep(300);
          return inner().setProgress(scope, req);
        },
      });
      const inner = () => s.inner;
      const seen: string[] = [];
      for (const e of ['leaseLost', 'progress', 'error', 'closed'] as const) s.q.on(e, () => void seen.push(e));
      await s.q.add({});
      let late: unknown;
      s.q.process(async (_j, ctx) => {
        void ctx.progress(1, 2).catch(() => {});
        await new Promise((r) => ctx.signal.addEventListener('abort', r));
        late = await ctx.progress(2, 2).then(() => 'stored', (e: unknown) => e);
        if (ignoresAbort) await new Promise(() => {});
      }, { ...steady, shutdownAbortGrace: 0 } as never);
      await vi.advanceTimersByTimeAsync(10);
      const closing = s.q.close({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(2_000);
      await closing;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen, `ignoresAbort ${ignoresAbort}`).not.toContain('leaseLost');
      expect(seen.slice(seen.indexOf('closed') + 1), `ignoresAbort ${ignoresAbort}`).toEqual([]);
      expect(late).toMatchObject({ code: 'SHUTDOWN' });
      expect(s.writes()).toHaveLength(1);
      expect(s.spy.calls.filter((c) => c.op === 'release'), `ignoresAbort ${ignoresAbort}`).toHaveLength(1);
    }
  });

  it('progress: a progress write that never answers does not hold back the release at close', async () => {
    for (const ignoresAbort of [false, true]) {
      const s = setup({ setProgress: () => new Promise(() => {}) });
      const seen: string[] = [];
      for (const e of ['leaseLost', 'progress', 'error', 'closed'] as const) s.q.on(e, () => void seen.push(e));
      const { job } = await s.q.add({});
      s.q.process(async (_j, ctx) => {
        void ctx.progress(1, 2).catch(() => {});
        await new Promise((r) => ctx.signal.addEventListener('abort', r));
        if (ignoresAbort) await new Promise(() => {});
      }, { ...steady, shutdownAbortGrace: 0 } as never);
      await vi.advanceTimersByTimeAsync(10);
      const t0 = Date.now();
      let closedAt = 0;
      const closing = s.q.close({ timeoutMs: 50 }).then(() => (closedAt = Date.now()));
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
      expect(closedAt - t0, `ignoresAbort ${ignoresAbort}`).toBeLessThanOrEqual(50 + 1_000);
      const release = s.spy.calls.find((c) => c.op === 'release');
      expect(release && release.at <= closedAt, `ignoresAbort ${ignoresAbort}`).toBe(true);
      expect(seen.slice(seen.indexOf('closed') + 1)).toEqual([]);
      expect(seen).not.toContain('leaseLost');
      expect((await s.inner.get(s.q.internals.scope, job.id))!).toMatchObject({ state: 'waiting', lease: null });
    }
  });

  it('progress: a progress write that never answers is dropped at the lease deadline and the job still completes', async () => {
    const s = setup({ setProgress: () => new Promise(() => {}) });
    const lost = vi.fn();
    s.q.on('leaseLost', lost);
    const { job } = await s.q.add({});
    let call: unknown = 'pending';
    s.q.process(async (_j, ctx) => {
      void ctx.progress(1, 2).then(() => (call = 'resolved'), (e: unknown) => (call = e));
      return 'ok';
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    const claimedAt = s.spy.calls.find((c) => c.op === 'claim' && (c.args[1] as { workerId: string }).workerId)!.at;
    await vi.advanceTimersByTimeAsync(5_000);
    const complete = s.spy.calls.find((c) => c.op === 'complete');
    expect(complete).toBeDefined();
    expect(complete!.at - claimedAt).toBeLessThanOrEqual(3_000);
    expect((await s.q.getJob(job.id))!).toMatchObject({ state: 'completed', result: 'ok', progress: null });
    expect(call).toBeInstanceOf(StoreUnavailableError);
    expect(call).toMatchObject({ operation: 'setProgress', outcomeUnknown: true, message: 'progress write dropped at the lease deadline' });
    expect(lost).not.toHaveBeenCalled();
  });

  it('progress: a throwing rejection handler rejects the waiting calls and closes the channel', async () => {
    useFakeTime();
    const boom = new TypeError('boom');
    const ch = new ProgressChannel({
      intervalMs: 0, now: () => 0,
      write: async () => ({ ok: false, reason: 'expired' }),
      onWritten: () => {}, onRejected: async () => { throw boom; }, onError: () => {},
    });
    await expect(ch.push('a')).rejects.toBe(boom);
    await expect(ch.push('b')).rejects.toBe(boom);
  });

  it('progress: a call after the handler returned is rejected', async () => {
    const s = setup();
    await s.q.add({});
    let kept!: JobContext;
    s.q.process(async (_j, ctx) => void (kept = ctx), steady);
    await vi.advanceTimersByTimeAsync(500);
    const e = await kept.progress(1).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect((e as Error).message).toMatch(/the handler has returned; progress can no longer be reported/);
    expect(s.writes()).toHaveLength(0);
  });

  it('progress: worker options progressInterval and maxProgressBytes are validated', () => {
    const s = setup();
    const issue = (opts: object) => {
      try {
        s.q.process(() => 1, opts as never);
      } catch (e) {
        return (e as InvalidOptionError).issues[0];
      }
      return undefined;
    };
    expect(issue({ progressInterval: -1 })).toMatchObject({ path: 'progressInterval' });
    expect(issue({ progressInterval: 2_147_483_648 })).toMatchObject({ path: 'progressInterval', code: 'out_of_range' });
    expect(issue({ maxProgressBytes: 0 })).toMatchObject({ path: 'maxProgressBytes' });
    expect(issue({ progresInterval: '1s' })).toMatchObject({ path: 'progresInterval', suggestion: 'progressInterval' });
  });
});
