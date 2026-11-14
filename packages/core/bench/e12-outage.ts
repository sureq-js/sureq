// store outages and log volume. Run: npx tsx bench/e12-outage.ts
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';
import { createReporter } from '../src/events/report.js';
import { StoreError } from '../src/errors/catalog.js';
import type { StoreOp } from '../src/store/types.js';

const JOBS = 100;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function outage(ms: number): Promise<void> {
  let down = false;
  let writeAttempts = 0;
  const store = new MemoryStore({
    faults: {
      before(op: StoreOp) {
        if (op === 'complete' || op === 'fail') writeAttempts++;
        if (down && (op === 'complete' || op === 'fail')) throw new TypeError('outage');
      },
    },
  });
  const q = new Queue('outage', { store, logger: silent });
  q.on('error', () => {});
  let done = 0;
  q.on('completed', () => void done++);
  let peakParked = 0;
  let activeNow = 0;
  q.process(async () => {
    activeNow++;
    await sleep(5);
    activeNow--;
  }, { concurrency: 10, pollMin: 50, pollMax: 50, pollJitter: 0 });
  await q.addBulk(Array.from({ length: JOBS }, (_, i) => ({ data: i })));
  down = true;
  const sampler = setInterval(async () => {
    const c = await store.counts(q.internals.scope);
    peakParked = Math.max(peakParked, c.active - activeNow);
  }, 50);
  await sleep(ms);
  down = false;
  const recovered = performance.now();
  while (done < JOBS) await sleep(10);
  const toFinal = performance.now() - recovered;
  clearInterval(sampler);
  await q.close();
  console.log(`${ms / 1000} s | ${peakParked} | ${toFinal.toFixed(0)} | ${(writeAttempts / JOBS).toFixed(2)}`);
}

console.log('outage | peak parked writes | ms from recovery to last final | write attempts per job');
for (const ms of [1_000, 10_000, 60_000]) await outage(ms);

console.log('\nlog limiter | lines for 1 000 claim failures');
for (const rateLimitMs of [10_000, 0]) {
  let lines = 0;
  const report = createReporter({ emit: () => {}, logger: { ...silent, error: () => void lines++ }, now: Date.now, queue: 'q', rateLimitMs });
  for (let i = 0; i < 1000; i++) report(new StoreError("Store operation 'claim' failed", { operation: 'claim', retryable: true, outcomeUnknown: false }), 'store');
  console.log(`${rateLimitMs === 0 ? 'off' : 'on (10 s)'} | ${lines}`);
}
