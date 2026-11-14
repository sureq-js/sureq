// Performance baseline: throughput, claim/complete latency, end-to-end latency and idle polling load.
// Run: npx tsx bench/baseline.ts --write | --compare
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';
import { FORMAT_SUPPORT } from '../src/format/support.js';
import { finishExt } from '../src/retention/policy.js';
import type { JobRecord, Store } from '../src/store/contract.js';
import { createTemplateStore, ToyBackend } from '../../../examples/store-template/src/index.js';
import { LOCK_MODEL, measureClaims } from './claim-throughput.js';
import { measureIdleClaims } from './poll-latency.js';
import { countCalls } from './lib/serial-store.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const quantile = (xs: number[], p: number) => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!);
const median = (xs: number[]) => quantile(xs, 0.5);
const RUNS = 3;

export const newStore = (kind: 'memory' | 'template'): Store => (kind === 'memory' ? new MemoryStore() : createTemplateStore({ backend: new ToyBackend() }));

/** Adds `n` jobs in chunks of 1000; resolves to their ids. */
export async function seed(q: Queue, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let at = 0; at < n; at += 1000) {
    for (const r of await q.addBulk(Array.from({ length: Math.min(1000, n - at) }, (_, i) => ({ data: at + i })))) if (r.ok) ids.push(r.job.id);
  }
  if (ids.length !== n) throw new Error(`added ${ids.length} of ${n} jobs`);
  return ids;
}

/** Store claim and complete called directly, each call timed; `waiting` jobs stay waiting under the claims. */
async function storeLatency(kind: 'memory' | 'template', waiting: number, calls: number): Promise<Record<string, number>> {
  const store = newStore(kind);
  const q = new Queue('latency', { store, logger: false });
  const { scope, history, retention, order, host } = q.internals;
  await seed(q, waiting + calls * 11); // claims of 1 and 10, then the jobs completed, all on top of `waiting`
  let n = 0;
  const claim = (limit: number) => store.claim(scope, {
    workerId: 'w', limit, leaseMs: 30_000, names: [null], order, claimId: `c${n++}`, maxFormat: FORMAT_SUPPORT.maxReadable, history: history && { ...history, host },
  });
  const timed = async (fn: () => Promise<unknown>) => {
    const t = performance.now();
    await fn();
    return performance.now() - t;
  };
  const out: Record<string, number> = {};
  const claimed: JobRecord[] = [];
  for (const limit of [1, 10]) {
    const ms: number[] = [];
    for (let i = 0; i < calls; i++) ms.push(await timed(async () => claimed.push(...(await claim(limit)).jobs)));
    out[`claim.limit${limit}.p50Ms`] = quantile(ms, 0.5);
    out[`claim.limit${limit}.p99Ms`] = quantile(ms, 0.99);
  }
  const ms: number[] = [];
  if (claimed.length !== calls * 11) throw new Error(`claimed ${claimed.length} of ${calls * 11} jobs`);
  const held = claimed.slice(0, calls);
  for (const rec of held) {
    ms.push(await timed(async () => {
      const r = await store.complete(scope, { id: rec.id, token: rec.lease!.token, result: null, history, ...finishExt(retention, rec, 'completed') });
      if (!r.ok) throw new Error(`complete refused: ${r.reason}`);
    }));
  }
  out['complete.p50Ms'] = quantile(ms, 0.5);
  out['complete.p99Ms'] = quantile(ms, 0.99);
  await q.close();
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [`${kind}.${k}`, v]));
}

/** `queue.cancel` on waiting jobs: latency and store calls per cancel, with default retention. */
export async function measureCancel(o: { waiting: number; calls: number }): Promise<{ p50Ms: number; p99Ms: number; storeCallsPerCancel: number; calls: Record<string, number> }> {
  const store = countCalls(new MemoryStore());
  const q = new Queue('cancel', { store, logger: false });
  const ids = (await seed(q, o.waiting + o.calls)).slice(0, o.calls);
  const before = store.calls();
  const ms: number[] = [];
  for (const id of ids) {
    const t = performance.now();
    const r = await q.cancel(id);
    ms.push(performance.now() - t);
    if (!r.cancelled) throw new Error(`cancel of ${id} did not cancel`);
  }
  const after = store.calls();
  await q.close();
  const calls: Record<string, number> = Object.fromEntries(Object.keys(after).map((k) => [k, ((after[k] ?? 0) - (before[k] ?? 0)) / ids.length]).filter(([, v]) => v !== 0));
  return { p50Ms: quantile(ms, 0.5), p99Ms: quantile(ms, 0.99), storeCallsPerCancel: Object.values(calls).reduce((a, b) => a + b, 0), calls };
}

/** One pod, notify on: add acknowledged to the `completed` event, `jobs` adds one per ms. */
async function endToEnd(jobs: number): Promise<{ p50Ms: number; p99Ms: number }> {
  const q = new Queue('e2e', { store: new MemoryStore(), logger: false });
  const added = new Map<string, number>();
  const ms: number[] = [];
  let done!: () => void;
  const all = new Promise<void>((resolve) => (done = resolve));
  q.on('completed', ({ job }) => {
    const at = added.get(job.id);
    if (at === undefined) return;
    ms.push(performance.now() - at);
    if (ms.length === jobs) done();
  });
  q.process(() => undefined, { concurrency: 100 });
  for (let i = 0; i < jobs; i++) {
    void q.add(i).then((r) => added.set(r.job.id, performance.now()));
    await sleep(1);
  }
  await all;
  await q.close();
  return { p50Ms: quantile(ms, 0.5), p99Ms: quantile(ms, 0.99) };
}

/** Store calls, per minute by method, of one idle pod: one worker (which starts the scheduler), default options. */
export async function measureIdlePod(seconds: number): Promise<{ perMin: Record<string, number>; total: number }> {
  const store = countCalls(new MemoryStore());
  const q = new Queue('idlepod', { store, logger: false });
  q.process(() => undefined);
  q.startScheduler();
  await sleep(seconds * 1000);
  const calls = store.calls();
  await q.close();
  const perMin = Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, (v * 60) / seconds]));
  return { perMin, total: Object.values(perMin).reduce((a, b) => a + b, 0) };
}

async function throughput(pods: number, jobs: number, model: typeof LOCK_MODEL | null): Promise<number> {
  const r = await measureClaims({ pods, queues: 1, jobs, limit: 10, jitter: 0.2, model, constraints: false });
  if (r.completed !== jobs) throw new Error(`drained ${r.completed} of ${jobs} jobs`);
  return r.jobsPerSec;
}

async function baselineOnce(scale: number): Promise<Record<string, number>> {
  const n = (x: number) => Math.max(1, Math.round(x * scale));
  const rows: Record<string, number> = {};
  rows['throughput.pods1.jobsPerSec'] = await throughput(1, n(20_000), null);
  rows['throughput.pods20.jobsPerSec'] = await throughput(20, n(20_000), null);
  rows['throughput.pods20.modelled.jobsPerSec'] = await throughput(20, n(20_000), LOCK_MODEL);
  for (const kind of ['memory', 'template'] as const) Object.assign(rows, await storeLatency(kind, n(10_000), n(2000)));
  const e2e = await endToEnd(n(5000)); // 5000, not 1000: 1000 samples of a few µs did not repeat within 20 %
  rows['endToEnd.p50Ms'] = e2e.p50Ms;
  rows['endToEnd.p99Ms'] = e2e.p99Ms;
  const cancel = await measureCancel({ waiting: n(10_000), calls: n(10_000) }); // 10 000 calls for the same reason
  rows['cancel.p50Ms'] = cancel.p50Ms;
  rows['cancel.p99Ms'] = cancel.p99Ms;
  rows['cancel.storeCalls'] = cancel.storeCallsPerCancel;
  // Both idle runs together: they only wait on timers, and the event loop is otherwise free.
  const seconds = 180 * scale;
  const [claims, pod] = await Promise.all([measureIdleClaims({ workers: 10, seconds, pollMin: 100, pollMax: 5000 }), measureIdlePod(seconds)]);
  rows['idle.claimsPerMin'] = (claims.claimCalls * 60) / seconds;
  rows['idle.pod.callsPerMin'] = pod.total;
  return rows;
}

/** Every baseline row, each the median of three runs; `scale` multiplies every job count, call count and duration. */
export async function measureBaseline(o: { scale: number }): Promise<Record<string, number>> {
  const runs: Record<string, number>[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await baselineOnce(o.scale));
  return Object.fromEntries(Object.keys(runs[0]!).map((k) => [k, median(runs.map((r) => r[k]!))]));
}

/** Each baseline row against `now`: `*PerSec` rows are better higher, the rest lower; worse by more than 20 % is slower. */
export function compareBaseline(base: Record<string, number>, now: Record<string, number>): Array<{ key: string; base: number; now: number; ratio: number; slower: boolean }> {
  return Object.entries(base).map(([key, b]) => {
    const v = now[key] ?? NaN;
    const ratio = v / b;
    const slower = Number.isNaN(ratio) || (key.endsWith('PerSec') ? ratio < 1 / 1.2 : ratio > 1.2);
    return { key, base: b, now: v, ratio, slower };
  });
}

async function main(): Promise<void> {
  const file = fileURLToPath(new URL('./baseline.json', import.meta.url));
  const f = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(3));
  if (process.argv.includes('--write')) {
    const rows = await measureBaseline({ scale: 1 });
    const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    const out = { node: process.version, cpu: `${cpus()[0]?.model ?? 'unknown'} x ${cpus().length}`, date: new Date().toLocaleDateString('sv'), version, rows };
    writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    for (const [k, v] of Object.entries(rows)) console.log(`${k} | ${f(v)}`);
    const pod = await measureIdlePod(60);
    console.log(`idle pod store calls per minute by method: ${Object.entries(pod.perMin).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
    const cancel = await measureCancel({ waiting: 10_000, calls: 2000 });
    console.log(`store calls per cancel: ${Object.entries(cancel.calls).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  } else if (process.argv.includes('--compare')) {
    const base = (JSON.parse(readFileSync(file, 'utf8')) as { rows: Record<string, number> }).rows;
    console.log('row | baseline | now | ratio | slower');
    for (const r of compareBaseline(base, await measureBaseline({ scale: 1 }))) console.log([r.key, f(r.base), f(r.now), r.ratio.toFixed(2), r.slower ? '**slower**' : ''].join(' | '));
  } else {
    console.error('usage: baseline.ts --write | --compare');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
