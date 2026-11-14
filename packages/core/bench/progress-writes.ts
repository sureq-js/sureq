// Store writes and event lag of ctx.progress, and its cost to another pod on the same store, per progressInterval.
// Run: npx tsx bench/progress-writes.ts [seconds per cell, default 5]
import { pathToFileURL } from 'node:url';
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';
import { quantile, seed } from './baseline.js';
import { countCalls } from './lib/serial-store.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `jobs` jobs on one pod each call `ctx.progress(i, total)` every 1 ms for `seconds`, while a second pod on the same
 * store drains `drainJobs` no-op jobs. The same run with the jobs only sleeping gives the drain rate without progress.
 */
export async function measureProgress(o: { intervalMs: number; jobs: number; seconds: number; drainJobs: number }): Promise<{ writesPerSec: number; lagP99Ms: number; drainPerSec: number; drainPerSecBaseline: number }> {
  const withProgress = await progressOnce(o, true);
  const without = await progressOnce(o, false);
  return { writesPerSec: withProgress.writesPerSec, lagP99Ms: withProgress.lagP99Ms, drainPerSec: withProgress.drainPerSec, drainPerSecBaseline: without.drainPerSec };
}

async function progressOnce(o: { intervalMs: number; jobs: number; seconds: number; drainJobs: number }, report: boolean): Promise<{ writesPerSec: number; lagP99Ms: number; drainPerSec: number }> {
  const store = countCalls(new MemoryStore());
  const reporter = new Queue('reporting', { store, logger: false });
  const drainer = new Queue('draining', { store, logger: false });
  await seed(reporter, o.jobs);
  await seed(drainer, o.drainJobs);
  const calledAt = new Map<string, number>();
  const lags: number[] = [];
  reporter.on('progress', ({ job, progress }) => {
    const at = progress.kind === 'counter' ? calledAt.get(`${job.id}:${progress.n}`) : undefined;
    if (at !== undefined) lags.push(performance.now() - at);
  });
  let running = 0;
  let allStarted!: () => void;
  const started = new Promise<void>((resolve) => (allStarted = resolve));
  let go!: () => void;
  const gate = new Promise<void>((resolve) => (go = resolve));
  let reporters = 0;
  reporter.process(async (job, ctx) => {
    if (++running === o.jobs) allStarted();
    await gate;
    const end = performance.now() + o.seconds * 1000;
    if (!report) return sleep(o.seconds * 1000);
    for (let i = 1; performance.now() < end; i++) {
      calledAt.set(`${job.id}:${i}`, performance.now());
      void ctx.progress(i, 1e9).catch(() => undefined);
      await sleep(1);
    }
    reporters++;
  }, { concurrency: o.jobs, progressInterval: o.intervalMs });
  await started;
  const writesBefore = store.calls()['setProgress'] ?? 0;
  let drained = 0;
  const t0 = performance.now();
  go();
  let drainedAt = 0;
  drainer.process(() => {
    if (++drained === o.drainJobs) drainedAt = performance.now();
  }, { concurrency: 100 });
  await sleep(o.seconds * 1000);
  const writes = (store.calls()['setProgress'] ?? 0) - writesBefore;
  while (drainedAt === 0) await sleep(5);
  await Promise.all([reporter.close(), drainer.close()]);
  if (report && reporters !== o.jobs) throw new Error(`${reporters} of ${o.jobs} reporting jobs ran`);
  return { writesPerSec: writes / o.seconds, lagP99Ms: lags.length === 0 ? 0 : quantile(lags, 0.99), drainPerSec: o.drainJobs / ((drainedAt - t0) / 1000) };
}

async function main(): Promise<void> {
  const seconds = Number(process.argv[2]) || 5;
  console.log(`progressInterval ms | reporting jobs | setProgress/s | p99 event lag ms | drain jobs/s | drain jobs/s without progress | ratio  (${seconds} s, 20 000 drain jobs)`);
  for (const intervalMs of [50, 100, 250, 500, 1000]) {
    for (const jobs of [10, 100, 1000]) {
      const r = await measureProgress({ intervalMs, jobs, seconds, drainJobs: 20_000 });
      console.log([intervalMs, jobs, r.writesPerSec.toFixed(0), r.lagP99Ms.toFixed(1), r.drainPerSec.toFixed(0), r.drainPerSecBaseline.toFixed(0), (r.drainPerSec / r.drainPerSecBaseline).toFixed(2)].join(' | '));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
