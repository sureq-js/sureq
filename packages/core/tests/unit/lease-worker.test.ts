import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseLostError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import type { QueueOptions } from '../../src/queue/options.js';
import type { ClaimRequest, ClaimResult, RenewRequest, Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { JobContext } from '../../src/worker/context.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';
import { claimJobs } from '../helpers/store.js';

const queues: Queue[] = [];
afterEach(async () => {
  // Let the loop pass its (faked) per-batch yield before the real timers come back.
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

const SWEEP = { limit: 100, maxCrashes: 3, failError: '{}', poisonError: '{}' };
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

/** A fixed poll, no heartbeat jitter (the worker's random seam), and no sweep within a test: these tests drive sweeps by hand. */
const steady = { ...poll(50), random: () => 0.5, sweepInterval: 3_600_000 };

type Over = Parameters<typeof spyStore>[1];
/** A queue on a spied MemoryStore; `manual` gives the store a hand-driven clock (`clock.t`), else it reads the faked wall clock. */
function world(o: { manual?: boolean; queue?: QueueOptions; over?: (inner: MemoryStore) => Over } = {}) {
  useFakeTime();
  const clock = { t: Date.now() };
  const inner = new MemoryStore({ clock: o.manual ? () => clock.t : () => Date.now() });
  const spy = spyStore(inner, o.over?.(inner));
  const q = new Queue('l', { store: spy.store, logger: silent, ...o.queue });
  queues.push(q);
  const ops = (op: string) => spy.calls.filter((c) => c.op === op);
  /** Pod times (ms since start) of the renews for one job id. */
  const t0 = Date.now();
  const renewsOf = (id: string) => ops('renew').filter((c) => (c.args[1] as RenewRequest).id === id).map((c) => c.at - t0);
  const events = { leaseLost: vi.fn(), failed: vi.fn(), completed: vi.fn(), error: vi.fn() };
  for (const [k, fn] of Object.entries(events)) q.on(k as 'failed', fn);
  return { clock, inner, spy, q, ops, renewsOf, events, scope: q.internals.scope };
}

describe('leases in the worker', () => {
  it('lease: long handler beyond several lease durations keeps its lease while the loop is healthy', async () => {
    const w = world({ queue: { leaseDuration: '3s' } });
    const { job } = await w.q.add({ n: 1 });
    const done = w.q.process(async () => {
      await new Promise((r) => setTimeout(r, 20_000));
      return 'ok';
    }, steady);
    await vi.advanceTimersByTimeAsync(21_000);
    const got = await w.q.getJob(job.id);
    expect(got).toMatchObject({ state: 'completed', attempt: 1, crashCount: 0, result: 'ok' });
    expect(w.renewsOf(job.id).length).toBeGreaterThanOrEqual(19);
    expect(w.events.completed).toHaveBeenCalledTimes(1);
    expect(w.events.leaseLost).not.toHaveBeenCalled();
    await done.close();
  });

  it('lease: workerId default is unique per worker and stable for its lifetime', async () => {
    const w = world();
    const a = w.q.process({ a: () => {} }, { autorun: false });
    const b = w.q.process({ b: () => {} }, { autorun: false });
    expect(a.id).not.toBe(b.id);
    const first = a.id;
    await a.run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.id).toBe(first);
  });

  it("lease-config: heartbeat interval is a third of each job's own lease", async () => {
    const w = world();
    const g = gate();
    const { job } = await w.q.add({});
    w.q.process(() => g.p, { ...steady, leaseDuration: '9s' });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(9000);
    const at = w.renewsOf(job.id);
    expect(at.slice(1).map((t, i) => t - at[i]!)).toEqual([3000, 3000]);
    expect(w.ops('renew').every((c) => (c.args[1] as RenewRequest).leaseMs === 9000)).toBe(true);
    g.open();
  });

  it('lease-config: one worker runs two names with different lease lengths', async () => {
    const w = world();
    const g = gate();
    const { job: fast } = await w.q.add({}, { name: 'fast' });
    const { job: slow } = await w.q.add({}, { name: 'slow' });
    w.q.process({ fast: () => g.p, slow: () => g.p }, { ...steady, concurrency: 2, leaseDurationByName: { fast: '3s', slow: '60s' } });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(40_000);
    const gaps = (id: string) => {
      const at = w.renewsOf(id);
      return new Set(at.slice(1).map((t, i) => t - at[i]!));
    };
    expect(gaps(fast.id)).toEqual(new Set([1000]));
    expect(gaps(slow.id)).toEqual(new Set([20_000]));
    g.open();
  });

  it('lease-config: a long job with a short lease stays alive through heartbeat renewals', async () => {
    const w = world({ queue: { leaseDuration: '1s' } });
    const { job } = await w.q.add({});
    const handler = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10_000));
    });
    w.q.process(handler, steady);
    for (let i = 0; i < 105; i++) {
      await vi.advanceTimersByTimeAsync(100);
      expect((await w.inner.sweep(w.scope, SWEEP)).swept).toHaveLength(0);
    }
    expect(await w.q.getJob(job.id)).toMatchObject({ state: 'completed', attempt: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('lease-config: changing config applies to the next claim only', async () => {
    const w = world();
    const g = gate();
    const { job: first } = await w.q.add({});
    w.q.process(() => g.p, { ...steady, leaseDuration: '60s' });
    await vi.advanceTimersByTimeAsync(10);
    const other = new Queue('l', { store: w.spy.store, logger: silent, leaseDuration: '3s' });
    queues.push(other);
    const { job: second } = await other.add({});
    other.process(() => g.p, steady);
    await vi.advanceTimersByTimeAsync(41_000);
    const gaps = (id: string) => {
      const at = w.renewsOf(id);
      return new Set(at.slice(1).map((t, i) => t - at[i]!));
    };
    expect(gaps(first.id)).toEqual(new Set([20_000]));
    expect(gaps(second.id)).toEqual(new Set([1000]));
    const leaseMs = (id: string) => new Set(w.ops('renew').map((c) => c.args[1] as RenewRequest).filter((r) => r.id === id).map((r) => r.leaseMs));
    expect(leaseMs(first.id)).toEqual(new Set([60_000]));
    expect(leaseMs(second.id)).toEqual(new Set([3000]));
    g.open();
  });
});

describe('fencing in the worker', () => {
  it('fencing: an attempt the store hands back while it runs is not started twice', async () => {
    let first: ClaimResult | undefined;
    let n = 0;
    const w = world({
      over: (inner) => ({
        // The second claim answers with the first claim's job again.
        claim: async (s: Scope, r: ClaimRequest) => {
          n++;
          if (n === 2 && first) return first;
          const res = await inner.claim(s, r);
          if (n === 1) first = res;
          return res;
        },
      }),
    });
    const g = gate();
    const { job } = await w.q.add({});
    const handler = vi.fn(async () => {
      await g.p;
      return 'once';
    });
    const worker = w.q.process(handler, { ...steady, concurrency: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(w.ops('claim').length).toBeGreaterThan(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(worker.inFlight).toBe(1);
    expect(w.events.leaseLost).not.toHaveBeenCalled();
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(await w.q.getJob(job.id)).toMatchObject({ state: 'completed', result: 'once' });
    expect(w.events.completed).toHaveBeenCalledTimes(1);
  });

  it('fencing: lease loss aborts ctx.signal with LeaseLostError', async () => {
    const w = world({ manual: true });
    const g = gate();
    const { job } = await w.q.add({});
    let ctx!: JobContext;
    w.q.process(async (_j, c) => {
      ctx = c;
      await g.p;
      return 'late';
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    w.clock.t += 31_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.signal.aborted).toBe(true);
    expect(ctx.signal.reason).toBeInstanceOf(LeaseLostError);
    expect(ctx.signal.reason).toMatchObject({ jobId: job.id, token: ctx.token, reason: 'expired' });
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.events.leaseLost).toHaveBeenCalledTimes(1);
    expect(w.events.completed).not.toHaveBeenCalled();
    expect(w.events.failed).not.toHaveBeenCalled();
    expect(w.ops('complete').length + w.ops('fail').length).toBe(0);
    expect((await w.inner.get(w.scope, job.id))!.state).toBe('active');
  });

  it('fencing: a handler that ignores its abort after a lease loss frees its slot after timeoutGrace', async () => {
    const w = world({ manual: true });
    const g = gate();
    await w.q.add({ n: 1 });
    await w.q.add({ n: 2 });
    const ran: number[] = [];
    const worker = w.q.process(async (j) => {
      ran.push((j.data as { n: number }).n);
      if (ran.length === 1) await g.p; // the first ignores its signal
    }, { ...steady, timeoutGrace: '2s' });
    await vi.advanceTimersByTimeAsync(10);
    w.clock.t += 31_000;
    // the next renewal finds the lease gone
    while (w.events.leaseLost.mock.calls.length === 0) await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1900);
    expect(worker.inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(worker.inFlight).toBe(0);
    expect(ran).toEqual([1, 2]);
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.ops('complete')).toHaveLength(1);
  });

  it('fencing: leaseLost event fires exactly once per attempt', async () => {
    const w = world({ manual: true });
    const g = gate();
    const { job } = await w.q.add({});
    w.q.process(async (_j, c) => {
      await g.p;
      if (c.signal.aborted) throw c.signal.reason;
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    w.clock.t += 31_000;
    await vi.advanceTimersByTimeAsync(20_000);
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.events.leaseLost).toHaveBeenCalledTimes(1);
    const [payload] = w.events.leaseLost.mock.calls[0]! as [{ job: Job; token: number; reason: string }];
    expect(payload.job.id).toBe(job.id);
    expect(payload.reason).toBe('expired');
    expect(payload.token).toBe(payload.job.token);
    expect(w.events.failed).not.toHaveBeenCalled();
  });

  it('fencing: stale handler result is discarded and not recorded as a failure', async () => {
    const w = world({ manual: true });
    const g = gate();
    const { job } = await w.q.add({});
    w.q.process(async () => {
      await g.p;
      throw new Error('stale failure');
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    w.clock.t += 31_000;
    await w.inner.sweep(w.scope, SWEEP);
    const [again] = await claimJobs(w.inner, w.scope, { workerId: 'other', leaseMs: 30_000 });
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.events.failed).not.toHaveBeenCalled();
    expect(w.events.leaseLost).toHaveBeenCalledTimes(1);
    expect(w.events.leaseLost.mock.calls[0]![0]).toMatchObject({ reason: 'superseded' });
    const rec = (await w.inner.get(w.scope, job.id))!;
    expect(rec).toMatchObject({ state: 'active', token: again!.lease!.token, error: null, result: null });
    expect(w.events.error).not.toHaveBeenCalled();
  });

  it('fencing: complete after expiry but before the sweep emits leaseLost expired and leaves the job active', async () => {
    const w = world({ manual: true });
    const g = gate();
    const { job } = await w.q.add({});
    w.q.process(async () => {
      await g.p;
      return 'done';
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    w.clock.t += 31_000;
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.ops('complete')).toHaveLength(1);
    expect(w.events.leaseLost).toHaveBeenCalledTimes(1);
    expect(w.events.leaseLost.mock.calls[0]![0]).toMatchObject({ reason: 'expired' });
    expect((await w.inner.get(w.scope, job.id))!.state).toBe('active');
    expect(w.events.failed).not.toHaveBeenCalled();
    expect(w.events.completed).not.toHaveBeenCalled();
    expect(w.events.error).not.toHaveBeenCalled();
  });

  it('fencing: a stale attempt of a job reclaimed by the same worker loses only itself', async () => {
    const w = world({ manual: true });
    const gates = [gate(), gate()];
    const attempts: { token: number; signal: AbortSignal }[] = [];
    const { job } = await w.q.add({});
    const worker = w.q.process(async (_j, c) => {
      const n = attempts.push({ token: c.token, signal: c.signal });
      await gates[n - 1]!.p;
      return `run ${n}`;
    }, { ...steady, concurrency: 2 });
    await vi.advanceTimersByTimeAsync(10);
    w.clock.t += 31_000;
    expect((await w.inner.sweep(w.scope, SWEEP)).swept).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100); // the same worker claims the job again
    expect(attempts).toHaveLength(2);
    const [first, second] = attempts as [(typeof attempts)[0], (typeof attempts)[0]];
    expect(second.token).toBeGreaterThan(first.token);
    expect(worker.inFlight).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.signal.aborted).toBe(true);
    expect((first.signal.reason as LeaseLostError).token).toBe(first.token);
    expect(second.signal.aborted).toBe(false);
    expect(w.events.leaseLost).toHaveBeenCalledTimes(1);
    const lostEvent = w.events.leaseLost.mock.calls[0]![0] as { token: number; job: Job };
    expect(lostEvent.token).toBe(first.token);
    expect(lostEvent.job.lease).toBeNull();
    gates[0]!.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.inFlight).toBe(1);
    expect(w.ops('complete')).toHaveLength(0);
    const before = w.renewsOf(job.id).length;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(w.renewsOf(job.id).length).toBeGreaterThanOrEqual(before + 4);
    expect(second.signal.aborted).toBe(false);
    gates[1]!.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(await w.q.getJob(job.id)).toMatchObject({ state: 'completed', result: 'run 2' });
    expect(w.events.completed).toHaveBeenCalledTimes(1);
    expect(w.events.leaseLost).toHaveBeenCalledTimes(1);
    expect(worker.inFlight).toBe(0);
  });

  it('fencing: one lost lease in a batch aborts only that job', async () => {
    const w = world({ manual: true });
    const g = gate();
    const { job: a } = await w.q.add({ n: 'a' });
    const { job: b } = await w.q.add({ n: 'b' });
    const signals = new Map<string, AbortSignal>();
    let batchSignal!: AbortSignal;
    w.q.processBatch(async (batch, ctx) => {
      for (const j of batch.jobs) signals.set(j.id, j.signal);
      batchSignal = ctx.signal;
      await g.p;
    }, { ...steady, batchSize: 2 });
    await vi.advanceTimersByTimeAsync(10);
    const bRec = (await w.inner.get(w.scope, b.id))!;
    expect((await w.inner.renew(w.scope, { id: b.id, token: bRec.token, leaseMs: 60_000 })).ok).toBe(true);
    w.clock.t += 31_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals.get(a.id)!.aborted).toBe(true);
    expect(signals.get(b.id)!.aborted).toBe(false);
    expect(batchSignal.aborted).toBe(false);
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.events.leaseLost).toHaveBeenCalledTimes(1);
    expect(w.events.completed).toHaveBeenCalledTimes(1);
    expect((await w.inner.get(w.scope, b.id))!.state).toBe('completed');
  });

  it('fencing: store outage longer than the lease aborts locally', async () => {
    const w = world({ over: () => ({ renew: () => Promise.reject(new TypeError('connection reset')) }) });
    const g = gate();
    await w.q.add({});
    let ctx!: JobContext;
    w.q.process(async (_j, c) => {
      ctx = c;
      await g.p;
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(ctx.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect((ctx.signal.reason as LeaseLostError).reason).toBe('expired');
    const renewErrors = w.events.error.mock.calls.map((c) => c[0] as ErrorEvent).filter((e) => e.context.operation === 'renew');
    expect(renewErrors).toHaveLength(1);
    expect(renewErrors[0]!.error).toBeInstanceOf(StoreUnavailableError);
    expect(w.events.leaseLost).toHaveBeenCalledTimes(1);
    g.open();
  });

  it('fencing: ctx.token equals job.token and increases with each claim', async () => {
    const w = world();
    await w.q.add({}, { maxAttempts: 2, backoff: { type: 'fixed', delay: 100 } });
    const seen: [number, number][] = [];
    w.q.process((j, c) => {
      seen.push([c.token, j.token]);
      if (seen.length === 1) throw new Error('again');
    }, steady);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(2);
    for (const [ctxToken, jobToken] of seen) expect(ctxToken).toBe(jobToken);
    expect(seen[1]![0]).toBeGreaterThan(seen[0]![0]);
  });

  it('meta: job.lease is set while active and null once finished', async () => {
    const w = world();
    const g = gate();
    const { job } = await w.q.add({});
    let inside!: Job;
    let ctx!: JobContext;
    const first: { expiresAt?: number } = {};
    w.q.process(async (j, c) => {
      inside = j;
      ctx = c;
      first.expiresAt = j.lease!.expiresAt;
      await g.p;
    }, steady);
    await vi.advanceTimersByTimeAsync(10);
    expect(inside.lease).toMatchObject({ owner: ctx.workerId, token: ctx.token });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inside.lease!.expiresAt).toBeGreaterThan(first.expiresAt!);
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(inside.lease).toBeNull();
    expect((await w.q.getJob(job.id))!.lease).toBeNull();
  });
  it('claim: heartbeat starts for every claimed job before its handler', async () => {
    const w = world();
    await w.q.addBulk(Array.from({ length: 5 }, (_, n) => ({ data: { n } })));
    const g = gate();
    const tokens: Array<number | null> = [];
    w.q.process(async (job) => {
      // job.lease reads the heartbeat's own record: set only once the job is tracked
      tokens.push(job.lease?.token ?? null);
      await g.p;
    }, { ...steady, concurrency: 5 });
    await vi.advanceTimersByTimeAsync(10);
    expect(w.ops('claim')).toHaveLength(1);
    expect(tokens).toHaveLength(5);
    expect(tokens.every((t) => t !== null && t > 0)).toBe(true);
    g.open();
  });

  /** Renews as sent (monotonic pod time), with a switch that makes every later renew hang. */
  const pacedRenews = () => {
    const sent: number[] = [];
    const ok: number[] = [];
    const ctl = { hang: false };
    const over = (inner: MemoryStore): Over => ({
      renew: (s, r) => {
        const at = performance.now();
        sent.push(at);
        if (ctl.hang) return new Promise(() => {});
        return inner.renew(s, r).then((res) => (ok.push(at), res));
      },
    });
    return { sent, ok, ctl, over };
  };

  it('lease: changing the pod wall clock does not change heartbeat timing', async () => {
    const r = pacedRenews();
    const w = world({ manual: true, queue: { leaseDuration: '3s' }, over: r.over });
    const g = gate();
    await w.q.add({});
    w.q.process(() => g.p, steady);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(3000);
    vi.setSystemTime(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(3000);
    vi.setSystemTime(Date.now() - 7_200_000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.sent).toHaveLength(9);
    expect(r.sent.slice(1).map((t, i) => t - r.sent[i]!)).toEqual(Array.from({ length: 8 }, () => 1000));
    expect(w.events.leaseLost).not.toHaveBeenCalled();
    g.open();
  });

  it('clock: wall clock jump on the pod does not change heartbeat or local deadline', async () => {
    const r = pacedRenews();
    const w = world({ manual: true, queue: { leaseDuration: '3s' }, over: r.over });
    await w.q.add({});
    let abortedAt: number | undefined;
    w.q.process(
      (_job, ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener('abort', () => {
            abortedAt = performance.now();
            reject(ctx.signal.reason as Error);
          });
        }),
      steady,
    );
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2000);
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(1000);
    r.ctl.hang = true;
    vi.setSystemTime(Date.now() + 7_200_000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(r.sent.slice(1, 4).map((t, i) => t - r.sent[i]!)).toEqual([1000, 1000, 1000]);
    // The deadline is the last answered renew's send time plus the lease the store granted.
    expect(abortedAt! - r.ok.at(-1)!).toBeGreaterThanOrEqual(3000);
    expect(abortedAt! - r.ok.at(-1)!).toBeLessThan(3100);
  });

  it('clock: core never sends Date.now in any store request', async () => {
    const w = world({ manual: true, queue: { leaseDuration: '3s' } });
    // The pod's wall clock is far from the store's, so any pod instant in a request stands out.
    vi.setSystemTime(9_000_000_000_000);
    w.clock.t = 5_000_000;
    let n = 0;
    await w.q.add({ a: 1 }, { delay: 500, backoff: 200 });
    const { job } = await w.q.add({ b: 2 });
    await w.q.cancel(job.id);
    await w.q.pause();
    await w.q.resume();
    // started after the cancel, so the worker never races it for the job
    w.q.process((job) => {
      if (n++ === 0) throw new Error('retry me');
      return job.data;
    }, steady);
    for (let i = 0; i < 20; i++) {
      w.clock.t += 100;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(w.ops('complete').length).toBeGreaterThan(0);
    expect(w.ops('fail').length).toBeGreaterThan(0);
    const pod = Date.now();
    const numbers = (v: unknown): number[] =>
      typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(numbers) : [];
    const near = w.spy.calls.flatMap((c) => numbers(c.args).filter((x) => Math.abs(x - pod) < 86_400_000).map((x) => `${c.op}: ${x}`));
    expect(near).toEqual([]);
  });
});
