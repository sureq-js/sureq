// Pickup latency and idle claim rate for pollMin / pollMax.
// Run: npx tsx bench/poll-latency.ts [--idle-seconds 60] [--samples 30] | --idle-grid [seconds]
import { pathToFileURL } from 'node:url';
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';
import { observeClaims } from './lib/serial-store.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quantile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const summary = (xs: number[]) => ({ p50Ms: quantile(xs, 0.5), p95Ms: quantile(xs, 0.95), maxMs: Math.max(...xs) });

/**
 * Remote add to handler start. Two Queue objects share a store, so the worker cannot be woken
 * locally: only polling (notify off) or the store push (notify on) finds the job. Each sample waits
 * until the worker has idled up to pollMax, plus a random part of one poll period.
 */
export async function measurePickup(o: { pollMin: number; pollMax: number; notify: boolean; samples: number }): Promise<{ p50Ms: number; p95Ms: number; maxMs: number }> {
  const store = new MemoryStore();
  const consumer = new Queue('pickup', { store, logger: false });
  const producer = new Queue('pickup', { store, logger: false });
  let started: (at: number) => void = () => undefined;
  consumer.process((): void => started(performance.now()), { pollMin: o.pollMin, pollMax: o.pollMax, notify: o.notify });
  const latencies: number[] = [];
  for (let i = 0; i < o.samples; i++) {
    await sleep(o.pollMax * 2 + Math.random() * o.pollMax);
    const picked = new Promise<number>((resolve) => (started = resolve));
    await producer.add(i);
    const added = performance.now();
    latencies.push((await picked) - added);
  }
  await Promise.all([consumer.close(), producer.close()]);
  return summary(latencies);
}

/**
 * A job added by another queue object shortly after the worker's claim came back with a job: the
 * worker's next claim is the first poll after a busy period, so the wait is about pollMin. Each job
 * schedules the next add 20 ms later, after its own slot is freed (which wakes the worker) and the
 * follow-up claim has found the queue empty.
 */
export async function measureBusyPickup(o: { pollMin: number; pollMax: number; samples: number }): Promise<{ p50Ms: number; p95Ms: number; maxMs: number }> {
  const store = new MemoryStore();
  const consumer = new Queue('busy', { store, logger: false });
  const producer = new Queue('busy', { store, logger: false });
  const latencies: number[] = [];
  let addedAt = 0;
  let count = 0;
  const finished = new Promise<void>((resolve) => {
    consumer.process(() => {
      if (addedAt > 0) latencies.push(performance.now() - addedAt);
      if (++count > o.samples) return resolve();
      setTimeout(() => {
        addedAt = performance.now();
        void producer.add(count);
      }, 20);
    }, { pollMin: o.pollMin, pollMax: o.pollMax, notify: false, concurrency: 2 });
  });
  await producer.add(0);
  await finished;
  await Promise.all([consumer.close(), producer.close()]);
  return summary(latencies);
}

/** Claim calls made by `workers` idle workers in `seconds`, against the budget `workers x seconds / pollMax x 1.3`. */
export async function measureIdleClaims(o: { workers: number; seconds: number; pollMin: number; pollMax: number }): Promise<{ claimCalls: number; budget: number }> {
  const store = observeClaims(new MemoryStore());
  const q = new Queue('idle', { store, logger: false, notify: false });
  for (let i = 0; i < o.workers; i++) q.process(() => undefined, { pollMin: o.pollMin, pollMax: o.pollMax });
  await sleep(o.seconds * 1000);
  const claimCalls = store.stats().calls;
  await q.close();
  return { claimCalls, budget: ((o.workers * o.seconds) / (o.pollMax / 1000)) * 1.3 };
}

async function idleGrid(seconds: number): Promise<void> {
  console.log(`pollMin | pollMax | idle claim calls (10 workers, ${seconds} s) | budget`);
  const cells = [50, 100, 250].flatMap((pollMin) => [1000, 2500, 5000].map((pollMax) => ({ pollMin, pollMax })));
  const rows = [];
  for (const c of cells) rows.push({ ...c, ...(await measureIdleClaims({ workers: 10, seconds, ...c })) }); // one at a time: cells must not compete for the event loop
  for (const r of rows) console.log([r.pollMin, r.pollMax, r.claimCalls, r.budget.toFixed(0)].join(' | '));
}

async function main(): Promise<void> {
  if (process.argv.includes('--idle-grid')) return idleGrid(Number(process.argv[process.argv.indexOf('--idle-grid') + 1]) || 60);
  const arg = (name: string, fallback: number) => Number(process.argv[process.argv.indexOf(name) + 1]) || fallback;
  const samples = arg('--samples', 30);
  const f = (x: number) => x.toFixed(1);
  const mins = [50, 100, 250];
  const maxs = [1000, 2500, 5000];
  console.log('pollMin | pollMax | remote pickup p50 ms | p95 ms | max ms | bound pollMax x 1.2 + 100 | busy pickup p50 ms | max ms | bound pollMin x 1.2 + 50   (notify off)');
  const cells = mins.flatMap((pollMin) => maxs.map((pollMax) => ({ pollMin, pollMax })));
  const rows = [];
  for (const c of cells) rows.push({ ...c, remote: await measurePickup({ ...c, notify: false, samples }), busy: await measureBusyPickup({ ...c, samples }) }); // one at a time, as above
  for (const r of rows) {
    console.log([r.pollMin, r.pollMax, f(r.remote.p50Ms), f(r.remote.p95Ms), f(r.remote.maxMs), r.pollMax * 1.2 + 100, f(r.busy.p50Ms), f(r.busy.maxMs), r.pollMin * 1.2 + 50].join(' | '));
  }
  const push = await measurePickup({ pollMin: 100, pollMax: 5000, notify: true, samples });
  console.log(`notify on (defaults), remote pickup: p50 ${f(push.p50Ms)} ms, p95 ${f(push.p95Ms)} ms, max ${f(push.maxMs)} ms`);
  const idleSeconds = arg('--idle-seconds', 60);
  const idle = await measureIdleClaims({ workers: 10, seconds: idleSeconds, pollMin: 100, pollMax: 5000 });
  console.log(`idle, 10 workers, ${idleSeconds} s, defaults: ${idle.claimCalls} claim calls, budget ${idle.budget.toFixed(0)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
