import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { serialStore } from '../../bench/lib/serial-store.js';
import { measureClaims } from '../../bench/claim-throughput.js';
import { measureIdleClaims, measurePickup } from '../../bench/poll-latency.js';
import { compareBaseline, measureBaseline } from '../../bench/baseline.js';
import { measureBatchFill } from '../../bench/batch-fill.js';
import { measureProgress } from '../../bench/progress-writes.js';
import { measureSnapshot, measureStatsCost } from '../../bench/observability-cost.js';

const BASELINE_KEYS = [
  'throughput.pods1.jobsPerSec', 'throughput.pods20.jobsPerSec', 'throughput.pods20.modelled.jobsPerSec',
  ...['memory', 'template'].flatMap((s) => ['claim.limit1', 'claim.limit10', 'complete'].flatMap((k) => [`${s}.${k}.p50Ms`, `${s}.${k}.p99Ms`])),
  'endToEnd.p50Ms', 'endToEnd.p99Ms', 'cancel.p50Ms', 'cancel.p99Ms', 'cancel.storeCalls', 'idle.claimsPerMin', 'idle.pod.callsPerMin',
];

afterEach(() => vi.useRealTimers());

describe('bench harness', () => {
  it('bench: serial store holds one claim at a time and delegates everything else', async () => {
    vi.useFakeTimers();
    const inner = new MemoryStore();
    await inner.open();
    const store = serialStore(inner, { baseMs: 5, rowMs: 0, skipLocked: false });
    const claim = (queue: string) => store.claim({ namespace: 'default', queue }, { workerId: 'w', limit: 1, leaseMs: 1000, claimId: queue + Math.random() });
    const pending = [claim('a'), claim('a'), claim('a'), claim('b')];
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all(pending);
    const waits = store.lockWaitMs();
    // a, b, a, a in order of lock acquisition: the second and third claim on "a" queue behind the first.
    expect(waits.filter((w) => w >= 10)).toHaveLength(1);
    expect(waits.filter((w) => w >= 5 && w < 10)).toHaveLength(1);
    expect(waits.filter((w) => w < 5)).toHaveLength(2);
    expect(store.capabilities.skipLocked).toBe(false);
    expect(serialStore(inner, { baseMs: 0, rowMs: 0, skipLocked: true }).capabilities.skipLocked).toBe(true);
    expect(await store.counts({ namespace: 'default', queue: 'a' })).toEqual(await inner.counts({ namespace: 'default', queue: 'a' }));
    expect(await store.get({ namespace: 'default', queue: 'a' }, 'missing')).toBeNull();
    expect(store.contractVersion).toBe(inner.contractVersion);
  });

  it('bench: claim throughput harness drains every job and reports rows', async () => {
    const base = { pods: 3, queues: 1, jobs: 300, limit: 10, jitter: 0.5, constraints: true };
    for (const model of [null, { baseMs: 1, rowMs: 0 }]) {
      const r = await measureClaims({ ...base, model });
      expect(r.completed).toBe(300);
      if (model) expect(r.lockWaitP99Ms).toBeGreaterThan(0);
      expect(r.jobsPerSec).toBeGreaterThan(0);
      expect(r.emptyClaimFraction).toBeGreaterThanOrEqual(0);
      expect(r.emptyClaimFraction).toBeLessThanOrEqual(1);
    }
    const streamed = await measureClaims({ ...base, model: null, stream: { batch: 100, everyMs: 5 } });
    expect(streamed.completed).toBe(300);
  });

  it('bench: poll latency harness measures pickup and idle claim calls', async () => {
    const p = await measurePickup({ pollMin: 20, pollMax: 100, notify: false, samples: 3 });
    expect(p.maxMs).toBeGreaterThanOrEqual(p.p95Ms);
    expect(p.p95Ms).toBeGreaterThanOrEqual(p.p50Ms);
    expect(p.p50Ms).toBeGreaterThan(0);
    const idle = await measureIdleClaims({ workers: 2, seconds: 1, pollMin: 20, pollMax: 100 });
    expect(idle.claimCalls).toBeGreaterThan(0);
    expect(idle.budget).toBeCloseTo((2 * 1 / 0.1) * 1.3);
  });

  it('bench: baseline harness drains every job and reports every row', async () => {
    const rows = await measureBaseline({ scale: 0.01 });
    expect(Object.keys(rows).sort()).toEqual([...BASELINE_KEYS].sort());
    for (const [k, v] of Object.entries(rows)) {
      expect(Number.isFinite(v), k).toBe(true);
      expect(v, k).toBeGreaterThan(0);
    }
    // a waiting job's cancel reads it, cancels it, reads it back and counts the queue for the drained check
    expect(rows['cancel.storeCalls']).toBeLessThanOrEqual(4);
  }, 60_000);

  it('bench: baseline compare flags a slower row and ignores a faster one', () => {
    const [a, b] = compareBaseline({ 'a.jobsPerSec': 100, 'b.p99Ms': 10 }, { 'a.jobsPerSec': 70, 'b.p99Ms': 8 });
    expect(a).toMatchObject({ key: 'a.jobsPerSec', slower: true });
    expect(a!.ratio).toBeCloseTo(0.7);
    expect(b).toMatchObject({ key: 'b.p99Ms', slower: false });
    expect(compareBaseline({ 'a.jobsPerSec': 100 }, { 'a.jobsPerSec': 130 })[0]!.slower).toBe(false);
    expect(compareBaseline({ 'b.p99Ms': 10 }, { 'b.p99Ms': 13 })[0]!.slower).toBe(true);
    const missing = compareBaseline({ 'c.p50Ms': 1 }, {})[0]!;
    expect(missing.now).toBeNaN();
    expect(missing.slower).toBe(true);
  });

  it('bench: batch fill harness accounts for every job once', async () => {
    const r = await measureBatchFill({ ratePerSec: 200, batchDelayMs: 10, multiplier: 5, batchSize: 10, seconds: 1 });
    expect(r.jobs).toBeGreaterThan(100);
    expect(r.batches).toBeGreaterThan(0);
    expect(r.batches).toBeGreaterThanOrEqual(Math.ceil(r.jobs / 10));
    expect(r.fill).toBeGreaterThan(0);
    expect(r.fill).toBeLessThanOrEqual(1);
    expect(r.p99Ms).toBeGreaterThanOrEqual(r.p50Ms);
  });

  it('bench: progress harness counts store writes and event lag', async () => {
    const p = await measureProgress({ intervalMs: 50, jobs: 3, seconds: 0.5, drainJobs: 100 });
    expect(p.writesPerSec).toBeGreaterThan(0);
    expect(p.writesPerSec).toBeLessThanOrEqual(3 * (1000 / 50) * 1.2);
    expect(p.lagP99Ms).toBeGreaterThanOrEqual(0);
    expect(p.drainPerSec).toBeGreaterThan(0);
    expect(p.drainPerSecBaseline).toBeGreaterThan(0);
    const s = await measureStatsCost({ store: 'memory', waiting: 100, calls: 20 });
    expect(s.p50Ms).toBeGreaterThan(0);
    expect(s.p99Ms).toBeGreaterThanOrEqual(s.p50Ms);
    const snap = await measureSnapshot({ names: 3, jobs: 50 });
    expect(snap.storeReads).toBe(1);
    expect(snap.waitQuantiles).toHaveLength(3);
  });
});
