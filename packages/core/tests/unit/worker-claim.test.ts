import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreUnavailableError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import { Queue } from '../../src/queue/queue.js';
import type { ClaimRequest, ClaimResult, Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';
import { newJob } from '../helpers/store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Over = Parameters<typeof spyStore>[1];
/** A queue on a spied MemoryStore with a manual store clock. */
function setup(over: (inner: MemoryStore) => Over = () => ({})) {
  const clock = { t: 1_000_000 };
  const inner = new MemoryStore({ clock: () => clock.t });
  const spy = spyStore(inner, over(inner));
  const q = new Queue('c', { store: spy.store, logger: silent });
  queues.push(q);
  const claims = () => spy.calls.filter((c) => c.op === 'claim').map((c) => c.args[1] as ClaimRequest);
  return { clock, inner, spy, q, claims, scope: q.internals.scope };
}
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe('claim loop', () => {
  it('polling: local add wakes the worker without waiting for the poll', async () => {
    vi.useFakeTimers();
    const { q, claims } = setup();
    const done = vi.fn();
    const w = q.process(done, poll(60_000));
    await vi.advanceTimersByTimeAsync(10);
    expect(claims()).toHaveLength(1);
    await q.add(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toHaveBeenCalledOnce();
    await w.close();
  });

  it('polling: wake-up while claiming is coalesced into one extra claim', async () => {
    vi.useFakeTimers();
    const g = gate();
    let first = true;
    const { q, claims } = setup((inner) => ({
      claim: async (s: Scope, r: ClaimRequest) => {
        if (first) {
          first = false;
          await g.p;
        }
        return inner.claim(s, r);
      },
    }));
    const w = q.process(() => {}, poll(60_000));
    await vi.advanceTimersByTimeAsync(1);
    expect(claims()).toHaveLength(1);
    w.wake('local');
    w.wake('local');
    w.wake('local');
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(claims()).toHaveLength(2);
    await w.close();
  });

  it('polling: claim limit equals free slots and no claim happens when full', async () => {
    vi.useFakeTimers();
    const g = gate();
    const { q, claims } = setup();
    const w = q.process((job) => (job.data === 'busy' ? g.p : undefined), { concurrency: 3, ...poll(1000) });
    await q.add('busy');
    await vi.advanceTimersByTimeAsync(10);
    const before = claims().length;
    await q.add('x');
    await vi.advanceTimersByTimeAsync(10);
    expect(claims()[before]!.limit).toBe(2);
    await q.addBulk([{ data: 'busy' }, { data: 'busy' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(w.inFlight).toBe(3);
    const full = claims().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claims()).toHaveLength(full);
    g.open();
    await w.close();
  });

  it('claim: worker asks for concurrency minus active jobs and never more', async () => {
    vi.useFakeTimers();
    const g = gate();
    const { q, claims } = setup();
    const w = q.process(() => g.p, { concurrency: 4, ...poll(50) });
    await q.addBulk(Array.from({ length: 6 }, (_, i) => ({ data: i })));
    await vi.advanceTimersByTimeAsync(500);
    expect(w.inFlight).toBe(4);
    for (const c of claims()) expect(c.limit).toBeLessThanOrEqual(4);
    g.open();
    await w.close();
  });

  it('claim: worker with no free slot makes no store call', async () => {
    vi.useFakeTimers();
    const g = gate();
    const { q, spy } = setup();
    const w = q.process(() => g.p, { concurrency: 1, ...poll(10) });
    await q.add(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(w.inFlight).toBe(1);
    // Heartbeat renewals of the running job, the queue's sweeps (with their stats refresh and retention pass), its schedule loop and the worker registry are the only calls allowed.
    const allowed = ['renew', 'sweep', 'stats', 'clean', 'listDueSchedules', 'heartbeatWorker', 'purgeWorkers'];
    const others = () => spy.calls.filter((c) => !allowed.includes(c.op));
    const n = others().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(others()).toHaveLength(n);
    g.open();
    await w.close();
  });

  it('claim: a failing claim leaves slots free and the worker keeps polling', async () => {
    vi.useFakeTimers();
    let failures = 2;
    const { q } = setup((inner) => ({
      claim: (s: Scope, r: ClaimRequest) => (failures-- > 0 ? Promise.reject('x') : inner.claim(s, r)),
    }));
    const errors: ErrorEvent[] = [];
    const w = q.process(() => 'ok', poll(10));
    w.on('error', (e) => void errors.push(e));
    const completed = vi.fn();
    w.on('completed', completed);
    await q.add(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors.map((e) => e.source)).toEqual(['store', 'store']);
    expect(completed).toHaveBeenCalledOnce();
    expect(w.inFlight).toBe(0);
    await w.close();
  });

  it('claim: slots are consumed only for jobs returned', async () => {
    vi.useFakeTimers();
    const g = gate();
    const { q, claims } = setup();
    const w = q.process(() => g.p, { concurrency: 5, ...poll(100) });
    await q.addBulk([{ data: 1 }, { data: 2 }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(w.inFlight).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(claims().at(-1)!.limit).toBe(3);
    g.open();
    await w.close();
  });

  it('claim: job for a name without handler is released and reported', async () => {
    vi.useFakeTimers();
    let ghost = true;
    const { q, inner, scope } = setup((s) => ({
      claim: async (sc: Scope, r: ClaimRequest): Promise<ClaimResult> => {
        if (!ghost) return s.claim(sc, r);
        ghost = false;
        // A misbehaving store hands back a job outside the requested names.
        return s.claim(sc, { ...r, names: ['ghost'] });
      },
    }));
    await inner.open();
    await inner.add(scope, [newJob({ id: 'g1', name: 'ghost' })]);
    const errors: ErrorEvent[] = [];
    const w = q.process({ real: () => 'ok' }, poll(60_000));
    w.on('error', (e) => void errors.push(e));
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ source: 'internal', context: { jobId: 'g1' } });
    expect(await inner.get(scope, 'g1')).toMatchObject({ state: 'waiting', attempt: 0 });
    await w.close();
  });

  it('claim: lost claim response is recovered with the same claimId and costs no attempt', async () => {
    vi.useFakeTimers();
    let lose = true;
    const results: ClaimResult[] = [];
    const { q, claims } = setup((inner) => ({
      claim: async (s: Scope, r: ClaimRequest) => {
        const res = await inner.claim(s, r);
        if (lose && res.jobs.length > 0) {
          lose = false;
          throw new StoreUnavailableError('lost', { operation: 'claim', retryable: true, outcomeUnknown: true });
        }
        results.push(res);
        return res;
      },
    }));
    await q.add(1);
    const attempts: number[] = [];
    const w = q.process((_job, ctx) => void attempts.push(ctx.attempt), poll(10));
    await vi.advanceTimersByTimeAsync(1000);
    const [lost, retry] = claims();
    expect(retry!.claimId).toBe(lost!.claimId);
    expect(results[0]!.recovered).toBe(true);
    expect(attempts).toEqual([1]);
    await w.close();
  });

  it('claim: claimId changes after a claim that did not fail with unknown outcome', async () => {
    vi.useFakeTimers();
    let fail = false;
    const { q, claims } = setup((inner) => ({
      claim: (s: Scope, r: ClaimRequest) =>
        fail
          ? ((fail = false), Promise.reject(new StoreUnavailableError('no', { operation: 'claim', retryable: true, outcomeUnknown: false })))
          : inner.claim(s, r),
    }));
    const w = q.process(() => {}, poll(10));
    await vi.advanceTimersByTimeAsync(25);
    fail = true;
    await vi.advanceTimersByTimeAsync(500);
    const ids = claims().map((c) => c.claimId);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
    await w.close();
  });

  it('claim: claim limit is clamped to maxClaimLimit', async () => {
    vi.useFakeTimers();
    const { q, claims, spy } = setup();
    Object.defineProperty(spy.store, 'capabilities', {
      value: { ...new MemoryStore().capabilities, limits: { ...new MemoryStore().capabilities.limits, maxClaimLimit: 7 } },
    });
    const w = q.process(() => {}, { concurrency: 50, ...poll(60_000) });
    await vi.advanceTimersByTimeAsync(10);
    expect(claims()[0]!.limit).toBe(7);
    await w.close();
  });

  it('polling: idle worker makes claims at the delays 100, 200, 400 ... 5000 ms apart', async () => {
    vi.useFakeTimers();
    const { q, spy } = setup();
    const w = q.process(() => {}, { pollJitter: 0 });
    await vi.advanceTimersByTimeAsync(20_000);
    const at = spy.calls.filter((c) => c.op === 'claim').map((c) => c.at);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps.slice(0, 8)).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000]);
    await w.close();
  });

  it('polling: a slot freed while a claim is out does not double the next poll wait', async () => {
    vi.useFakeTimers();
    const held = gate();
    const handler = gate();
    let n = 0;
    const { q, spy } = setup((inner) => ({
      claim: async (s: Scope, r: ClaimRequest) => {
        const res = await inner.claim(s, r);
        if (++n === 3) await held.p;
        return res;
      },
    }));
    const w = q.process(() => handler.p, { concurrency: 2, pollJitter: 0 });
    await vi.advanceTimersByTimeAsync(10);
    // The add wakes the worker: claim 2 takes the job, claim 3 is held.
    await q.add(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(n).toBe(3);
    // The handler finishes while claim 3 is out; its wake runs claim 4 at once.
    handler.open();
    await vi.advanceTimersByTimeAsync(10);
    held.open();
    await vi.advanceTimersByTimeAsync(1000);
    const at = spy.calls.filter((c) => c.op === 'claim').map((c) => c.at);
    expect(at.length).toBeGreaterThan(4);
    // After the wake the poll starts over at pollMin: a new job is picked up within pollMin plus jitter.
    expect(at[4]! - at[3]!).toBe(100);
    await w.close();
  });

  it('capabilities: skipLocked false adds poll jitter and caps claim limit', async () => {
    vi.useFakeTimers();
    const run = async (skipLocked: boolean, random: number) => {
      const { q, spy, claims } = setup();
      const caps = new MemoryStore().capabilities;
      Object.defineProperty(spy.store, 'capabilities', { value: { ...caps, skipLocked } });
      const w = q.process(() => {}, { concurrency: 50, pollJitter: 0, random: () => random });
      await vi.advanceTimersByTimeAsync(1000);
      const at = spy.calls.filter((c) => c.op === 'claim').map((c) => c.at);
      await w.close();
      // The wait after the second empty claim: base 200 ms.
      return { limit: claims()[0]!.limit, gap: at[2]! - at[1]! };
    };
    expect(await run(true, 1)).toEqual({ limit: 50, gap: 200 });
    expect(await run(false, 1)).toEqual({ limit: 10, gap: 300 });
    expect(await run(false, 0)).toEqual({ limit: 10, gap: 100 });
  });

  it('capabilities: skipLocked false jitter stays within pollMin and pollMax', async () => {
    vi.useFakeTimers();
    const gaps = async (random: number) => {
      const { q, spy } = setup();
      Object.defineProperty(spy.store, 'capabilities', { value: { ...new MemoryStore().capabilities, skipLocked: false } });
      const w = q.process(() => {}, { pollMin: 100, pollMax: 400, pollJitter: 0, random: () => random });
      await vi.advanceTimersByTimeAsync(2000);
      const at = spy.calls.filter((c) => c.op === 'claim').map((c) => c.at);
      await w.close();
      return at.slice(1, 5).map((t, i) => t - at[i]!);
    };
    // Bases 100, 200, 400, 400: +50 % is cut at pollMax, -50 % at pollMin.
    expect(await gaps(1)).toEqual([150, 300, 400, 400]);
    expect(await gaps(0)).toEqual([100, 100, 200, 200]);
  });

  it('claim: wake-ups do not cut the claim-error backoff short', async () => {
    vi.useFakeTimers();
    const { q, claims } = setup(() => ({ claim: () => Promise.reject(new TypeError('down')) }));
    const w = q.process(() => {}, poll(10));
    w.on('error', () => {});
    const sentAt: number[] = [];
    const t0 = Date.now();
    for (let ms = 0; ms < 12_000; ms += 50) {
      w.wake('local');
      const n = claims().length;
      await vi.advanceTimersByTimeAsync(50);
      for (let k = n; k < claims().length; k++) sentAt.push(Date.now() - t0);
    }
    // 100, 200, 400 ... 5000 ms apart (within one 50 ms step), not once per wake.
    expect(claims().length).toBeLessThanOrEqual(9);
    const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i]!);
    for (const [i, gap] of gaps.entries()) expect(gap).toBeGreaterThanOrEqual(Math.min(5000, 100 * 2 ** i) - 50);
    await w.close();
  });

  it('claim: an unknown-outcome claim older than the shortest lease gets a fresh claimId', async () => {
    vi.useFakeTimers();
    let perf = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => perf);
    let lose = true;
    const { q, claims } = setup((inner) => ({
      claim: async (s: Scope, r: ClaimRequest) => {
        if (!lose) return inner.claim(s, r);
        lose = false;
        perf += 86_400_000; // the reply is lost and the lease window passes before the retry
        throw new StoreUnavailableError('lost', { operation: 'claim', retryable: true, outcomeUnknown: true });
      },
    }));
    const w = q.process(() => {}, poll(60_000));
    w.on('error', () => {});
    await vi.advanceTimersByTimeAsync(200);
    const [lost, retry] = claims();
    expect(retry!.claimId).not.toBe(lost!.claimId);
    await w.close();
  });
});
