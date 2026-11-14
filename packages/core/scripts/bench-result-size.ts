// cost per job of storing results of different sizes. Run: npx tsx scripts/bench-result-size.ts
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';

const JOBS = 1_000;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

console.log('result size | ms per job | rss MB');
for (const [label, bytes] of [['1 KiB', 1024], ['64 KiB', 65_536], ['256 KiB', 262_144], ['1 MiB', 1_048_570]] as const) {
  const result = 'r'.repeat(bytes);
  const q = new Queue('bench', { store: new MemoryStore(), logger: silent });
  let done = 0;
  const all = new Promise<void>((r) => q.on('completed', () => void (++done === JOBS && r())));
  await q.addBulk(Array.from({ length: JOBS }, (_, i) => ({ data: i })));
  const t0 = performance.now();
  q.process(() => result, { concurrency: 10 });
  await all;
  const ms = (performance.now() - t0) / JOBS;
  console.log(`${label} | ${ms.toFixed(3)} | ${(process.memoryUsage().rss / 1_048_576).toFixed(0)}`);
  await q.close();
}
