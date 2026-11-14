// Batch fill and added latency under a steady trickle, for the batchMaxWait multiplier.
// Run: npx tsx bench/batch-fill.ts [seconds per cell, default 20]
import { pathToFileURL } from 'node:url';
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';
import { quantile } from './baseline.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One pod batches a trickle of `ratePerSec` jobs for `seconds` with `batchMaxWait = batchDelayMs x multiplier`.
 * Fill is the mean of jobs per batch / batchSize; latency is from the add's resolve to its batch handler's start.
 */
export async function measureBatchFill(o: { ratePerSec: number; batchDelayMs: number; multiplier: number; batchSize: number; seconds: number }): Promise<{ fill: number; p50Ms: number; p99Ms: number; jobs: number; batches: number }> {
  const q = new Queue('fill', { store: new MemoryStore(), logger: false });
  const addedAt = new Map<string, number>();
  const startedAt = new Map<string, number>();
  const sizes: number[] = [];
  q.processBatch(async (batch) => {
    const now = performance.now();
    sizes.push(batch.jobs.length);
    for (const j of batch.jobs) startedAt.set(j.id, now);
  }, { batchSize: o.batchSize, batchDelay: o.batchDelayMs, batchMaxWait: o.batchDelayMs * o.multiplier, concurrency: 1 });
  const adds: Promise<void>[] = [];
  const t0 = performance.now();
  const end = t0 + o.seconds * 1000;
  let sent = 0;
  // Each tick adds the jobs due by now, so the rate holds whatever the timer resolution.
  for (let now = t0; now < end; now = performance.now()) {
    const due = Math.floor(((now - t0) * o.ratePerSec) / 1000) - sent;
    if (due > 0) {
      sent += due;
      adds.push(q.addBulk(Array.from({ length: due }, (_, i) => ({ data: i }))).then((rs) => {
        const at = performance.now();
        for (const r of rs) if (r.ok) addedAt.set(r.job.id, at);
      }));
    }
    await sleep(Math.max(1, 1000 / o.ratePerSec));
  }
  await Promise.all(adds);
  while (startedAt.size < addedAt.size) await sleep(5);
  await q.close();
  const jobs = addedAt.size;
  const handled = sizes.reduce((a, b) => a + b, 0);
  if (jobs !== sent || handled !== jobs || startedAt.size !== jobs) throw new Error(`sent ${sent}, added ${jobs}, handled ${handled} in ${sizes.length} batches`);
  const latency = [...addedAt].map(([id, at]) => Math.max(0, startedAt.get(id)! - at));
  return { fill: sizes.reduce((a, n) => a + n / o.batchSize, 0) / sizes.length, p50Ms: quantile(latency, 0.5), p99Ms: quantile(latency, 0.99), jobs, batches: sizes.length };
}

async function main(): Promise<void> {
  const seconds = Number(process.argv[2]) || 20;
  console.log(`rate/s | batchDelay ms | multiplier | fill | added latency p50 ms | p99 ms | jobs | batches  (batchSize 50, ${seconds} s per cell)`);
  for (const ratePerSec of [10, 100, 1000]) {
    for (const batchDelayMs of [10, 50, 200]) {
      for (const multiplier of [2, 5, 10, 20]) {
        const r = await measureBatchFill({ ratePerSec, batchDelayMs, multiplier, batchSize: 50, seconds });
        console.log([ratePerSec, batchDelayMs, multiplier, r.fill.toFixed(3), r.p50Ms.toFixed(1), r.p99Ms.toFixed(1), r.jobs, r.batches].join(' | '));
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
