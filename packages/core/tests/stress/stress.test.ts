import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergeConflictError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import type { JobRecord } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { TaskFailure } from '../../src/worker/batch.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { Pod, rng } from '../helpers/pods.js';

/** Sizes come from the environment: the default run is quick, `test:stress` runs the release size. */
const JOBS = Number(process.env['SUREQ_STRESS_JOBS'] ?? 20_000);
const PODS = Number(process.env['SUREQ_STRESS_PODS'] ?? 10);
const TICKS = Number(process.env['SUREQ_STRESS_TICKS'] ?? 2000);
const CHUNK = 1000;
// The assertions read every finished job, so none is deleted by retention.
const KEEP_ALL = { completed: true, failed: true } as const;
/** Nothing expires: the run measures claiming, not recovery. */
const QUEUE = { leaseDuration: '30s', pollMin: 10, pollMax: 100, retention: KEEP_ALL } as const;
const WORKER = { concurrency: 50, sweepInterval: '30s' } as const;

type Data = { n: number };
let open: Array<{ close(o?: { timeoutMs?: number }): Promise<void> }> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.map((q) => q.close({ timeoutMs: 1000 })));
  open = [];
});

const pods = (store: MemoryStore, name: string, n = PODS): Array<Pod<Data, unknown>> => {
  const out = Array.from({ length: n }, () => new Pod<Data, unknown>(store, name, QUEUE));
  open.push(...out.map((p) => p.queue));
  return out;
};

/** Add jobs `0..count-1` in chunks of 1000, each chunk through the next pod, with `opts` per job. */
const addAll = async (ps: Array<Pod<Data, unknown>>, count: number, opts: (n: number) => object = () => ({})) => {
  const chunks: Array<Promise<unknown>> = [];
  for (let start = 0; start < count; start += CHUNK) {
    const items = Array.from({ length: Math.min(CHUNK, count - start) }, (_, i) => ({ data: { n: start + i }, opts: opts(start + i) }));
    chunks.push(ps[(start / CHUNK) % ps.length]!.queue.addBulk(items));
  }
  for (const outcomes of (await Promise.all(chunks)) as Array<Array<{ ok: boolean }>>) expect(outcomes.every((o) => o.ok)).toBe(true);
};

/** Wait (in 50 ms steps) until `done` holds. */
const until = async (done: () => Promise<boolean>, ms = 240_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error('stress: timed out waiting for the queue to settle');
    await new Promise((r) => setTimeout(r, 50));
  }
};

const records = (store: MemoryStore): JobRecord[] => store.dump().jobs;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const settled = (q: Queue<Data>) => async () => {
  const c = await q.getCounts();
  return c.waiting + c.delayed + c.active === 0;
};

// Correctness under load, not speed: CI runners vary, so the limit leaves room (the 100k-tick run took ~5 min there).
describe('stress', { timeout: 900_000 }, () => {
  it('stress: every job is processed exactly once across simulated pods', async () => {
    const store = new MemoryStore();
    const ps = pods(store, 'once');
    await addAll(ps, JOBS);
    const runs = new Uint8Array(JOBS);
    const seen = { completed: 0, stalled: 0, leaseLost: 0 };
    for (const p of ps) {
      const w = p.process(async (job) => {
        await Promise.resolve();
        runs[job.data.n]!++;
      }, WORKER);
      w.on('completed', () => void seen.completed++);
      w.on('leaseLost', () => void seen.leaseLost++);
      p.queue.on('stalled', () => void seen.stalled++);
    }
    await until(async () => (await ps[0]!.queue.getCounts()).completed === JOBS);

    expect(runs.every((r) => r === 1)).toBe(true);
    const recs = records(store);
    expect(recs).toHaveLength(JOBS);
    expect(recs.filter((r) => r.state !== 'completed' || r.attempt !== 1 || r.crashCount !== 0)).toEqual([]);
    expect(seen).toEqual({ completed: JOBS, stalled: 0, leaseLost: 0 });
  });

  it('stress: failed attempts are retried once and counted', async () => {
    const store = new MemoryStore();
    const ps = pods(store, 'retry');
    const random = rng(11);
    const flaky = new Set(Array.from({ length: JOBS }, (_, n) => n).filter(() => random() < 0.05));
    await addAll(ps, JOBS, () => ({ maxAttempts: 2, backoff: 0 }));
    for (const p of ps) {
      p.process(async (job) => {
        await Promise.resolve();
        if (flaky.has(job.data.n) && job.attempt === 1) throw new Error('first attempt fails');
      }, WORKER);
    }
    await until(async () => (await ps[0]!.queue.getCounts()).completed === JOBS);

    const recs = records(store);
    expect(recs.filter((r) => r.state !== 'completed')).toEqual([]);
    const attempts = recs.map((r) => [(JSON.parse(String(r.data)) as Data).n, r.attempt] as const);
    expect(attempts.filter(([n, a]) => a !== (flaky.has(n) ? 2 : 1))).toEqual([]);
  });

  it('stress: random cancels keep counts equal to the sum of states and never cancel a completed job', async () => {
    const store = new MemoryStore();
    const ps = pods(store, 'cancel');
    const random = rng(23);
    // A target cancels itself while running: half wait for the abort, half return at once and race the cancel.
    const targets = new Map(Array.from({ length: JOBS }, (_, n) => n).flatMap((n) => (random() < 0.1 ? [[n, random() < 0.5] as const] : [])));
    await addAll(ps, JOBS);
    const completed = new Set<string>();
    const cancelled = new Set<string>();
    const drained = new Map<Pod<Data, unknown>, number>();
    for (const p of ps) {
      const w = p.process(async (job, ctx) => {
        const waits = targets.get(job.data.n);
        if (waits === undefined) return;
        const cancel = p.queue.cancel(job.id);
        if (!waits) return void (await cancel);
        await new Promise((r) => (ctx.signal.aborted ? r(null) : ctx.signal.addEventListener('abort', r)));
      }, WORKER);
      w.on('completed', ({ job }) => void completed.add(job.id));
      p.queue.on('cancelled', ({ job }) => void cancelled.add(job.id));
      p.queue.on('drained', () => void drained.set(p, (drained.get(p) ?? 0) + 1));
    }
    await until(settled(ps[0]!.queue));

    const c = await ps[0]!.queue.getCounts();
    expect(c.waiting + c.delayed + c.active).toBe(0);
    expect(c.completed + c.cancelled + c.failed).toBe(JOBS);
    expect(c.cancelled).toBeGreaterThanOrEqual([...targets.values()].filter(Boolean).length);
    expect([...completed].filter((id) => cancelled.has(id))).toEqual([]);
    expect([completed.size, cancelled.size]).toEqual([c.completed, c.cancelled]);
    // The latch is per Queue object: whichever pods saw the queue empty fired once each.
    await until(async () => drained.size > 0, 5000);
    expect([...drained.values()].every((n) => n === 1)).toBe(true);
  });

  it('stress: every pod adding the same ids at once creates one job per id', async () => {
    const store = new MemoryStore();
    const queues = Array.from({ length: PODS }, () => new Queue<Data>('same', { logger: silent, store, retention: KEEP_ALL }));
    open.push(...queues);
    const ids = Array.from({ length: 1000 }, (_, n) => `id-${n}`);
    const outcomes = await Promise.all(
      queues.map((q) => q.addBulk(ids.map((id, n) => ({ data: { n }, opts: { id, onDuplicate: 'ignore' as const } })))),
    );
    expect(records(store)).toHaveLength(1000);
    const added = new Map<string, number>();
    for (const list of outcomes) for (const o of list) if (o.ok && o.added) added.set(o.job.id, (added.get(o.job.id) ?? 0) + 1);
    expect([added.size, [...added.values()].every((n) => n === 1)]).toEqual([1000, true]);
  });

  it('stress: fifty pods merging into one id keep every contribution', async () => {
    const store = new MemoryStore();
    type Set_ = { pods: number[] };
    const queues = Array.from({ length: 50 }, () => new Queue<Set_>('merge', { logger: silent, store, retention: KEEP_ALL }));
    open.push(...queues);
    const union = (e: { data: Set_ }, i: Set_): Set_ => ({ pods: [...new Set([...e.data.pods, ...i.pods])] });
    const add = async (q: Queue<Set_>, n: number): Promise<void> => {
      try {
        await q.add({ pods: [n] }, { id: 'm', onDuplicate: union });
      } catch (err) {
        if (!(err instanceof MergeConflictError)) throw err;
        return add(q, n);
      }
    };
    await Promise.all(queues.map((q, n) => add(q, n)));
    const job = await queues[0]!.getJob('m');
    expect([...job!.data.pods].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, n) => n));
    expect(records(store)).toHaveLength(1);
  });
  it('stress: batch workers settle every job by its own outcome under random failures and cancels', async () => {
    const store = new MemoryStore();
    const ps = pods(store, 'batch');
    const random = rng(31);
    // fail: the first attempt fails as a task; cancel: cancelled from its running batch, by its own pod or another;
    // race: cancelled from outside at any moment, so waiting, held, running or already finished.
    type Fate = 'work' | 'fail' | 'cancel' | 'race';
    const fates = Array.from({ length: JOBS }, (): Fate => {
      const r = random();
      return r < 0.05 ? 'fail' : r < 0.075 ? 'cancel' : r < 0.1 ? 'race' : 'work';
    });
    const tokens: number[] = [];
    ps.forEach((p, i) => {
      p.processBatch({ ...WORKER, batchSize: 25, batchDelay: 5 }, async (batch) => {
        for (const job of batch.jobs) tokens.push(job.token);
        const cancels = batch.jobs.filter((j) => fates[j.data.n] === 'cancel');
        await Promise.all(cancels.map((j, k) => ps[k % 2 === 0 ? i : (i + 1) % ps.length]!.queue.cancel(j.id)));
        return batch.jobs.map((j) => (fates[j.data.n] === 'fail' && j.attempt === 1 ? new TaskFailure(new Error('first attempt fails')) : j.data.n));
      });
    });
    await addAll(ps, JOBS, (n) => ({ id: `b${n}`, ...(fates[n] === 'fail' && { maxAttempts: 2, backoff: 0 }) }));
    const raced = new Map<number, boolean>();
    for (let n = 0; n < JOBS; n++) {
      if (fates[n] !== 'race') continue;
      raced.set(n, (await ps[n % ps.length]!.queue.cancel(`b${n}`)).cancelled);
      if (n % 20 === 0) await sleep(1);
    }
    await until(settled(ps[0]!.queue));

    const byId = new Map(records(store).map((r) => [r.id, r]));
    expect(byId.size).toBe(JOBS);
    const wrong = fates.flatMap((fate, n) => {
      const r = byId.get(`b${n}`)!;
      const want =
        fate === 'cancel' || (fate === 'race' && raced.get(n)) ? { state: 'cancelled' } : { state: 'completed', attempt: fate === 'fail' ? 2 : 1 };
      const got = { state: r.state, ...(want.attempt !== undefined && { attempt: r.attempt }) };
      return JSON.stringify(got) === JSON.stringify(want) ? [] : [{ n, fate, ...got }];
    });
    expect(wrong).toEqual([]);
    // Siblings of a failed or cancelled job ran once: every job but the failing ones has attempt 1.
    expect([...byId.values()].filter((r) => r.attempt > 1 && fates[Number(r.id.slice(1))] !== 'fail')).toEqual([]);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('stress: simulated pods fire exactly one job per schedule tick', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const ps = Array.from({ length: PODS }, (_, i) => new Pod<Data, unknown>(store, 'ticks', { ...QUEUE, random: rng(100 + i) }));
    open.push(...ps.map((p) => p.queue));
    let events = 0;
    for (const p of ps) {
      p.process(async () => {}, { ...WORKER, pollMin: 1000, pollMax: 5000, random: rng(200) });
      p.queue.on('scheduleFired', () => void events++);
    }
    const { schedule } = await ps[0]!.queue.upsertSchedule('k', { every: '1s', overlap: 'allow', template: { data: { n: 0 } } });
    // past the last tick by more than one scheduler tick, so the tick after it may have fired too
    await vi.advanceTimersByTimeAsync(schedule.nextRunAt - Date.now() + 1000 * (TICKS - 1) + 1500);

    const fired = records(store).filter((r) => r.scheduleKey === 'k').map((r) => r.scheduledFor!).sort((a, b) => a - b);
    expect(fired.length - TICKS, 'every tick fired, at most the next one too').toBeOneOf([0, 1]);
    expect(fired).toEqual(Array.from({ length: fired.length }, (_, i) => schedule.nextRunAt + 1000 * i));
    expect((await ps[0]!.queue.getSchedule('k'))!.runCount).toBe(fired.length);
    expect(events).toBe(fired.length);
  });

  it("stress: progress of a stale attempt never changes the new attempt's progress", async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const scope = { namespace: 'default', queue: 'progress' };
    const random = rng(47);
    const ps = Array.from({ length: PODS }, () => new Pod<Data, unknown>(store, 'progress', { ...QUEUE, leaseDuration: '1s', maxCrashes: 100 }));
    open.push(...ps.map((p) => p.queue));
    // a seeded 2 % of jobs freeze their pod mid-job; the pod thaws once another pod finished that job
    const freezers = new Set(Array.from({ length: JOBS }, (_, n) => n).filter(() => random() < 0.02));
    const last = new Map<string, number>();
    let running = 0;
    let frozen = 0;
    for (const p of ps) {
      p.process(async (job, ctx) => {
        running++;
        try {
          for (let step = 1; step <= 5; step++) {
            await sleep(1);
            last.set(`${job.id}:${ctx.token}`, step);
            const write = ctx.progress({ token: ctx.token, step }).catch(() => {});
            // at most half the pods frozen at once, so the rest can reclaim and finish their jobs
            if (step === 3 && freezers.delete(job.data.n) && !p.view.frozen && 2 * ps.filter((x) => x.view.frozen).length < ps.length - 1) {
              p.kill();
              frozen++;
              void (async () => {
                while ((await store.get(scope, job.id))?.state !== 'completed') await sleep(100);
                p.view.unfreeze();
              })();
            }
            if (step === 5) await write;
          }
        } finally {
          running--;
        }
      }, { concurrency: 50, sweepInterval: 500, random });
    }
    await addAll(ps, JOBS);
    const q = ps[0]!.queue;
    for (let t = 0; ; t += 100) {
      // the shared store, not a pod: a frozen pod never answers
      const c = await store.counts(scope);
      if (c.completed === JOBS && running === 0 && ps.every((p) => !p.view.frozen)) break;
      if (t > 3_600_000) throw new Error(`stress: timed out waiting for the queue to settle: ${JSON.stringify({ c, running, frozen: ps.filter((p) => p.view.frozen).length })}`);
      await vi.advanceTimersByTimeAsync(100);
    }

    const recs = records(store);
    expect(recs.filter((r) => r.state !== 'completed')).toEqual([]);
    const violations: unknown[] = [];
    for (const r of recs) {
      const p = (await q.getJob(r.id))!.progress;
      const want = { token: r.token, step: 5 };
      if (last.get(`${r.id}:${r.token}`) !== 5 || p?.kind !== 'object' || JSON.stringify(p.value) !== JSON.stringify(want)) violations.push({ id: r.id, want, got: p });
    }
    expect(violations).toEqual([]);
    // the run really had stale attempts
    expect(frozen).toBeGreaterThan(0);
    expect(recs.filter((r) => r.crashCount > 0).length).toBeGreaterThan(frozen);
  });
});
