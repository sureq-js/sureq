// event-loop lag and memory of one worker at high concurrency. Run: npx tsx scripts/bench-concurrency.ts
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';

const JOBS = 20_000;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Longest gap between 1 ms timer ticks: how long the loop went without reaching the timers phase. */
function timerProbe(): () => number {
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 1);
  return () => {
    clearInterval(t);
    return Math.max(max, performance.now() - last);
  };
}

console.log('concurrency | p99 lag ms | longest timer gap ms | rss MB | total ms');
for (const concurrency of [100, 1_000, 2_000, 5_000, 10_000]) {
  const q = new Queue('bench', { store: new MemoryStore(), logger: silent, maxBulkSize: JOBS });
  const lag = monitorEventLoopDelay({ resolution: 1 });
  let done = 0;
  const all = new Promise<void>((r) => q.on('completed', () => void (++done === JOBS && r())));
  await q.addBulk(Array.from({ length: JOBS }, (_, i) => ({ data: i })));
  lag.enable();
  const stop = timerProbe();
  const t0 = performance.now();
  q.process(async () => {}, { concurrency });
  await all;
  const total = performance.now() - t0;
  const gap = stop();
  await new Promise((r) => setTimeout(r, 5)); // let the histogram take its last sample
  lag.disable();
  const rss = process.memoryUsage().rss / 1_048_576;
  console.log(`${concurrency} | ${(lag.percentile(99) / 1e6).toFixed(1)} | ${gap.toFixed(1)} | ${rss.toFixed(0)} | ${total.toFixed(0)}`);
  await q.close();
}
