import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { DEFAULT_BUCKETS, describeMetrics, NameLabels, type MetricSample, type MetricsSnapshot } from '../../src/metrics/catalogue.js';
import { PodMetrics } from '../../src/metrics/metrics.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import type { JobRecord, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { TaskFailure } from '../../src/worker/batch.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { collect, silent } from '../helpers/harness.js';
import { killClaim } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

/** A store with a hand-driven clock and queues `h` on it; the timers (and `performance`) are faked. */
function world(o: { queue?: QueueOptions; wrap?: (raw: MemoryStore, clock: { now: number }) => Store } = {}) {
  useFakeTime();
  const clock = { now: 1_000_000 };
  const raw = new MemoryStore({ clock: () => clock.now });
  const store = o.wrap?.(raw, clock) ?? raw;
  const pod = (q: QueueOptions = {}) => {
    const queue = new Queue('h', { logger: silent, ...o.queue, ...q, store });
    queues.push(queue);
    return queue;
  };
  return { raw, store, clock, q: pod(), pod, scope: { namespace: 'default', queue: 'h' } };
}

const run = { ...poll(10), random: () => 0.5, sweepInterval: 3_600_000, acknowledgeVolatileStore: true };

const of = (snap: MetricsSnapshot, name: string, labels: Record<string, string> = {}): MetricSample[] =>
  snap.samples.filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v));
const value = (snap: MetricsSnapshot, name: string, labels: Record<string, string> = {}): number | undefined => {
  const s = of(snap, name, labels);
  return s.length === 0 ? undefined : s.reduce((n, x) => n + ('value' in x ? x.value : 0), 0);
};
const hist = (snap: MetricsSnapshot, name: string, labels: Record<string, string> = {}) =>
  of(snap, name, labels).reduce((t, s) => ('count' in s ? { count: t.count + s.count, sum: t.sum + s.sum } : t), { count: 0, sum: 0 });

describe('metrics catalogue and options', () => {
  it('metrics: describeMetrics lists exactly the catalogue names, types, labels and units', () => {
    const ext = (...l: string[]) => ['namespace', 'queue', ...l];
    expect(describeMetrics().map((d) => [d.name, d.type, d.unit, d.labels])).toEqual([
      ['sureq_jobs', 'gauge', 'jobs', ext('state')],
      ['sureq_jobs_added_total', 'counter', 'jobs', ext('name')],
      ['sureq_jobs_finished_total', 'counter', 'jobs', ext('name', 'outcome')],
      ['sureq_jobs_crashed_total', 'counter', 'jobs', ext('name')],
      ['sureq_attempts_retried_total', 'counter', 'jobs', ext('name')],
      ['sureq_job_wait_seconds', 'histogram', 'seconds', ext('name')],
      ['sureq_job_processing_seconds', 'histogram', 'seconds', ext('name', 'outcome')],
      ['sureq_job_processing_peak_seconds', 'gauge', 'seconds', ext('name')],
      ['sureq_success_ratio', 'gauge', 'ratio', ext('name')],
      ['sureq_throughput_per_second', 'gauge', 'jobs_per_second', ext('name')],
      ['sureq_oldest_waiting_age_seconds', 'gauge', 'seconds', ext()],
      ['sureq_alert_firing', 'gauge', 'ratio', ext('type')],
      ['sureq_jobs_rejected_total', 'counter', 'jobs', ext('name')],
      ['sureq_batch_held_seconds', 'histogram', 'seconds', ext('name')],
    ]);
    for (const d of describeMetrics()) expect(d.help.length).toBeGreaterThan(0);
    const first = describeMetrics();
    first.pop();
    first[0]!.labels.push('x');
    expect(describeMetrics()).toHaveLength(14);
    expect(describeMetrics()[0]!.labels).toEqual(ext('state'));
  });

  it('metrics: histogram buckets not ascending throw InvalidOptionError', () => {
    const pathOf = (metrics: unknown) => {
      try {
        new Queue('m', { logger: silent, metrics: metrics as NonNullable<QueueOptions['metrics']> });
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidOptionError);
        return (e as InvalidOptionError).issues.map((i) => i.path);
      }
      return [];
    };
    for (const buckets of [[1, 0.5], [0.1, 0.1], [], [0, 1], [1, Infinity]]) expect(pathOf({ buckets }), String(buckets)).toEqual(['metrics.buckets']);
    expect(pathOf({ window: '30s' })).toEqual(['metrics.window']);
    expect(pathOf({ window: '2d' })).toEqual(['metrics.window']);
    expect(pathOf({ maxNameLabels: 0 })).toEqual(['metrics.maxNameLabels']);
    const q = new Queue('m', { logger: silent, metrics: { buckets: [1, 2], window: '1m' } });
    expect(q.internals.alerts).toBeUndefined();
    void q.close();
  });

  it('metrics: name labels keep the first names and fold the rest into __other__', () => {
    const warn = vi.fn();
    const names = new NameLabels(2, warn);
    expect(names.label('a')).toBe('a');
    expect(names.label('b')).toBe('b');
    expect(names.label('c')).toBe('__other__');
    expect(names.label('d')).toBe('__other__');
    expect(names.label('a')).toBe('a');
    expect(warn).toHaveBeenCalledOnce();
    expect(new NameLabels(2, warn).label(null)).toBe('');
  });
});

describe('queue.metrics()', () => {
  it('metrics: sureq_jobs has all six states and matches the store from any pod', async () => {
    const w = world();
    const other = w.pod();
    const finish = async (how: 'complete' | 'fail') => {
      await w.q.add(how, { maxAttempts: 1 });
      const rec = await killClaim(w.raw, 'h');
      if (how === 'complete') await w.raw.complete(w.scope, { id: rec.id, token: rec.token, result: null });
      else await w.raw.fail(w.scope, { id: rec.id, token: rec.token, error: '{"v":1,"name":"E","message":"x"}' });
    };
    await finish('complete');
    await finish('fail');
    await w.q.add('active');
    await killClaim(w.raw, 'h');
    const { job } = await w.q.add('cancel');
    await w.q.cancel(job.id);
    await w.q.add('delayed', { delay: 60_000 });
    await w.q.add('waiting');
    const counts = await w.q.getCounts();
    for (const snap of [await w.q.metrics(), await other.metrics()]) {
      const jobs = of(snap, 'sureq_jobs');
      expect(jobs.map((s) => s.labels)).toEqual(['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].map((state) => ({ namespace: 'default', queue: 'h', state })));
      for (const s of jobs) expect('value' in s && s.value, s.labels['state']).toBe(counts[s.labels['state'] as keyof typeof counts]);
      expect(snap.at).toBe(w.clock.now);
      expect(snap.scope['sureq_jobs']).toBe('cluster');
      expect(snap.scope['sureq_job_wait_seconds']).toBe('pod');
    }
  });

  it('metrics: success ratio is omitted with no finished jobs', async () => {
    const w = world();
    const snap = await w.q.metrics();
    expect(of(snap, 'sureq_jobs').map((s) => ('value' in s ? s.value : -1))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(snap.samples.some((s) => 'count' in s)).toBe(false);
    expect(of(snap, 'sureq_success_ratio')).toEqual([]);
    expect(value(snap, 'sureq_oldest_waiting_age_seconds')).toBe(0);
  });

  it('metrics: wait excludes delay and is measured per attempt', async () => {
    const w = world();
    await w.q.add('later', { delay: 3_600_000 });
    w.q.process(() => 'ok', run);
    w.clock.now += 3_600_000;
    await vi.advanceTimersByTimeAsync(50);
    const first = await w.q.metrics();
    expect(hist(first, 'sureq_job_wait_seconds')).toEqual({ count: 1, sum: 0 });

    let n = 0;
    const v = w.pod();
    const done = collect(v, 'completed', 1);
    v.process({ flaky: () => (++n < 3 ? Promise.reject(new Error('again')) : 'ok') }, run);
    await v.add(1, { name: 'flaky', maxAttempts: 3, backoff: 0 });
    await vi.advanceTimersByTimeAsync(200);
    await done;
    const snap = await v.metrics();
    expect(hist(snap, 'sureq_job_wait_seconds', { name: 'flaky' }).count).toBe(3);
    expect(value(snap, 'sureq_jobs_finished_total', { name: 'flaky', outcome: 'completed' })).toBe(1);
    expect(value(snap, 'sureq_attempts_retried_total', { name: 'flaky' })).toBe(2);
    expect(hist(snap, 'sureq_job_processing_seconds', { name: 'flaky', outcome: 'failed' }).count).toBe(2);
  });

  it('metrics: wait and processing are separate histograms', async () => {
    const w = world();
    w.q.process(async () => {
      w.clock.now += 2000;
      return 'ok';
    }, run);
    const done = collect(w.q, 'completed', 1);
    await w.q.add(1);
    await vi.advanceTimersByTimeAsync(50);
    await done;
    const snap = await w.q.metrics();
    expect(hist(snap, 'sureq_job_processing_seconds', { outcome: 'completed' })).toEqual({ count: 1, sum: 2 });
    expect(hist(snap, 'sureq_job_wait_seconds')).toEqual({ count: 1, sum: 0 });
    expect(of(snap, 'sureq_job_wait_seconds')[0]!.labels).toEqual({ namespace: 'default', queue: 'h', name: '' });
    const processing = of(snap, 'sureq_job_processing_seconds')[0]!;
    expect('buckets' in processing && processing.buckets.find((b) => b.le === 2.5)?.count).toBe(1);
    expect('buckets' in processing && processing.buckets.find((b) => b.le === 1)?.count).toBe(0);
  });

  it('metrics: processing uses store time under pod clock skew ±1h', async () => {
    for (const skew of [3_600_000, -3_600_000]) {
      const w = world();
      w.q.process(async () => {
        vi.setSystemTime(Date.now() + skew);
        w.clock.now += 2000;
        return 'ok';
      }, run);
      const done = collect(w.q, 'completed', 1);
      await w.q.add(1);
      await vi.advanceTimersByTimeAsync(50);
      await done;
      expect(hist(await w.q.metrics(), 'sureq_job_processing_seconds').sum).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
      await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
    }
    useFakeTime();
  });

  it('metrics: rejected stale complete records no sample', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    w.q.process(async () => {
      started();
      await gate;
      return 'late';
    }, run);
    const lost = collect(w.q, 'leaseLost', 1);
    await w.q.add(1);
    await vi.advanceTimersByTimeAsync(50);
    await running;
    w.clock.now += 31_000;
    await w.raw.sweep(w.scope, { limit: 10, maxCrashes: 3, failError: '{}', poisonError: '{}' });
    await killClaim(w.raw, 'h');
    release();
    await vi.advanceTimersByTimeAsync(50);
    await lost;
    const snap = await w.q.metrics();
    expect(of(snap, 'sureq_job_processing_seconds')).toEqual([]);
    expect(of(snap, 'sureq_jobs_finished_total')).toEqual([]);
    expect(hist(snap, 'sureq_job_wait_seconds').count).toBe(1);
  });

  it('metrics: peak processing covers only the window', async () => {
    const w = world();
    let ms = 5000;
    // a slow poll: 12 minutes of fake time are advanced below, and adds wake the worker anyway
    w.q.process(async () => {
      w.clock.now += ms;
      return 'ok';
    }, { ...run, ...poll(1000) });
    await w.q.add(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(value(await w.q.metrics(), 'sureq_job_processing_peak_seconds')).toBe(5);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    ms = 1000;
    await w.q.add(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(value(await w.q.metrics(), 'sureq_job_processing_peak_seconds')).toBe(1);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(value(await w.q.metrics(), 'sureq_job_processing_peak_seconds')).toBe(0);
  });

  it('metrics: throughput divides by window, or by uptime for a young pod', async () => {
    const w = world({ queue: { metrics: { window: '5m' } } });
    const t0 = performance.now();
    w.q.process(() => 'ok', { ...run, ...poll(1000), concurrency: 30 });
    const batch = async () => {
      const done = collect(w.q, 'completed', 30);
      await w.q.addBulk(Array.from({ length: 30 }, (_, i) => ({ data: i })));
      await vi.advanceTimersByTimeAsync(50);
      await done;
    };
    await batch();
    await vi.advanceTimersByTimeAsync(t0 + 10_000 - performance.now());
    expect(value(await w.q.metrics(), 'sureq_throughput_per_second')).toBeCloseTo(30 / 10);
    await vi.advanceTimersByTimeAsync(t0 + 290_000 - performance.now());
    await batch();
    await vi.advanceTimersByTimeAsync(t0 + 300_000 - performance.now());
    const snap = await w.q.metrics();
    expect(value(snap, 'sureq_throughput_per_second')).toBeCloseTo(60 / 300);
    expect(value(snap, 'sureq_success_ratio')).toBe(1);
  });

  it('metrics: a steady rate reads within 5 % of itself at any point of the minute', () => {
    const clock = { t: 0 };
    const m = new PodMetrics({ base: { namespace: 'default', queue: 'q' }, windowMs: 300_000, buckets: DEFAULT_BUCKETS, names: new NameLabels(100, () => undefined), now: () => clock.t });
    const rec = { name: null, runAt: 0, startedAt: 0 } as unknown as JobRecord;
    const readings: number[] = [];
    // ten jobs a second for twenty minutes, the gauge read every 15 s
    for (let ms = 0; ms < 20 * 60_000; ms += 100) {
      clock.t = ms;
      m.attemptEnded(rec, 'completed', ms);
      if (ms % 15_000 === 0 && ms > 0) readings.push(m.samples().flatMap((x) => (x.name === 'sureq_throughput_per_second' && 'value' in x ? [x.value] : []))[0]!);
    }
    for (const r of readings) {
      expect(r).toBeGreaterThanOrEqual(10 * 0.95);
      expect(r).toBeLessThanOrEqual(10 * 1.05);
    }
  });

  it('metrics: per-name breakdown and __other__ beyond maxNameLabels', async () => {
    const warn = vi.fn();
    const w = world({ queue: { metrics: { maxNameLabels: 2 }, logger: { ...silent, warn } } });
    for (const name of ['a', 'b', 'c', 'd']) await w.q.add(1, { name });
    await w.q.add(1);
    w.q.process({ a: () => 1, c: () => 1 }, run);
    await vi.advanceTimersByTimeAsync(100);
    const snap = await w.q.metrics();
    expect(of(snap, 'sureq_jobs_added_total').map((s) => [s.labels['name'], 'value' in s && s.value])).toEqual([['a', 1], ['b', 1], ['__other__', 3]]);
    expect(of(snap, 'sureq_jobs_finished_total').map((s) => s.labels['name'])).toEqual(['a', '__other__']);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('maxNameLabels');
  });

  it('metrics: a thousand distinct job names stay bounded by maxNameLabels', async () => {
    const w = world({ queue: { metrics: { maxNameLabels: 10 } } });
    await w.q.addBulk(Array.from({ length: 1000 }, (_, i) => ({ data: i, opts: { name: `n${i}` } })));
    expect(of(await w.q.metrics(), 'sureq_jobs_added_total')).toHaveLength(11);
  });

  it('metrics: counters survive no restart but sureq_jobs does', async () => {
    const w = world();
    w.q.process(() => 'ok', run);
    await w.q.add(1);
    await w.q.add(2);
    await vi.advanceTimersByTimeAsync(100);
    const before = await w.q.metrics();
    expect(value(before, 'sureq_jobs_finished_total')).toBe(2);
    const fresh = w.pod();
    const after = await fresh.metrics();
    expect(of(after, 'sureq_jobs')).toEqual(of(before, 'sureq_jobs'));
    expect(after.samples.filter((s) => s.name !== 'sureq_jobs' && s.name !== 'sureq_oldest_waiting_age_seconds')).toEqual([]);
  });

  it('metrics: snapshot costs exactly one store read', async () => {
    let spy!: ReturnType<typeof spyStore>;
    const w = world({ wrap: (raw) => (spy = spyStore(raw)).store });
    await w.q.ready();
    await w.q.add(1);
    const from = spy.calls.length;
    await w.q.metrics();
    expect(spy.calls.slice(from).map((c) => c.op)).toEqual(['stats']);
  });

  it('metrics: a swept attempt counts as crashed, not finished', async () => {
    const w = world();
    await w.q.add(1, { name: 'work' });
    await killClaim(w.raw, 'h');
    w.clock.now += 30_001;
    w.q.process({ other: () => 1 }, { ...run, sweepInterval: 500 });
    const stalled = collect(w.q, 'stalled', 1);
    await vi.advanceTimersByTimeAsync(700);
    await stalled;
    const snap = await w.q.metrics();
    expect(value(snap, 'sureq_jobs_crashed_total', { name: 'work' })).toBe(1);
    expect(hist(snap, 'sureq_job_processing_seconds', { name: 'work', outcome: 'crashed' }).count).toBe(1);
    expect(of(snap, 'sureq_jobs_finished_total')).toEqual([]);
  });

  it('metrics: a cancelled running job counts as finished cancelled without a processing sample', async () => {
    const w = world();
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    w.q.process((_job, ctx) => {
      started();
      return new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason as Error)));
    }, run);
    const { job } = await w.q.add(1);
    await vi.advanceTimersByTimeAsync(50);
    await running;
    await w.q.cancel(job.id);
    await vi.advanceTimersByTimeAsync(50);
    const snap = await w.q.metrics();
    expect(value(snap, 'sureq_jobs_finished_total', { outcome: 'cancelled' })).toBe(1);
    expect(of(snap, 'sureq_job_processing_seconds')).toEqual([]);
    expect(value(snap, 'sureq_throughput_per_second')).toBeGreaterThan(0);
  });

  it('age: gauge is 0 and getOldestWaitingAge is null with no waiting job', async () => {
    const w = world();
    await w.q.add(1, { delay: 60_000 });
    expect(await w.q.getOldestWaitingAge()).toBeNull();
    expect(value(await w.q.metrics(), 'sureq_oldest_waiting_age_seconds')).toBe(0);
    await w.q.add(2);
    w.clock.now += 5000;
    expect(await w.q.getOldestWaitingAge()).toBe(5000);
    expect(value(await w.q.metrics(), 'sureq_oldest_waiting_age_seconds')).toBe(5);
  });

  it('metrics: batch jobs are counted per job, with their held time', async () => {
    let advanced = false;
    const w = world({
      wrap: (raw, clock) => spyStore(raw, {
        renew: (scope, req) => {
          // the batch starts 2 s of store time after its claim
          if (req.started && !advanced) {
            advanced = true;
            clock.now += 2000;
          }
          return raw.renew(scope, req);
        },
      }).store,
    });
    for (let i = 0; i < 3; i++) await w.q.add(i);
    const settled = collect(w.q, 'failed', 1);
    w.q.processBatch(async () => [1, new TaskFailure(new Error('no'), { retry: false }), 3], { ...run, batchSize: 3 });
    await vi.advanceTimersByTimeAsync(100);
    await settled;
    await vi.advanceTimersByTimeAsync(50);
    const snap = await w.q.metrics();
    expect(hist(snap, 'sureq_job_wait_seconds').count).toBe(3);
    expect(hist(snap, 'sureq_job_processing_seconds', { outcome: 'completed' }).count).toBe(2);
    expect(hist(snap, 'sureq_job_processing_seconds', { outcome: 'failed' }).count).toBe(1);
    expect(hist(snap, 'sureq_batch_held_seconds')).toEqual({ count: 3, sum: 6 });
    expect(value(snap, 'sureq_jobs_finished_total', { outcome: 'completed' })).toBe(2);
    expect(value(snap, 'sureq_jobs_finished_total', { outcome: 'failed' })).toBe(1);
  });

  it('metrics: filter rejections count by name', async () => {
    const w = world({ queue: { filter: (data) => (data === 'ok' ? true : 'no') } });
    await w.q.add('ok', { name: 'x' });
    await expect(w.q.add('bad', { name: 'x' })).rejects.toThrow();
    await expect(w.q.add('bad', { name: 'y' })).rejects.toThrow();
    const snap = await w.q.metrics();
    expect(value(snap, 'sureq_jobs_rejected_total', { name: 'x' })).toBe(1);
    expect(value(snap, 'sureq_jobs_rejected_total', { name: 'y' })).toBe(1);
    expect(value(snap, 'sureq_jobs_added_total', { name: 'x' })).toBe(1);
  });

  it('metrics: reads reject once the queue is closed', async () => {
    const q = new Queue('h', { logger: silent });
    await q.close();
    await expect(q.metrics()).rejects.toThrow(/closed/);
    await expect(q.getOldestWaitingAge()).rejects.toThrow(/closed/);
  });
});
