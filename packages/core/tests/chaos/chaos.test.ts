import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreUnavailableError } from '../../src/errors/catalog.js';
import type { WorkerOptions } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import type { Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { Job } from '../../src/job/job.js';
import type { Batch } from '../../src/worker/batch.js';
import type { JobContext } from '../../src/worker/context.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { Pod, flaky, rng } from '../helpers/pods.js';

type Data = { kind: 'work' | 'fail' | 'hang' | 'poison'; ms: number };
type Handler = (job: Job<Data>, ctx: JobContext, pod: Pod<Data>) => Promise<unknown>;

// The assertions read every finished job, so retention keeps them all.
const QUEUE = { leaseDuration: 1000, maxCrashes: 3, pollMin: 50, pollMax: 200, retention: { completed: true, failed: true } } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const forever = () => new Promise<never>(() => {});
/** The process-kill test's timeout; its drain deadline is whatever of this is left. */
const IPC_BUDGET_MS = 180_000;

/**
 * Pods sharing one store, kept at `size` live pods: a killed pod is frozen (never closed, never released)
 * and a fresh one starts at once. Per job it counts how often a pod running it was killed.
 */
function cluster(
  shared: Store,
  handler: Handler,
  o: { size: number; worker: WorkerOptions; batch?: { batchSize: number; batchDelay: number; run: (batch: Batch<Data>) => Promise<void> } },
) {
  const live: Array<Pod<Data>> = [];
  const all: Array<Pod<Data>> = [];
  const running = new Map<Pod<Data>, Set<string>>();
  const kills = new Map<string, number>();
  const completed = new Map<string, number>();
  const killedHolding = (id: string) => kills.set(id, (kills.get(id) ?? 0) + 1);
  const spawn = () => {
    const pod = new Pod<Data>(shared, 'chaos', QUEUE);
    running.set(pod, new Set());
    const hold = async <T>(ids: string[], body: () => Promise<T>): Promise<T> => {
      // A job claimed just before the kill starts on a pod that is already dead: it counts as killed too.
      if (pod.view.frozen) ids.forEach(killedHolding);
      for (const id of ids) running.get(pod)!.add(id);
      try {
        return await body();
      } finally {
        for (const id of ids) running.get(pod)!.delete(id);
      }
    };
    const { batch } = o;
    const worker = batch
      ? pod.processBatch({ ...o.worker, batchSize: batch.batchSize, batchDelay: batch.batchDelay }, (b) => hold(b.jobs.map((j) => j.id), () => batch.run(b)))
      : pod.process((job, ctx) => hold([job.id], () => handler(job, ctx, pod)), o.worker);
    worker.on('completed', ({ job }) => void completed.set(job.id, (completed.get(job.id) ?? 0) + 1));
    live.push(pod);
    all.push(pod);
    return pod;
  };
  const kill = (pod: Pod<Data>) => {
    if (pod.view.frozen) return;
    pod.kill();
    for (const id of running.get(pod)!) killedHolding(id);
    live.splice(live.indexOf(pod), 1);
    spawn();
  };
  for (let i = 0; i < o.size; i++) spawn();
  /** Close every pod without waiting: frozen pods never answer, so their close cannot finish. */
  const reap = async () => {
    for (const p of all) void p.queue.close({ timeoutMs: 1 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
  };
  return { live, all, kill, kills, completed, reap };
}

/** Advance fake time in 100 ms steps. */
const run = async (ms: number, each?: (t: number) => void) => {
  for (let t = 0; t < ms; t += 100) {
    each?.(t);
    await vi.advanceTimersByTimeAsync(100);
  }
};

afterEach(() => {
  vi.useRealTimers();
});

describe('chaos', { timeout: 120_000 }, () => {
  it('chaos: a frozen pod never commits or heartbeats', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const calls: string[] = [];
    let counting = true;
    const counted = new Proxy(store, {
      get(target, key) {
        const v: unknown = Reflect.get(target, key);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (counting) calls.push(String(key));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const a = new Pod<Data>(counted, 'frozen', QUEUE);
    a.process(async () => {
      await sleep(3000);
      return 'A';
    }, { sweepInterval: 500, random: rng(1) });
    const { job } = await a.queue.add({ kind: 'work', ms: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await store.get(a.queue.internals.scope, job.id))!.state).toBe('active');
    a.kill();
    calls.length = 0;
    const b = new Pod<Data>(store, 'frozen', QUEUE);
    b.process(async () => 'B', { sweepInterval: 500, random: rng(2) });
    await run(10_000);
    counting = false;
    expect(calls.filter((c) => c === 'renew' || c === 'complete' || c === 'fail' || c === 'release')).toEqual([]);
    expect(await b.queue.getJob(job.id)).toMatchObject({ state: 'completed', result: 'B', crashCount: 1 });
    void a.queue.close({ timeoutMs: 1 }).catch(() => {});
    await b.queue.close({ timeoutMs: 1 });
  });

  it('chaos: workers killed mid-job leave every job completed or failed', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const random = rng(42);
    const c = cluster(
      store,
      async (job, ctx) => {
        if (job.data.kind === 'hang') return forever();
        await sleep(job.data.ms);
        if (job.data.kind === 'fail') throw new Error('always fails');
        return ctx.attempt;
      },
      { size: 8, worker: { concurrency: 10, sweepInterval: 500, random } },
    );
    const N = 3000;
    const kinds = Array.from({ length: N }, (): 'work' | 'fail' | 'hang' => {
      const r = random();
      return r < 0.9 ? 'work' : r < 0.95 ? 'fail' : 'hang';
    });
    const opts = { work: { maxAttempts: 10 }, fail: { maxAttempts: 2 }, hang: { maxAttempts: 1, timeout: '1s', timeoutGrace: '500ms' } } as const;
    const items = kinds.map((kind, n) => ({ data: { kind, ms: 50 + Math.floor(random() * 2950) }, opts: { id: `j${n}`, ...opts[kind] } }));
    for (let i = 0; i < N; i += 1000) await c.live[0]!.queue.addBulk(items.slice(i, i + 1000));

    let nextKill = 2000;
    await run(120_000, (t) => {
      if (t < nextKill) return;
      c.kill(c.live[Math.floor(random() * c.live.length)]!);
      nextKill += 1000 + Math.floor(random() * 2000);
    });
    await run(30_000);

    const q = c.live[0]!.queue;
    const counts = await q.getCounts();
    expect(counts.waiting + counts.delayed + counts.active).toBe(0);
    expect(counts.completed + counts.failed).toBe(N);
    const jobs = await Promise.all(items.map((it) => q.getJob(it.opts.id)));
    const wrong = jobs.flatMap((job, n) => {
      const kind = kinds[n]!;
      const killed = c.kills.get(job!.id) ?? 0;
      const poisoned = killed >= 3 && job!.error?.code === 'POISON_PILL';
      // A job whose pod was killed under it may run out of attempts in the sweeper instead.
      const swept = killed > 0 && job!.state === 'failed' && (job!.error?.code === 'JOB_STALLED' || poisoned);
      const ok =
        kind === 'work'
          ? job!.state === 'completed' || poisoned
          : kind === 'fail'
            ? job!.state === 'failed' && (job!.error?.message === 'always fails' || swept)
            : job!.state === 'failed' && ((job!.error?.name === 'JobTimeoutError' && job!.error.props?.['abandoned'] === true) || swept);
      const bound = (kind === 'fail' ? 2 : 1) + killed;
      return ok && job!.attempt <= bound ? [] : [{ id: job!.id, kind, state: job!.state, attempt: job!.attempt, killed, error: job!.error?.code }];
    });
    expect(wrong).toEqual([]);
    expect([...c.completed.values()].filter((n) => n > 1)).toEqual([]);
    // The run really killed pods holding jobs.
    expect(c.kills.size).toBeGreaterThan(50);
    await c.reap();
  });

  it('chaos: a job that always kills its worker ends failed and the others are unaffected', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const random = rng(7);
    const c = cluster(
      store,
      async (job, _ctx, pod) => {
        if (job.data.kind !== 'poison') return sleep(job.data.ms);
        c.kill(pod);
        return forever();
      },
      { size: 8, worker: { concurrency: 1, sweepInterval: 500, random } },
    );
    // A producer of its own: any pod may be the one the poison job kills.
    const q = new Queue<Data>('chaos', { logger: silent, ...QUEUE, store });
    const { job: poison } = await q.add({ kind: 'poison', ms: 0 }, { maxAttempts: 10 });
    await q.addBulk(Array.from({ length: 200 }, () => ({ data: { kind: 'work' as const, ms: 50 + Math.floor(random() * 250) } })));
    await run(30_000);

    expect(await q.getJob(poison.id)).toMatchObject({ state: 'failed', crashCount: 3, error: { name: 'PoisonPillError', code: 'POISON_PILL' } });
    expect(await q.getCounts()).toMatchObject({ completed: 200, failed: 1, waiting: 0, active: 0 });
    const closing = q.close({ timeoutMs: 1 }).catch(() => {});
    await c.reap();
    await closing;
  });

  it('chaos: store faults delay and fail calls but no acknowledged add is lost', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const random = rng(99);
    const faulty = flaky(store, { random, errorRate: 0.05, maxDelayMs: 200 });
    const c = cluster(faulty, async (job) => sleep(job.data.ms), { size: 4, worker: { concurrency: 10, sweepInterval: 500, random } });
    const producer = new Queue<Data>('chaos', { logger: silent, ...QUEUE, store: faulty });
    const acked = new Set<string>();
    const add = async (id: string) => {
      for (let tries = 0; tries < 20; tries++) {
        try {
          await producer.add({ kind: 'work', ms: 50 + Math.floor(random() * 450) }, { id, onDuplicate: 'ignore', maxAttempts: 10 });
          return void acked.add(id);
        } catch (err) {
          // Unavailable, or an add whose outcome is unknown: try again with the same id.
          if (!(err instanceof StoreUnavailableError) && (err as { outcomeUnknown?: unknown }).outcomeUnknown !== true) throw err;
          await sleep(100);
        }
      }
    };
    const adds = Promise.all(Array.from({ length: 1000 }, (_, n) => add(`f${n}`)));
    await run(60_000);
    await adds;
    await run(30_000);

    expect(acked.size).toBeGreaterThan(900);
    const recs = store.dump().jobs;
    const byId = new Map(recs.map((r) => [r.id, r]));
    expect([...acked].filter((id) => byId.get(id)?.state !== 'completed')).toEqual([]);
    expect(recs.filter((r) => r.state === 'active')).toEqual([]);
    const closing = producer.close({ timeoutMs: 1 }).catch(() => {});
    await c.reap();
    await closing;
  });

  it('chaos: a killed worker\'s job is recovered with real timers', async () => {
    const store = new MemoryStore();
    let claimedBy: Pod<Data> | undefined;
    const c = cluster(
      store,
      async (_job, _ctx, pod) => {
        if (claimedBy) return 'recovered';
        claimedBy = pod;
        return forever();
      },
      { size: 3, worker: { concurrency: 1, sweepInterval: 500, random: rng(3) } },
    );
    const { job } = await c.live[0]!.queue.add({ kind: 'work', ms: 0 });
    const end = Date.now() + 5000;
    while (!claimedBy && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    c.kill(claimedBy!);
    let state: string | undefined;
    while (state !== 'completed' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
      state = (await c.live[0]!.queue.getJob(job.id))?.state;
    }
    expect(state).toBe('completed');
    expect(await c.live[0]!.queue.getJob(job.id)).toMatchObject({ result: 'recovered', crashCount: 1 });
    await Promise.all(c.all.map((p) => p.queue.close({ timeoutMs: 1 }).catch(() => {})));
  });
  it('chaos: batch workers killed mid-batch lose no job', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const random = rng(5);
    const run_ = async (batch: Batch<Data>) => {
      await sleep(Math.max(...batch.jobs.map((j) => j.data.ms)));
    };
    const c = cluster(store, forever, { size: 8, worker: { concurrency: 2, sweepInterval: 500, random }, batch: { batchSize: 20, batchDelay: 50, run: run_ } });
    const N = 3000;
    const items = Array.from({ length: N }, (_, n) => ({ data: { kind: 'work' as const, ms: 50 + Math.floor(random() * 950) }, opts: { id: `b${n}`, maxAttempts: 10 } }));
    for (let i = 0; i < N; i += 1000) await c.live[0]!.queue.addBulk(items.slice(i, i + 1000));

    let nextKill = 1000;
    await run(60_000, (t) => {
      if (t < nextKill) return;
      c.kill(c.live[Math.floor(random() * c.live.length)]!);
      nextKill += 500 + Math.floor(random() * 1000);
    });
    await run(30_000);

    const counts = await c.live[0]!.queue.getCounts();
    expect(counts.waiting + counts.delayed + counts.active).toBe(0);
    expect(counts.completed + counts.failed).toBe(N);
    expect([...c.completed.values()].filter((n) => n > 1)).toEqual([]);
    // The run really killed pods holding batches.
    expect(c.kills.size).toBeGreaterThan(50);
    await c.reap();
  });

  it('chaos: schedules keep firing once per tick while pods are killed', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const random = rng(13);
    const c = cluster(store, async (job) => sleep(job.data.ms), { size: 6, worker: { concurrency: 5, sweepInterval: 500, random } });
    const q = c.live[0]!.queue;
    const keys = ['a', 'b', 'c'];
    const firstAt = new Map<string, number>();
    for (const key of keys) {
      const { schedule } = await q.upsertSchedule(key, { every: '1s', overlap: 'allow', template: { data: { kind: 'work', ms: 20 } } });
      firstAt.set(key, schedule.nextRunAt);
    }
    let nextKill = 1000;
    await run(60_000, (t) => {
      if (t < nextKill) return;
      c.kill(c.live[Math.floor(random() * c.live.length)]!);
      nextKill += 500 + Math.floor(random() * 1500);
    });
    await run(10_000);

    const now = Date.now();
    const scope = c.live[0]!.queue.internals.scope;
    for (const key of keys) {
      const ticks = store.dump().jobs.filter((j) => j.scheduleKey === key).map((j) => j.scheduledFor!).sort((a, b) => a - b);
      const first = firstAt.get(key)!;
      // every tick due over a scheduler tick ago has fired, once and in order
      expect(ticks.length, key).toBeGreaterThanOrEqual(Math.floor((now - 1100 - first) / 1000) + 1);
      expect(ticks, key).toEqual(Array.from({ length: ticks.length }, (_, i) => first + 1000 * i));
      expect((await store.getSchedule(scope, { key }))!.runCount, key).toBe(ticks.length);
    }
    expect(c.all.length).toBeGreaterThan(30);
    await c.reap();
  });

  it("chaos: a stale attempt never changes the new attempt's progress", async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const random = rng(17);
    const last = new Map<string, number>();
    const c = cluster(
      store,
      async (job, ctx) => {
        for (let step = 1; step <= 5; step++) {
          await sleep(job.data.ms / 5);
          last.set(`${job.id}:${ctx.token}`, step);
          const write = ctx.progress({ token: ctx.token, step }).catch(() => {});
          if (step === 5) await write;
        }
        return ctx.attempt;
      },
      { size: 8, worker: { concurrency: 10, sweepInterval: 500, random } },
    );
    const N = 2000;
    const items = Array.from({ length: N }, (_, n) => ({ data: { kind: 'work' as const, ms: 50 + Math.floor(random() * 1950) }, opts: { id: `p${n}`, maxAttempts: 10 } }));
    for (let i = 0; i < N; i += 1000) await c.live[0]!.queue.addBulk(items.slice(i, i + 1000));

    // A killed pod comes back 3 s later, like one paused by GC: its writes then reach the store late.
    const thaws: Array<[Pod<Data>, number]> = [];
    let nextKill = 1000;
    await run(90_000, (t) => {
      for (const [pod, at] of thaws) if (at <= t) pod.view.unfreeze();
      if (t >= nextKill && t < 60_000) {
        const pod = c.live[Math.floor(random() * c.live.length)]!;
        c.kill(pod);
        thaws.push([pod, t + 3000]);
        nextKill += 1000 + Math.floor(random() * 2000);
      }
    });

    const q = c.live[0]!.queue;
    const counts = await q.getCounts();
    expect(counts.waiting + counts.delayed + counts.active).toBe(0);
    const violations: unknown[] = [];
    for (const it of items) {
      const job = (await q.getJob(it.opts.id))!;
      const p = job.progress;
      const value = p?.kind === 'object' ? p.value : null;
      const ok =
        job.state === 'completed'
          ? last.get(`${job.id}:${job.token}`) === 5 && JSON.stringify(value) === JSON.stringify({ token: job.token, step: 5 })
          : value === null || value['token'] === job.token;
      if (!ok) violations.push({ id: job.id, state: job.state, token: job.token, value });
    }
    expect(violations).toEqual([]);
    expect(c.kills.size).toBeGreaterThan(50);
    await c.reap();
  });

  it('chaos: worker processes killed mid-job over one store with delays, errors and stalls leave every job completed or failed', async () => {
    const began = Date.now();
    const fixture = fileURLToPath(new URL('../fixtures/chaos-pod.ts', import.meta.url));
    const store = new MemoryStore();
    const scope = { namespace: 'default', queue: 'ipc' };
    const random = rng(61);
    const N = 2000;
    // a work job killed until it runs out of crashes fails; the target leaves room for a slow or loaded machine
    const THRESHOLD = 0.9;
    const kinds = Array.from({ length: N }, () => (random() < 0.95 ? ('work' as const) : ('fail' as const)));
    const items = kinds.map((kind, n) => ({ data: { kind, ms: 20 + Math.floor(random() * 180) }, opts: { id: `c${n}`, maxAttempts: kind === 'work' ? 10 : 2 } }));
    const producer = new Queue<Data>('ipc', { logger: silent, ...QUEUE, store });
    for (let i = 0; i < N; i += 1000) await producer.addBulk(items.slice(i, i + 1000));

    const calls = store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const completed = new Map<string, number>();
    const faults = { error: 0, stallBefore: 0, stallAfter: 0 };
    const holding = new Map<ChildProcess, Set<string>>();
    const live: ChildProcess[] = [];
    const all: ChildProcess[] = [];
    let seed = 0;
    const spawn = () => {
      const child = fork(fixture, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, SEED: String(++seed) },
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      const held = new Set<string>();
      holding.set(child, held);
      // a reply to a killed process is dropped, like an answer to a pod that is gone
      child.on('error', () => {});
      const reply = (m: object) => child.connected && child.send(m, () => {});
      child.on('message', (m: { id: number; method: string; args: unknown[] } | { type: string; id?: string; fault?: string }) => {
        if ('method' in m) {
          // a store method that throws at once answers with an error too, instead of failing the runner
          new Promise((r) => r(calls[m.method]!.apply(store, m.args))).then(
            (value) => reply({ id: m.id, ok: true, value }),
            (err: unknown) => reply({ id: m.id, ok: false, error: String(err) }),
          );
        } else if (m.type === 'fault') faults[m.fault as keyof typeof faults]++;
        else if (m.type === 'active') held.add(m.id!);
        else {
          held.delete(m.id!);
          if (m.type === 'completed') completed.set(m.id!, (completed.get(m.id!) ?? 0) + 1);
        }
      });
      live.push(child);
      all.push(child);
    };
    const stuck = async () => {
      const c = await store.counts(scope);
      return c.waiting + c.delayed + c.active;
    };
    let killedHolding = 0;
    let jobs: Array<Job<Data> | null>;
    try {
      for (let i = 0; i < 4; i++) spawn();
      // SIGKILL a random process every 0.3 to 1 s for 10 s, and start a fresh one in its place; on a loaded machine
      // a fresh process may still be starting when it is picked, so keep going (up to 40 s) until one holding a job was killed
      const start = Date.now();
      while (Date.now() - start < 10_000 || (killedHolding === 0 && Date.now() - start < 40_000)) {
        await sleep(300 + Math.floor(random() * 700));
        const victim = live.splice(Math.floor(random() * live.length), 1)[0]!;
        if (holding.get(victim)!.size > 0) killedHolding++;
        victim.kill('SIGKILL');
        spawn();
      }
      // drain for the rest of the test's budget, keeping a margin for the checks, so a slow run fails with the counts
      for (const end = began + IPC_BUDGET_MS - 15_000; (await stuck()) > 0; ) {
        if (Date.now() > end) throw new Error(`chaos: jobs left stuck: ${JSON.stringify(await store.counts(scope))}`);
        await sleep(100);
      }
      jobs = await Promise.all(items.map((it) => producer.getJob(it.opts.id)));
    } finally {
      for (const child of all) child.kill('SIGKILL');
      await producer.close({ timeoutMs: 1 }).catch(() => {});
    }

    const wrong = jobs.flatMap((job, n) => {
      const kind = kinds[n]!;
      // a work job fails only by running out of attempts or crashes after kills and lost leases
      const ok = kind === 'work'
        ? job?.state === 'completed' || (job?.state === 'failed' && ['JOB_STALLED', 'POISON_PILL'].includes(String(job.error?.code)))
        : job?.state === 'failed';
      return ok ? [] : [{ id: `c${n}`, kind, state: job?.state, attempt: job?.attempt, crashCount: job?.crashCount, error: job?.error?.code }];
    });
    expect(wrong).toEqual([]);
    expect([...completed].filter(([, n]) => n > 1)).toEqual([]);
    // most work jobs complete: failing for kills and lost leases stays the exception
    const work = jobs.filter((_, n) => kinds[n] === 'work');
    const done = work.filter((j) => j?.state === 'completed').length / work.length;
    expect(done, `work jobs completed, faults ${JSON.stringify(faults)}`).toBeGreaterThanOrEqual(THRESHOLD);
    // The run really injected every kind of fault.
    expect(faults.error).toBeGreaterThan(0);
    expect(faults.stallBefore + faults.stallAfter).toBeGreaterThan(0);
    // The run really killed processes holding jobs.
    expect(killedHolding).toBeGreaterThan(0);
  }, IPC_BUDGET_MS);
});
