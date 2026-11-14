// Claim throughput and the loop-gap check.
// Run: npx tsx bench/claim-throughput.ts --grid claims | --grid limits | --loop-gaps [seconds]
import { pathToFileURL } from 'node:url';
import { MemoryStore } from '../src/store/memory/memory-store.js';
import { Queue } from '../src/queue/queue.js';
import type { Store } from '../src/store/contract.js';
import { observeClaims, serialStore } from './lib/serial-store.js';

type Model = { baseMs: number; rowMs: number };
export const LOCK_MODEL: Model = { baseMs: 2, rowMs: 0.2 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const percentile = (xs: number[], p: number) => (xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!);

export interface ClaimRow { jobsPerSec: number; claimsPerSec: number; emptyClaimFraction: number; lockWaitP99Ms: number; completed: number }

/**
 * `pods` workers per queue drain `jobs` no-op jobs. `limit` caps the claim size (the cap under test),
 * `jitter` is the workers' pollJitter. With `stream`, jobs arrive in batches while the pods run, so
 * idle polls (and the herd they form) are part of the measurement; otherwise all jobs are added first.
 */
export async function measureClaims(o: ClaimsOptions): Promise<ClaimRow> {
  const { stream: _unused, ...rest } = o;
  await claimsOnce({ ...rest, jobs: Math.min(o.jobs, WARM_UP_JOBS) }); // warm-up pass, not timed or reported
  return claimsOnce(o);
}

type ClaimsOptions = {
  pods: number; queues: number; jobs: number; limit: number; jitter: number; model: Model | null; constraints: boolean;
  stream?: { batch: number; everyMs: number };
};
const WARM_UP_JOBS = 100;

async function claimsOnce(o: ClaimsOptions): Promise<ClaimRow> {
  const inner = new MemoryStore();
  const serial = o.model ? serialStore(inner, { ...o.model, skipLocked: true }) : undefined;
  const store = observeClaims(serial ?? inner, { limit: o.limit });
  const names = o.constraints ? ['a', 'b'] : [];
  // A pod is a Queue object; the pods of one queue name share its jobs. Completed jobs are kept so they can be counted.
  const pods = Array.from({ length: o.queues }, (_, i) => Array.from({ length: o.pods }, () => new Queue(`bench${i}`, { store, logger: false, pollJitter: o.jitter, notify: false, retention: { completed: true } })));
  const queues = pods.map((group) => group[0]!);
  let handled = 0;
  const handler = () => void handled++;
  for (const q of pods.flat()) {
    if (o.constraints) q.process({ a: handler, b: handler }, { concurrency: 1000, leaseDurationByName: { a: '20s' } });
    else q.process(handler, { concurrency: 1000 });
  }
  const perQueue = Math.ceil(o.jobs / o.queues);
  const total = perQueue * o.queues;
  const feed = async (q: Queue, from: number, to: number) => {
    const items = Array.from({ length: to - from }, (_, i) => ({ data: from + i, ...(o.constraints && { opts: { name: names[(from + i) % 2]! } }) }));
    for (let at = 0; at < items.length; at += 1000) await q.addBulk(items.slice(at, at + 1000));
  };
  const t0 = performance.now();
  const feeding = queues.map(async (q) => {
    if (!o.stream) return feed(q, 0, perQueue);
    for (let from = 0; from < perQueue; from += o.stream.batch) {
      await feed(q, from, Math.min(perQueue, from + o.stream.batch));
      await sleep(o.stream.everyMs);
    }
  });
  await Promise.all(feeding);
  while (handled < total) await sleep(5);
  const seconds = (performance.now() - t0) / 1000;
  const calls = store.stats();
  await Promise.all(pods.flat().map((q) => q.close()));
  const counts = await Promise.all(queues.map((q) => inner.counts(q.internals.scope)));
  const waits = serial?.lockWaitMs() ?? [];
  return {
    jobsPerSec: total / seconds, claimsPerSec: calls.calls / seconds, emptyClaimFraction: calls.calls === 0 ? 0 : calls.empty / calls.calls,
    lockWaitP99Ms: percentile(waits, 0.99), completed: counts.reduce((n, c) => n + c.completed, 0),
  };
}

/** The store called directly: `pods` loops per queue claim `limit` jobs and complete them, until `jobsPerQueue` are done. */
export async function measureLimits(o: LimitsOptions): Promise<{ jobsPerSec: number; claimsPerSec: number }> {
  await limitsOnce({ ...o, jobsPerQueue: Math.min(o.jobsPerQueue, WARM_UP_JOBS) }); // warm-up pass, not timed or reported
  return limitsOnce(o);
}

type LimitsOptions = { pods: number; queues: number; jobsPerQueue: number; limit: number; model: Model | null; constraints: boolean };

async function limitsOnce(o: LimitsOptions): Promise<{ jobsPerSec: number; claimsPerSec: number }> {
  const inner = new MemoryStore();
  const store: Store = o.model ? serialStore(inner, { ...o.model, skipLocked: true }) : inner;
  const queues = Array.from({ length: o.queues }, (_, i) => new Queue(`direct${i}`, { store: inner, logger: false }));
  for (const q of queues) {
    const items = Array.from({ length: o.jobsPerQueue }, (_, i) => ({ data: i, ...(o.constraints && { opts: { name: i % 2 ? 'a' : 'b' } }) }));
    for (let at = 0; at < items.length; at += 1000) await q.addBulk(items.slice(at, at + 1000));
  }
  let claims = 0;
  let done = 0;
  const t0 = performance.now();
  await Promise.all(queues.flatMap((q) => Array.from({ length: o.pods }, async (_, p) => {
    const scope = q.internals.scope;
    for (;;) {
      claims++;
      const jobs = (await store.claim(scope, {
        workerId: `w${p}`, limit: o.limit, leaseMs: 30_000, order: 'fifo', claimId: `c${claims}`,
        ...(o.constraints && { names: ['a', 'b'], leaseMsByName: { a: 20_000 } }),
      })).jobs;
      if (jobs.length === 0) return;
      for (const j of jobs) await store.complete(scope, { id: j.id, token: j.lease!.token, result: null });
      done += jobs.length;
    }
  })));
  const seconds = (performance.now() - t0) / 1000;
  await Promise.all(queues.map((q) => q.close()));
  if (done !== o.queues * o.jobsPerQueue) throw new Error(`drained ${done} of ${o.queues * o.jobsPerQueue} jobs`);
  return { jobsPerSec: done / seconds, claimsPerSec: claims / seconds };
}

export interface GapRow { scenario: string; workers: number; worstGapMs: number; p99GapMs: number; samples: number }

/**
 * Loop-gap check: `workers` workers in this process; every 250 ms sample how long ago each last
 * called claim (the loop's heartbeat). `load` keeps the queue busy, `cpu` also blocks the thread for
 * 200 ms in every tenth handler, `idle` has no jobs at pollMax.
 */
export async function measureLoopGaps(o: { scenario: 'load' | 'cpu' | 'idle'; workers: number; seconds: number; pollMax: number }): Promise<GapRow> {
  const store = observeClaims(new MemoryStore());
  const q = new Queue('gaps', { store, logger: false, notify: false, pollMax: o.pollMax });
  const producer = new Queue('gaps', { store, logger: false });
  let n = 0;
  const handler = () => {
    if (o.scenario === 'cpu' && ++n % 10 === 0) for (const end = performance.now() + 200; performance.now() < end;);
  };
  const ids: string[] = [];
  for (let i = 0; i < o.workers; i++) ids.push(q.process(handler, { concurrency: 10 }).id);
  const stop = performance.now() + o.seconds * 1000;
  const feeding = (async () => {
    // load: as fast as the loop lets it; cpu: ten jobs a second, so a 200 ms block happens about once a second.
    while (o.scenario !== 'idle' && performance.now() < stop) {
      await producer.addBulk(Array.from({ length: o.scenario === 'load' ? 50 : 1 }, (_, i) => ({ data: i })));
      await sleep(o.scenario === 'load' ? 5 : 100);
    }
  })();
  const gaps: number[] = [];
  await sleep(250);
  while (performance.now() < stop) {
    const at = store.stats().at;
    const now = performance.now();
    for (const id of ids) if (at.has(id)) gaps.push(now - at.get(id)!);
    await sleep(250);
  }
  await feeding;
  await Promise.all([q.close(), producer.close()]);
  return { scenario: o.scenario, workers: o.workers, worstGapMs: Math.max(...gaps), p99GapMs: percentile(gaps, 0.99), samples: gaps.length };
}

async function main(): Promise<void> {
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const f = (x: number, d = 0) => x.toFixed(d);
  if (arg('--grid') === 'claims') {
    console.log('limit | jitter | jobs/s | claims/s | empty claim fraction | lock wait p99 ms | completed');
    for (const limit of [1, 10, 100, 1000]) {
      for (const jitter of [0, 0.2, 0.5]) {
        const r = await measureClaims({ pods: 20, queues: 1, jobs: 20_000, limit, jitter, model: LOCK_MODEL, constraints: false, stream: { batch: 100, everyMs: 10 } });
        console.log([limit, jitter, f(r.jobsPerSec), f(r.claimsPerSec), f(r.emptyClaimFraction, 3), f(r.lockWaitP99Ms, 1), r.completed].join(' | '));
      }
    }
  } else if (arg('--grid') === 'limits') {
    console.log('model | queues | pods | limit | constraints | claims/s per queue | jobs/s per queue');
    for (const model of [LOCK_MODEL, null]) {
      for (const [queues, pods] of [[1, 1], [1, 5], [1, 20], [20, 1]] as const) {
        for (const limit of [1, 10, 100, 1000]) {
          for (const constraints of [false, true]) {
            const r = await measureLimits({ pods, queues, jobsPerQueue: model ? 5000 : 20_000, limit, model, constraints });
            console.log([model ? 'modelled' : 'raw', queues, pods, limit, constraints ? 'on' : 'off', f(r.claimsPerSec / queues), f(r.jobsPerSec / queues)].join(' | '));
          }
        }
      }
    }
  } else if (process.argv.includes('--loop-gaps')) {
    const seconds = Number(arg('--loop-gaps') ?? 30) || 30;
    console.log('scenario | workers | worst gap ms | p99 gap ms | samples (pollMax 5000, threshold max(3 x pollMax, 10 s) = 15000 ms)');
    for (const scenario of ['load', 'cpu', 'idle'] as const) {
      const r = await measureLoopGaps({ scenario, workers: 20, seconds: scenario === 'idle' ? Math.max(seconds, 60) : seconds, pollMax: 5000 });
      console.log([r.scenario, r.workers, f(r.worstGapMs), f(r.p99GapMs), r.samples].join(' | '));
    }
  } else {
    console.error('usage: claim-throughput.ts --grid claims | --grid limits | --loop-gaps [seconds]');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
