// Cost of one stats() read per store size (the alert interval) and of one queue.metrics() snapshot, and the wait and
// processing distributions against the default buckets and window.
// Run: node --expose-gc --max-old-space-size=8192 --import tsx bench/observability-cost.ts --metrics [minutes] | --stats
import { pathToFileURL } from 'node:url';
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';
import { PodMetrics } from '../src/metrics/metrics.js';
import { DEFAULT_BUCKETS, NameLabels } from '../src/metrics/catalogue.js';
import type { JobRecord, Store } from '../src/store/contract.js';
import type { Job } from '../src/job/job.js';
import { newStore, quantile, seed } from './baseline.js';
import { countCalls } from './lib/serial-store.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const QUANTILES = [0.5, 0.95, 0.99];

/** `store.stats(scope, {})` timed `calls` times with `waiting` waiting jobs. */
export async function measureStatsCost(o: { store: 'memory' | 'template'; waiting: number; calls: number }): Promise<{ p50Ms: number; p99Ms: number }> {
  const store = newStore(o.store);
  const q = new Queue('stats', { store, logger: false, maxBulkSize: 1000 });
  await q.ready(); // opens the store, also when nothing is seeded
  await seed(q, o.waiting);
  const scope = q.internals.scope;
  await store.stats(scope, {});
  const ms: number[] = [];
  for (let i = 0; i < o.calls; i++) {
    const t = performance.now();
    await store.stats(scope, {});
    ms.push(performance.now() - t);
  }
  await q.close();
  return { p50Ms: quantile(ms, 0.5), p99Ms: quantile(ms, 0.99) };
}

/** A store whose `stats` calls are timed; everything else is delegated untouched. */
function timeStats(inner: Store): Store & { statsMs(): number } {
  let total = 0;
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'statsMs') return () => total;
      if (prop === 'stats') {
        return async (...args: Parameters<Store['stats']>) => {
          const t = performance.now();
          try {
            return await target.stats(...args);
          } finally {
            total += performance.now() - t;
          }
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Store & { statsMs(): number };
}

const waitAndProcessing = (job: Job) => ({ wait: (job.startedAt! - job.runAt) / 1000, processing: (job.finishedAt! - job.startedAt!) / 1000 });

/**
 * `jobs` no-op jobs over `names` job names run on one pod with metrics on; then the store calls made by one
 * `queue.metrics()` (the worker closed, so nothing else calls the store) and the p99 of its local work (its time
 * less the stats read) over 200 snapshots. The p50/p95/p99 of wait and processing seconds come from the raw samples.
 */
export async function measureSnapshot(o: { names: number; jobs: number }): Promise<{ storeReads: number; localP99Ms: number; waitQuantiles: number[]; processingQuantiles: number[] }> {
  const store = countCalls(timeStats(new MemoryStore()));
  const q = new Queue('snapshot', { store, logger: false });
  const names = Array.from({ length: o.names }, (_, i) => `n${i}`);
  const waits: number[] = [];
  const processing: number[] = [];
  q.on('completed', ({ job }) => {
    const s = waitAndProcessing(job);
    waits.push(s.wait);
    processing.push(s.processing);
  });
  const w = q.process(Object.fromEntries(names.map((n) => [n, () => undefined])), { concurrency: 100 });
  for (let at = 0; at < o.jobs; at += 1000) await q.addBulk(Array.from({ length: Math.min(1000, o.jobs - at) }, (_, i) => ({ data: i, opts: { name: names[(at + i) % names.length]! } })));
  while (waits.length < o.jobs) await sleep(5);
  await w.close();
  await sleep(50);
  const before = store.calls();
  await q.metrics();
  const after = store.calls();
  const storeReads = Object.keys(after).reduce((n, k) => n + after[k]! - (before[k] ?? 0), 0);
  const local: number[] = [];
  for (let i = 0; i < 200; i++) {
    const statsBefore = store.statsMs();
    const t = performance.now();
    await q.metrics();
    local.push(performance.now() - t - (store.statsMs() - statsBefore));
  }
  await q.close();
  return { storeReads, localP99Ms: quantile(local, 0.99), waitQuantiles: QUANTILES.map((p) => quantile(waits, p)), processingQuantiles: QUANTILES.map((p) => quantile(processing, p)) };
}

/**
 * The mixed load: `ratePerSec` jobs, handlers sleeping 1 ms / 50 ms / 2 s / 20 s in a 70/20/9/1 split, for
 * `seconds`. Returns the raw wait and processing quantiles and `sureq_throughput_per_second` (all names) sampled every
 * 15 s once the 5-minute window is full.
 */
export async function measureMixed(o: { ratePerSec: number; seconds: number }): Promise<{ waitQuantiles: number[]; processingQuantiles: number[]; throughput: number[]; jobs: number }> {
  const q = new Queue('mixed', { store: new MemoryStore(), logger: false });
  const sleeps: Record<string, number> = { fast: 1, mid: 50, slow: 2000, long: 20_000 };
  const pick = (i: number) => { const r = i % 100; return r < 70 ? 'fast' : r < 90 ? 'mid' : r < 99 ? 'slow' : 'long'; };
  const waits: number[] = [];
  const processing: number[] = [];
  q.on('completed', ({ job }) => {
    const s = waitAndProcessing(job);
    waits.push(s.wait);
    processing.push(s.processing);
  });
  q.process(Object.fromEntries(Object.entries(sleeps).map(([n, ms]) => [n, () => sleep(ms)])), { concurrency: 2000 });
  const throughput: number[] = [];
  const t0 = performance.now();
  const end = t0 + o.seconds * 1000;
  let nextSample = t0 + 300_000;
  let sent = 0;
  while (performance.now() < end) {
    const now = performance.now();
    const due = Math.floor(((now - t0) * o.ratePerSec) / 1000) - sent;
    if (due > 0) {
      const from = sent;
      sent += due;
      void q.addBulk(Array.from({ length: due }, (_, i) => ({ data: null, opts: { name: pick(from + i) } })));
    }
    if (now >= nextSample) {
      nextSample += 15_000;
      const snap = await q.metrics();
      throughput.push(snap.samples.filter((s) => s.name === 'sureq_throughput_per_second').reduce((n, s) => n + ('value' in s ? s.value : 0), 0));
    }
    await sleep(Math.max(1, 1000 / o.ratePerSec));
  }
  await q.close({ timeoutMs: 30_000 });
  return { waitQuantiles: QUANTILES.map((p) => quantile(waits, p)), processingQuantiles: QUANTILES.map((p) => quantile(processing, p)), throughput, jobs: waits.length };
}

/** Heap held by the window bookkeeping of one pod after a full window at `ratePerSec` over `names` names (needs --expose-gc). */
export function measureWindowHeap(o: { ratePerSec: number; names: number; windowMs: number }): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return NaN;
  const c = { t: 0 };
  let m: PodMetrics | undefined = new PodMetrics({ base: { namespace: 'default', queue: 'heap' }, windowMs: o.windowMs, buckets: DEFAULT_BUCKETS, names: new NameLabels(o.names, () => undefined), now: () => c.t });
  const total = (o.ratePerSec * o.windowMs) / 1000;
  for (let i = 0; i < total; i++) {
    c.t = (i * 1000) / o.ratePerSec;
    const rec = { name: `n${i % o.names}`, runAt: c.t, startedAt: c.t } as JobRecord;
    m.attemptStarted(rec);
    m.attemptEnded(rec, 'completed', c.t + 1);
  }
  if (m.samples().length === 0) throw new Error('no samples');
  // What the pod's metrics hold: the heap with them alive, less the heap once they are dropped.
  gc();
  const held = process.memoryUsage().heapUsed;
  m = undefined;
  gc();
  return held - process.memoryUsage().heapUsed;
}

/** A distribution's quantile between 5 ms and 60 s that falls in a bucket wider than 3x, with the bound to add there. */
export function bucketFindings(quantiles: number[], buckets: readonly number[] = DEFAULT_BUCKETS): Array<{ value: number; lo: number; hi: number; add: number }> {
  const out: Array<{ value: number; lo: number; hi: number; add: number }> = [];
  for (const v of quantiles.filter((x) => x >= 0.005 && x <= 60)) {
    const i = buckets.findIndex((le) => v <= le);
    const lo = i > 0 ? buckets[i - 1]! : 0;
    const hi = buckets[i]!;
    if (lo > 0 && hi / lo > 3) out.push({ value: v, lo, hi, add: Math.sqrt(lo * hi) });
  }
  return out;
}

async function main(): Promise<void> {
  const f = (x: number) => x.toFixed(3);
  if (process.argv.includes('--stats')) {
    console.log('store | waiting jobs | stats() p50 ms | p99 ms | 400 x p99 ms (keep 15 s if at most 15000)');
    for (const store of ['memory', 'template'] as const) {
      for (const waiting of [0, 10_000, 100_000, 1_000_000]) {
        if (store === 'template' && waiting > 100_000) continue;
        const r = await measureStatsCost({ store, waiting, calls: 200 });
        console.log([store, waiting, f(r.p50Ms), f(r.p99Ms), (400 * r.p99Ms).toFixed(0)].join(' | '));
      }
    }
  } else if (process.argv.includes('--metrics')) {
    const minutes = Number(process.argv[process.argv.indexOf('--metrics') + 1]) || 10;
    const snap = await measureSnapshot({ names: 100, jobs: 20_000 });
    console.log(`snapshot, 100 names, 15 buckets, 20 000 jobs: ${snap.storeReads} store reads, local work p99 ${f(snap.localP99Ms)} ms`);
    console.log(`baseline load: wait p50/p95/p99 s ${snap.waitQuantiles.map(f).join(' / ')}; processing ${snap.processingQuantiles.map(f).join(' / ')}`);
    console.log(`window bookkeeping heap, 1000 jobs/s, 100 names, 5m window: ${(measureWindowHeap({ ratePerSec: 1000, names: 100, windowMs: 300_000 }) / 1e6).toFixed(2)} MB`);
    const mixed = await measureMixed({ ratePerSec: 1000, seconds: minutes * 60 });
    console.log(`mixed load, 1000 jobs/s, ${minutes} min, ${mixed.jobs} jobs: wait p50/p95/p99 s ${mixed.waitQuantiles.map(f).join(' / ')}; processing ${mixed.processingQuantiles.map(f).join(' / ')}`);
    const mean = mixed.throughput.reduce((a, b) => a + b, 0) / mixed.throughput.length;
    console.log(`throughput gauge every 15 s after 5 min: ${mixed.throughput.map((x) => x.toFixed(0)).join(', ')}; spread ${(((Math.max(...mixed.throughput) - mean) / mean) * 100).toFixed(1)} % / ${(((Math.min(...mixed.throughput) - mean) / mean) * 100).toFixed(1)} % around the mean ${mean.toFixed(0)}`);
    const findings = bucketFindings([...snap.waitQuantiles, ...snap.processingQuantiles, ...mixed.waitQuantiles, ...mixed.processingQuantiles]);
    console.log(`bucket findings (quantile in a bucket wider than 3x): ${findings.length === 0 ? 'none' : findings.map((x) => `${f(x.value)} in (${x.lo}, ${x.hi}] add ${f(x.add)}`).join('; ')}`);
  } else {
    console.error('usage: observability-cost.ts --metrics [minutes] | --stats');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
