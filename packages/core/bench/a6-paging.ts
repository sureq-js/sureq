// Paging cost on a large store. Run: node --max-old-space-size=8192 --import tsx bench/a6-paging.ts [jobs]
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';
import { OrderedIndex } from '../src/store/memory/ordered-index.js';

const N = Number(process.argv[2] ?? 1_000_000);
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const c = { t: 1_000_000 };
const store = new MemoryStore({ clock: () => c.t });
const q = new Queue('bench', { store, logger: silent, maxBulkSize: 10_000 });
const scope = q.internals.scope;

const t0 = performance.now();
for (let done = 0; done < N; done += 10_000) {
  await q.addBulk(Array.from({ length: Math.min(10_000, N - done) }, (_, i) => ({ data: done + i })));
  const claimed = await store.claim(scope, { workerId: 'w', limit: 10_000, order: 'fifo', claimId: 'c' });
  for (const r of claimed) {
    c.t++;
    await store.complete(scope, { id: r.id, token: r.lease!.token });
  }
}
console.log(`filled ${N} completed jobs in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const time = async (fn: () => Promise<unknown>) => {
  const s = performance.now();
  await fn();
  return performance.now() - s;
};
console.log('getJobs(completed, limit 100) | ms');
for (const offset of [0, 10_000, 100_000, 999_900].filter((o) => o < N)) {
  console.log(`offset ${offset} | ${(await time(() => q.getJobs('completed', { offset, limit: 100 }))).toFixed(1)}`);
}

// Keyset for comparison: keys kept sorted as an index would (finishedAt desc, seq desc), and a
// cursor page = binary-search seek + 100 entries. An index seek costs the same order.
const recs = store.dump().jobs.filter((r) => r.state === 'completed');
const key = (r: { finishedAt: number | null; seq: number }) => -((r.finishedAt ?? 0) * 2 ** 20 + r.seq);
let keys: Array<{ k: number; id: string }> = [];
const buildMs = await time(async () => {
  keys = recs.map((r) => ({ k: key(r), id: r.id })).sort((a, b) => a.k - b.k);
});
const cursor = keys[Math.floor(keys.length / 2)]!.k;
const keysetMs = await time(async () => {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.k < cursor) lo = mid + 1;
    else hi = mid;
  }
  const page = keys.slice(lo, lo + 100).map((e) => e.id);
  return page.map((id) => store.get(scope, id));
});
console.log(`keyset index build ${buildMs.toFixed(0)} ms (kept up to date on each write in a real index); page of 100 from the middle: ${keysetMs.toFixed(2)} ms`);

// what a (priority, seq) waiting index would cost on writes.
const prio = new OrderedIndex<string>();
const writeMs = await time(async () => {
  for (let i = 0; i < 100_000; i++) prio.insert(-((i % 10) * 2 ** 40) + i, String(i));
});
console.log(`(priority, seq) index: 100 000 inserts ${writeMs.toFixed(0)} ms = ${((writeMs * 1000) / 100_000).toFixed(2)} µs per add`);
