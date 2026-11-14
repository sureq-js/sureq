import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseLostError, StoreUnavailableError } from '../../src/errors/catalog.js';
import { StoreClient } from '../../src/store/client.js';
import type { RenewRequest, RenewResult, Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { LeaseKeeper, type LeaseHost } from '../../src/worker/lease.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { SCOPE, claimJobs, newJob } from '../helpers/store.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type RenewFn = (s: Scope, r: RenewRequest) => Promise<RenewResult>;
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

/**
 * A keeper over a MemoryStore. `manual` gives the store a hand-driven clock (`clock.t`); otherwise the
 * store reads the (faked) wall clock. Renews are timed with `performance.now()`.
 */
async function world(o: { manual?: boolean; random?: number; leaseMsFor?: (n: string | null) => number; renew?: (inner: MemoryStore) => RenewFn } = {}) {
  useFakeTime();
  const clock = { t: 5_000_000 };
  const inner = new MemoryStore({ clock: o.manual ? () => clock.t : () => Date.now() });
  await inner.open();
  const renewAt: number[] = [];
  const renews: RenewRequest[] = [];
  const renew = o.renew?.(inner) ?? ((s: Scope, r: RenewRequest) => inner.renew(s, r));
  // Delegates to the store and times renews on the pod's monotonic clock (no Date.now reads).
  const spied = new Proxy(inner, {
    get(target, key) {
      if (key === 'renew') {
        return (s: Scope, r: RenewRequest) => {
          renewAt.push(performance.now());
          renews.push(r);
          return renew(s, r);
        };
      }
      const v: unknown = Reflect.get(target, key);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Store;
  const host = { client: new StoreClient(spied), scope: SCOPE, report: vi.fn(), onLost: vi.fn() } satisfies LeaseHost;
  const keeper = new LeaseKeeper(host, { leaseMsFor: o.leaseMsFor ?? (() => 30_000), random: () => o.random ?? 0.5 });
  const t0 = performance.now();
  const claim = async (name?: string, hold?: true) => {
    await inner.add(SCOPE, [newJob(name === undefined ? {} : { name })]);
    const sentAt = performance.now();
    const res = await inner.claim(SCOPE, { workerId: 'w1', limit: 1, leaseMs: o.leaseMsFor?.(name ?? null) ?? 30_000, claimId: `c${Math.random()}`, names: [name ?? null], ...(hold && { hold }) });
    const job = res.jobs[0]!;
    const abort = new AbortController();
    keeper.track(job, abort, { now: res.now, sentAt });
    return { job, abort, res, sentAt };
  };
  const since = () => renewAt.map((t) => t - t0);
  return { inner, clock, host, keeper, claim, since, t0, renews };
}

describe('LeaseKeeper', () => {
  it('lease: heartbeat renews every leaseDuration divided by 3', async () => {
    const w = await world();
    await w.claim();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.since()).toEqual([10_000, 20_000, 30_000]);
    w.keeper.stop();
  });

  it('lease: heartbeat uses jitter within 10 percent', async () => {
    for (const [random, first] of [[0, 9000], [1, 11_000]] as const) {
      const w = await world({ random });
      await w.claim();
      await vi.advanceTimersByTimeAsync(12_000);
      expect(w.since()[0]).toBe(first);
      w.keeper.stop();
      vi.useRealTimers();
    }
  });

  it('lease: heartbeat renewals for one job never overlap', async () => {
    const g = gate();
    let gated = true;
    const w = await world({ renew: (inner) => async (s, r) => {
      if (gated) {
        gated = false;
        await g.p;
      }
      return inner.renew(s, r);
    } });
    await w.claim();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(w.since()).toEqual([10_000]);
    g.open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.since()).toEqual([10_000, 20_000]);
    w.keeper.stop();
  });

  it('lease: heartbeat stops when the handler finishes, throws or is aborted', async () => {
    const w = await world();
    const a = await w.claim();
    const b = await w.claim();
    w.keeper.stopHeartbeat(a.job.id);
    w.keeper.untrack(b.job.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.since()).toEqual([]);
    expect(a.abort.signal.aborted).toBe(false);
    w.keeper.untrack(a.job.id);

    // A renew in flight when the heartbeat stops: its late answer changes nothing.
    const g = gate();
    const v = await world({ renew: (inner) => async (s, r) => {
      await g.p;
      return inner.renew(s, r);
    } });
    const c = await v.claim();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.since()).toEqual([10_000]);
    const before = { lease: v.keeper.lease(c.job.id), deadline: v.keeper.deadline(c.job.id) };
    v.keeper.stopHeartbeat(c.job.id);
    await vi.advanceTimersByTimeAsync(5000);
    g.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect({ lease: v.keeper.lease(c.job.id), deadline: v.keeper.deadline(c.job.id) }).toEqual(before);
    expect(v.since()).toEqual([10_000]);
    expect(c.abort.signal.aborted).toBe(false);
  });

  it('lease: rejected renew aborts ctx.signal with LeaseLostError and emits leaseLost once', async () => {
    const w = await world({ manual: true });
    const { job, abort } = await w.claim();
    w.clock.t += 31_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abort.signal.aborted).toBe(true);
    const reason = abort.signal.reason as LeaseLostError;
    expect(reason).toBeInstanceOf(LeaseLostError);
    expect(reason).toMatchObject({ reason: 'expired', jobId: job.id, token: job.lease!.token });
    expect(w.keeper.isLost(job.id)).toBe(true);
    w.keeper.lost(job.id, 'expired');
    expect(w.host.onLost).toHaveBeenCalledTimes(1);
    expect(w.host.onLost).toHaveBeenCalledWith({ job, token: job.lease!.token, reason: 'expired' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.since()).toEqual([10_000]);

    // Superseded: the sweep requeued it and another worker holds it now.
    const v = await world({ manual: true });
    const second = await v.claim();
    v.clock.t += 31_000;
    await v.inner.sweep(SCOPE, { limit: 100, maxCrashes: 3, failError: '{}', poisonError: '{}' });
    const [again] = await claimJobs(v.inner, SCOPE, { workerId: 'w2', leaseMs: 30_000 });
    expect(again!.lease!.token).toBeGreaterThan(second.job.lease!.token);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((second.abort.signal.reason as LeaseLostError).reason).toBe('superseded');
    expect(v.host.onLost).toHaveBeenCalledTimes(1);
  });

  it('fencing: a newer attempt of the same job supersedes the older one and only the older one', async () => {
    const w = await world({ manual: true });
    const first = await w.claim();
    w.clock.t += 31_000;
    await w.inner.sweep(SCOPE, { limit: 100, maxCrashes: 3, failError: '{}', poisonError: '{}' });
    const res = await w.inner.claim(SCOPE, { workerId: 'w1', limit: 1, leaseMs: 30_000, claimId: 'again' });
    const job = res.jobs[0]!;
    const abort = new AbortController();
    w.keeper.track(job, abort, { now: res.now, sentAt: performance.now() });
    const [t1, t2] = [first.job.lease!.token, job.lease!.token];
    expect((first.abort.signal.reason as LeaseLostError)).toMatchObject({ reason: 'superseded', token: t1 });
    expect(w.host.onLost).toHaveBeenCalledTimes(1);
    expect(w.keeper.isLost(job.id, t1)).toBe(true);
    expect(w.keeper.isLost(job.id)).toBe(false);
    w.keeper.untrack(job.id, t1);
    expect(w.keeper.lease(job.id, t2)).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(abort.signal.aborted).toBe(false);
    expect(w.keeper.lease(job.id)!.token).toBe(t2);
    w.keeper.stop();
  });

  it('fencing: tracking an attempt that is already tracked, or an older one, aborts nothing', async () => {
    const w = await world({ manual: true });
    const first = await w.claim();
    w.clock.t += 31_000;
    await w.inner.sweep(SCOPE, { limit: 100, maxCrashes: 3, failError: '{}', poisonError: '{}' });
    const res = await w.inner.claim(SCOPE, { workerId: 'w1', limit: 1, leaseMs: 30_000, claimId: 'again' });
    const newer = { job: res.jobs[0]!, abort: new AbortController() };
    w.keeper.track(newer.job, newer.abort, { now: res.now, sentAt: performance.now() });
    // The store hands out the newer attempt again, then the older one: neither running attempt is aborted.
    w.keeper.track(newer.job, new AbortController(), { now: res.now, sentAt: performance.now() });
    w.keeper.track(first.job, new AbortController(), { now: res.now, sentAt: performance.now() });
    expect(newer.abort.signal.aborted).toBe(false);
    expect(w.host.onLost).toHaveBeenCalledTimes(1);
    expect(w.host.onLost).toHaveBeenCalledWith(expect.objectContaining({ token: first.job.lease!.token, reason: 'superseded' }));
    // Neither repeat got an entry of its own: no stray renew or expiry, and lookups find the newer attempt.
    w.keeper.untrack(newer.job.id, first.job.lease!.token);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.keeper.lease(newer.job.id)!.token).toBe(newer.job.lease!.token);
    expect(w.host.onLost).toHaveBeenCalledTimes(1);
    expect(newer.abort.signal.aborted).toBe(false);
    w.keeper.untrack(newer.job.id, newer.job.lease!.token);
    expect(w.keeper.lease(newer.job.id)).toBeUndefined();
    w.keeper.stop();
  });

  it('lease: store outage during renew retries until the local deadline then aborts locally', async () => {
    const w = await world({ renew: () => () => Promise.reject(new StoreUnavailableError('down', { operation: 'renew', retryable: true, outcomeUnknown: false })) });
    const { job, abort } = await w.claim();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(w.since().slice(0, 3)).toEqual([10_000, 11_000, 12_000]);
    expect(w.since().at(-1)).toBe(29_000);
    expect(w.host.report).toHaveBeenCalledTimes(1);
    expect(w.host.report).toHaveBeenCalledWith(expect.any(StoreUnavailableError), 'store', 'renew', job.id);
    expect(abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((abort.signal.reason as LeaseLostError).reason).toBe('expired');
    expect(w.host.onLost).toHaveBeenCalledTimes(1);
    const count = w.since().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.since().length).toBe(count);
  });

  it('lease: a hung renew still aborts at the local deadline', async () => {
    const w = await world({ renew: () => () => new Promise<RenewResult>(() => {}) });
    const { abort } = await w.claim();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((abort.signal.reason as LeaseLostError).reason).toBe('expired');
    expect(w.since()).toEqual([10_000]);
  });

  it('lease: local deadline is computed from monotonic send time and store remaining', async () => {
    const w = await world({ manual: true });
    await w.inner.add(SCOPE, [newJob()]);
    const res = await w.inner.claim(SCOPE, { workerId: 'w1', limit: 1, leaseMs: 30_000, claimId: 'x' });
    w.keeper.track(res.jobs[0]!, new AbortController(), { now: res.now, sentAt: 5000 });
    expect(w.keeper.deadline(res.jobs[0]!.id)).toBe(35_000);
    w.keeper.stop();

    // The renew sent at pod time t0 + 10 s answers 4 s late: the deadline counts from the send.
    const g = gate();
    const v = await world({ renew: (inner) => async (s, r) => {
      await g.p;
      return inner.renew(s, r);
    } });
    const { job } = await v.claim();
    expect(v.keeper.deadline(job.id)).toBe(v.t0 + 30_000);
    await vi.advanceTimersByTimeAsync(14_000);
    g.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(v.keeper.deadline(job.id)).toBe(v.t0 + 10_000 + 30_000);
    expect(v.keeper.lease(job.id)!.expiresAt).toBe(job.lease!.expiresAt + 14_000);
    // Lateness counts from the send, as it does for a claim: the answer came 4 s after the send.
    expect(v.keeper.renewals().worstLagMs).toBe(4000);
    v.keeper.stop();
  });

  it('clock: local lease deadline derives from store remaining time', async () => {
    // The store clock is hours away from the pod's: only the remaining time matters.
    const w = await world({ manual: true });
    w.clock.t = Date.now() - 7_200_000;
    const { job, sentAt } = await w.claim();
    expect(w.keeper.deadline(job.id)).toBe(sentAt + 30_000);
    w.clock.t += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.keeper.deadline(job.id)).toBe(sentAt + 10_000 + 30_000);
    w.keeper.stop();
  });

  for (const title of ['lease: changing the pod wall clock does not change heartbeat timing', 'clock: wall clock jump on the pod does not change heartbeat or local deadline']) {
    it(title, async () => {
      const w = await world({ manual: true });
      const { job, abort } = await w.claim();
      await vi.advanceTimersByTimeAsync(15_000);
      vi.setSystemTime(Date.now() + 3_600_000);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(w.since()).toEqual([10_000, 20_000, 30_000, 40_000]);
      expect(w.keeper.deadline(job.id)).toBe(w.t0 + 40_000 + 30_000);
      expect(abort.signal.aborted).toBe(false);
      w.keeper.stop();
    });
  }

  it('clock: heartbeat and timeouts use the monotonic clock', async () => {
    let hang = false;
    const w = await world({ manual: true, renew: (inner) => (s, r) => (hang ? new Promise<RenewResult>(() => {}) : inner.renew(s, r)) });
    const { abort } = await w.claim();
    const now = vi.spyOn(Date, 'now');
    await vi.advanceTimersByTimeAsync(30_000);
    hang = true;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(w.since()).toEqual([10_000, 20_000, 30_000, 40_000]);
    expect((abort.signal.reason as LeaseLostError).reason).toBe('expired');
    w.keeper.renewals();
    expect(now).not.toHaveBeenCalled();
  });

  it("lease-config: heartbeat interval is a third of each job's own lease", async () => {
    const w = await world({ leaseMsFor: (n) => (n === 'fast' ? 3000 : 30_000) });
    const slow = await w.claim('slow');
    const fast = await w.claim('fast');
    expect(fast.job.lease!.expiresAt - fast.res.now).toBe(3000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.since().filter((t) => t % 10_000 !== 0)).toHaveLength(9); // fast: 1 s .. 9 s
    expect(w.since().filter((t) => t === 10_000)).toHaveLength(2);
    expect(fast.abort.signal.aborted || slow.abort.signal.aborted).toBe(false);
    w.keeper.stop();
  });

  it('lease: renewals report lag per job against its own interval', async () => {
    const w = await world({ leaseMsFor: (n) => (n === 'fast' ? 3000 : 30_000), renew: (inner) => (s, r) => (r.leaseMs === 3000 ? new Promise<RenewResult>(() => {}) : inner.renew(s, r)) });
    await w.claim('slow');
    await w.claim('fast');
    expect(w.keeper.renewals()).toEqual({ onTime: true, lateJobs: 0, worstLagMs: 0 });
    await vi.advanceTimersByTimeAsync(2500);
    const r = w.keeper.renewals();
    expect(r).toMatchObject({ onTime: false, lateJobs: 1 });
    expect(r.worstLagMs).toBeGreaterThanOrEqual(2000);
    w.keeper.stop();
  });

  it('lease: renewal lag counts from when the claim was sent, not from when it was tracked', async () => {
    const w = await world();
    await w.inner.add(SCOPE, [newJob()]);
    const sentAt = performance.now();
    const res = await w.inner.claim(SCOPE, { workerId: 'w1', limit: 1, leaseMs: 30_000, claimId: 'c-late', names: [null] });
    await vi.advanceTimersByTimeAsync(700);
    w.keeper.track(res.jobs[0]!, new AbortController(), { now: res.now, sentAt });
    expect(w.keeper.renewals().worstLagMs).toBe(700);
    w.keeper.stop();
  });

  it('lease: markStarted sends one renew with started and later renews omit it', async () => {
    const w = await world();
    const { job } = await w.claim(undefined, true);
    expect((await w.inner.get(SCOPE, job.id))!.lease!.held).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(w.keeper.markStarted(job.id, job.token, 'b1')).resolves.toBe(true);
    expect(w.renews).toEqual([{ id: job.id, token: job.token, leaseMs: 30_000, started: true, batchId: 'b1' }]);
    expect((await w.inner.get(SCOPE, job.id))!.lease!.held).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(w.since()).toEqual([1000, 11_000, 21_000]);
    expect(w.renews.slice(1).every((r) => !('started' in r) && !('batchId' in r))).toBe(true);
    w.keeper.stop();
  });

  it('lease: markStarted waits for an in-flight renew', async () => {
    const g = gate();
    let gated = true;
    const w = await world({ renew: (inner) => async (s, r) => {
      if (gated) {
        gated = false;
        await g.p;
      }
      return inner.renew(s, r);
    } });
    const { job } = await w.claim(undefined, true);
    await vi.advanceTimersByTimeAsync(10_000);
    const started = w.keeper.markStarted(job.id, job.token);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.renews).toHaveLength(1);
    expect(w.renews[0]!.started).toBeUndefined();
    g.open();
    await expect(started).resolves.toBe(true);
    expect(w.renews.map((r) => r.started)).toEqual([undefined, true]);
    w.keeper.stop();
  });

  it('lease: markStarted resolves false when the renew is rejected or the deadline passes', async () => {
    const w = await world({ manual: true });
    const { job } = await w.claim(undefined, true);
    w.clock.t += 31_000;
    await expect(w.keeper.markStarted(job.id, job.token)).resolves.toBe(false);
    expect(w.host.onLost).toHaveBeenCalledTimes(1);
    expect(w.host.onLost).toHaveBeenCalledWith(expect.objectContaining({ reason: 'expired' }));
    await expect(w.keeper.markStarted(job.id, job.token)).resolves.toBe(false);
    await expect(w.keeper.markStarted('nope', 1)).resolves.toBe(false);

    const v = await world({ renew: () => () => Promise.reject(new StoreUnavailableError('down', { operation: 'renew', retryable: true, outcomeUnknown: false })) });
    const held = await v.claim(undefined, true);
    let ok: boolean | undefined;
    void v.keeper.markStarted(held.job.id, held.job.token).then((r) => (ok = r));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(ok).toBeUndefined();
    expect(v.renews.every((r) => r.started === true)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(ok).toBe(false);
    expect(v.host.report).toHaveBeenCalledTimes(1);
  });
});
