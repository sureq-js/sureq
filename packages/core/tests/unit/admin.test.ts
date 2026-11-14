import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, QueueNotIdleError, QueueObliteratingError, StoreError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { SUREQ_VERSION } from '../../src/format/support.js';
import type { JobState, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore, type SpyCall } from '../helpers/spy-store.js';

const open: Queue[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((q) => q.close()));
});

function queue(store: Store, name = 'adm', opts: Record<string, unknown> = {}): Queue {
  const q = new Queue(name, { store, logger: silent, ...opts });
  open.push(q);
  return q;
}

function spied(over: Parameters<typeof spyStore>[1] = {}): { store: Store; calls: SpyCall[]; inner: MemoryStore } {
  const inner = new MemoryStore();
  return { ...spyStore(inner, over), inner };
}

/** Add `n` jobs and finish them straight through the store: `complete`d or `fail`ed for good. */
async function finished(q: Queue, store: Store, n: number, how: 'complete' | 'fail' = 'complete'): Promise<string[]> {
  const scope = q.internals.scope;
  const ids = (await q.addBulk(Array.from({ length: n }, (_, i) => ({ data: i, opts: { maxAttempts: 1 } })))).map((r) => (r.ok ? r.job.id : ''));
  const { jobs } = await store.claim(scope, { workerId: 'w', limit: n, leaseMs: 600_000, claimId: `c-${ids[0]}` });
  for (const j of jobs) {
    if (how === 'complete') await store.complete(scope, { id: j.id, token: j.token, result: null });
    else await store.fail(scope, { id: j.id, token: j.token, error: '{"v":1,"name":"E","message":"boom"}', deadLetter: {} });
  }
  return ids;
}

const STATES: JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];
async function listedCounts(q: Queue): Promise<Record<JobState, number>> {
  const out = {} as Record<JobState, number>;
  for (const s of STATES) out[s] = (await q.getJobs(s, { limit: 1000 })).length;
  return out;
}
const issuePath = (e: unknown): string[] => (e as InvalidOptionError).issues.map((i) => i.path);

describe('admin', () => {
  it('admin: clean rejects active state', async () => {
    const { store, calls } = spied();
    const q = queue(store);
    const e = await q.clean('active' as never, 0).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect(issuePath(e)).toEqual(['state']);
    expect(calls.filter((c) => c.op === 'clean')).toEqual([]);
  });

  it('admin: clean limit stops early and reports done false', async () => {
    const { store, calls } = spied();
    const q = queue(store);
    const cleaned: unknown[] = [];
    q.on('cleaned', (e) => void cleaned.push(e));
    await finished(q, store, 5);
    expect(await q.clean('completed', 0, { limit: 3, pageSize: 2 })).toEqual({ removed: 3, done: false });
    expect(calls.filter((c) => c.op === 'clean').map((c) => (c.args[1] as { limit: number }).limit)).toEqual([2, 1]);
    expect(await q.clean('completed', '0s')).toEqual({ removed: 2, done: true });
    expect(await q.clean('completed', 0)).toEqual({ removed: 0, done: true });
    expect(cleaned).toEqual([{ state: 'completed', removed: 3 }, { state: 'completed', removed: 2 }]);
  });

  it('admin: clean of failed removes dead-lettered jobs', async () => {
    const { store } = spied();
    const q = queue(store);
    await finished(q, store, 2, 'fail');
    expect(await q.countDeadLetters()).toBe(2);
    expect(await q.clean('failed', 0)).toEqual({ removed: 2, done: true });
    expect(await q.countDeadLetters()).toBe(0);
  });

  it('admin: counts are correct after clean, drain, obliterate', async () => {
    const { store } = spied();
    const q = queue(store);
    await finished(q, store, 3);
    await q.addBulk([{ data: 1 }, { data: 2 }, { data: 3, opts: { delay: '1h' } }]);
    const check = async (want: Partial<Record<JobState, number>>) => {
      const counts = await q.getCounts();
      expect(await listedCounts(q)).toEqual(Object.fromEntries(STATES.map((s) => [s, counts[s]])));
      expect(counts).toMatchObject(want);
    };
    await check({ completed: 3, waiting: 2, delayed: 1 });
    await q.clean('completed', 0);
    await check({ completed: 0, waiting: 2, delayed: 1 });
    await q.drain();
    await check({ waiting: 0, delayed: 1 });
    await q.obliterate();
    await check({ waiting: 0, delayed: 0, completed: 0 });
  });

  it('admin: drain does not emit the drained event by itself', async () => {
    const { store } = spied();
    const q = queue(store);
    let drained = 0;
    q.on('drained', () => void drained++);
    expect(await q.drain()).toEqual({ removed: 0 });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    await q.add({ n: 0 });
    q.process(async () => {
      started();
      await gate;
    }, { acknowledgeVolatileStore: true, ...poll(10) });
    await running;
    await q.addBulk([{ data: 1 }, { data: 2 }, { data: 3 }]);
    expect(await q.drain()).toEqual({ removed: 3 });
    expect(drained).toBe(0);
    open();
    await vi.waitFor(() => expect(drained).toBe(1));
    expect(drained).toBe(1);
    await q.add({ n: 9 }, { delay: '1h' });
    expect(await q.drain({ delayed: true })).toEqual({ removed: 1 });
  });

  it('admin: invalid pageSize throws InvalidOptionError', async () => {
    const { store, calls } = spied();
    const q = queue(store);
    const before = calls.length;
    for (const pageSize of [0, 5001, 1.5, '10']) {
      for (const call of [() => q.clean('completed', 0, { pageSize } as never), () => q.drain({ pageSize } as never), () => q.obliterate({ pageSize } as never)]) {
        const e = await call().catch((x: unknown) => x);
        expect(e, String(pageSize)).toBeInstanceOf(InvalidOptionError);
        expect(issuePath(e)).toEqual(['pageSize']);
      }
    }
    expect(issuePath(await q.clean('completed', -1).catch((x: unknown) => x))).toEqual(['olderThan']);
    expect(issuePath(await q.clean('completed', 0, { limit: 0 }).catch((x: unknown) => x))).toEqual(['limit']);
    expect(calls.slice(before).filter((c) => c.op === 'clean' || c.op === 'obliterate')).toEqual([]);
  });

  it('admin: obliterate leaves other queues and namespaces untouched', async () => {
    const store = new MemoryStore();
    const a1 = queue(store, 'a', { namespace: 'n1' });
    const b1 = queue(store, 'b', { namespace: 'n1' });
    const a2 = queue(store, 'a', { namespace: 'n2' });
    for (const q of [a1, b1, a2]) await q.addBulk([{ data: 1 }, { data: 2 }]);
    const events: unknown[] = [];
    a1.on('obliterated', (e) => void events.push(e));
    expect(await a1.obliterate()).toEqual({ removed: 2 });
    expect(events).toEqual([{ removed: 2 }]);
    expect((await a1.getCounts()).waiting).toBe(0);
    for (const q of [b1, a2]) expect((await q.getCounts()).waiting).toBe(2);
  });

  it('admin: obliterate is refused while an older-version pod is registered', async () => {
    const worker = (sureqVersion: string) => ({
      workerId: 'w', queues: ['adm'], names: null, concurrency: 1, sureqVersion, formatVersion: 1, heartbeatIntervalMs: 10_000, host: 'h', pid: 1,
      labels: {}, scheduler: false, activeJobs: 0, status: 'running' as const, startedAt: 0, lastHeartbeatAt: 0,
    });
    const meta = (lastRaisedBy: string) => ({ formatVersion: 1, createdBy: lastRaisedBy, lastRaisedBy, updatedAt: 0 });
    const cases: Array<[string | null, string | null, boolean]> = [
      ['0.2.9', null, false], [null, '0.2.0', false], [SUREQ_VERSION, SUREQ_VERSION, true], ['1.0.0', '1.0.0', true], ['1.0.0-rc.1', '1.0.0-rc.1', true], ['0.2.0-rc.1', null, false], ['garbage', null, false],
    ];
    for (const [workerVersion, metaVersion, proceeds] of cases) {
      const { store, calls } = spied({
        listWorkers: async () => ({ workers: workerVersion === null ? [] : [worker(workerVersion)], now: 0 }),
        getNamespaceMeta: async () => (metaVersion === null ? null : meta(metaVersion)),
      });
      const q = queue(store);
      await q.add(1);
      const res = await q.obliterate({ force: true }).catch((e: unknown) => e);
      const label = `${workerVersion} ${metaVersion}`;
      if (proceeds) {
        expect(res, label).toEqual({ removed: 1 });
        continue;
      }
      expect(res, label).toBeInstanceOf(InvalidOptionError);
      const issue = (res as InvalidOptionError).issues[0]!;
      expect([issue.path, issue.code], label).toEqual(['obliterate', 'invalid_value']);
      expect(issue.message.startsWith('mixed-versions:'), label).toBe(true);
      expect(calls.filter((c) => c.op === 'obliterate'), label).toEqual([]);
      expect((await q.getCounts()).waiting, label).toBe(1);
    }
  });

  it('admin: obliterate with a running handler and no force throws QueueNotIdleError, and force aborts the handler through fencing', async () => {
    const { store } = spied();
    const q = queue(store);
    const lost: Array<{ reason: string }> = [];
    let failed = 0;
    q.on('leaseLost', (e) => void lost.push(e));
    q.on('failed', () => void failed++);
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    q.process(async () => {
      started();
      await gate;
    }, { acknowledgeVolatileStore: true, ...poll(10) });
    await q.add(1);
    await running;
    const e = await q.obliterate().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(QueueNotIdleError);
    expect((e as QueueNotIdleError).active).toBe(1);
    expect(await q.obliterate({ force: true })).toEqual({ removed: 1 });
    // the handler's complete is the stale write the fence refuses
    open();
    await vi.waitFor(() => expect(lost.length).toBe(1));
    expect(lost[0]!.reason).toBe('not-active');
    expect(failed).toBe(0);
  });

  it('format: obliterate is refused while a registered worker reports an incompatible version', async () => {
    const { store, calls } = spied({
      listWorkers: async () => ({
        workers: [{
          workerId: 'old', queues: ['adm'], names: null, concurrency: 1, sureqVersion: '0.2.4', formatVersion: 1, heartbeatIntervalMs: 10_000, host: 'h',
          pid: 1, labels: {}, scheduler: false, activeJobs: 0, status: 'running', startedAt: 0, lastHeartbeatAt: 0,
        }],
        now: 0,
      }),
    });
    const q = queue(store);
    await q.addBulk([{ data: 1 }, { data: 2 }]);
    const e = await q.obliterate({ force: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect((e as InvalidOptionError).issues[0]!.message).toMatch(/^mixed-versions:/);
    expect(calls.filter((c) => c.op === 'obliterate')).toEqual([]);
    expect((await q.getCounts()).waiting).toBe(2);
  });

  it('admin: workers idle and the sweeper is quiet while the queue is obliterating', async () => {
    vi.useFakeTimers();
    const marked = () => Promise.reject(new QueueObliteratingError({ queue: 'adm' }));
    const { store, calls } = spied({ claim: marked, sweep: marked });
    const q = queue(store);
    const errors: unknown[] = [];
    q.on('error', (e) => void errors.push(e));
    q.process(async () => undefined, { acknowledgeVolatileStore: true, pollMin: 100, pollMax: 1000, sweepInterval: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    const before = calls.filter((c) => c.op === 'claim').length;
    await vi.advanceTimersByTimeAsync(3000);
    const claims = calls.filter((c) => c.op === 'claim').length - before;
    expect(errors).toEqual([]);
    expect(claims).toBeGreaterThanOrEqual(2);
    expect(claims).toBeLessThanOrEqual(4);
    expect(calls.filter((c) => c.op === 'sweep').length).toBeGreaterThanOrEqual(2);
  });

  it('admin: a forced obliterate while a handler reports progress emits no error', async () => {
    let wrote = false;
    const inner = new MemoryStore();
    const { store } = spyStore(inner, {
      setProgress: async (...a) => {
        try {
          return await inner.setProgress(...a);
        } finally {
          wrote = true;
        }
      },
    });
    const q = queue(store);
    const errors: unknown[] = [];
    const lost: unknown[] = [];
    q.on('error', (e) => void errors.push(e));
    q.on('leaseLost', (e) => void lost.push(e));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    q.process(async (_job, ctx) => {
      started();
      await gate;
      await ctx.progress(50).catch(() => undefined);
    }, { acknowledgeVolatileStore: true, progressInterval: 0, ...poll(10) });
    await q.add(1);
    await running;
    // the first page sets the marker and leaves the job, so the progress write meets the marker
    await q.add(2, { delay: '1h' });
    const scope = q.internals.scope;
    expect((await store.obliterate(scope, { force: true, limit: 1 })).done).toBe(false);
    open();
    await vi.waitFor(() => expect(wrote).toBe(true));
    await store.obliterate(scope, { limit: 5000 });
    await vi.waitFor(() => expect(lost.length).toBe(1));
    expect(errors).toEqual([]);
  });

  it('admin: obliterate keeps worker records, and a live older-version record in the registry refuses it', async () => {
    const store = new MemoryStore();
    const q = queue(store);
    const ns = { namespace: q.internals.scope.namespace };
    q.process(async () => undefined, { acknowledgeVolatileStore: true, ...poll(10) });
    await vi.waitFor(async () => expect(await q.getWorkers()).toHaveLength(1));
    const [live] = await q.getWorkers();
    expect(live!.sureqVersion).toBe(SUREQ_VERSION);
    await store.registerWorker(ns, {
      workerId: 'old', queues: ['adm'], concurrency: 1, sureqVersion: '0.2.9', formatVersion: 1, heartbeatIntervalMs: 10_000, host: 'h', pid: 1,
      labels: {}, scheduler: false,
    });
    const e = await q.obliterate().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect((e as InvalidOptionError).issues[0]!.message).toMatch(/^mixed-versions: a pod running 0\.2\.9 /);
    await store.unregisterWorker(ns, { workerId: 'old' });
    await q.addBulk([{ data: 1, opts: { delay: '1h' } }, { data: 2, opts: { delay: '1h' } }]);
    expect(await q.obliterate()).toEqual({ removed: 2 });
    expect((await q.getWorkers()).map((w) => w.workerId)).toEqual([live!.workerId]);
    expect((await store.listWorkers(ns, {})).workers.map((w) => w.workerId)).toEqual([live!.workerId]);
  });

  it('admin: removals leave the pod counters alone and no stale stats behind', async () => {
    const { store } = spied();
    const q = queue(store, 'adm', { deadLetter: { warnAbove: 1 } });
    await finished(q, store, 2, 'fail');
    await finished(q, store, 1);
    await q.add(1);
    const finishedTotal = async () => (await q.metrics()).samples.filter((x) => x.name === 'sureq_jobs_finished_total');
    const before = await finishedTotal();
    await q.internals.statsCache.refresh();
    expect((await q.health()).warnings.map((w) => w.code)).toContain('DEAD_LETTERS_HIGH');
    await q.clean('failed', 0);
    expect((await q.health()).warnings.map((w) => w.code)).not.toContain('DEAD_LETTERS_HIGH');
    await q.internals.statsCache.refresh();
    await q.obliterate();
    expect(q.internals.statsCache.latest).toBeUndefined();
    const stats = await q.internals.statsCache.refresh();
    expect(stats).toMatchObject({ deadLetters: 0, oldestWaitingRunAt: null });
    expect(Object.values(stats.counts).every((n) => n === 0)).toBe(true);
    const { samples } = await q.metrics();
    expect(samples.filter((x) => x.name === 'sureq_jobs').map((x) => 'value' in x && x.value)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await finishedTotal()).toEqual(before);
  });

  it('admin: a stats read in flight when jobs are removed does not bring the stale count back', async () => {
    let hold: (() => void) | undefined;
    const { store, inner } = spied({
      stats: async (scope, req) => {
        const read = await inner.stats(scope, req);
        await new Promise<void>((r) => (hold = r));
        return read;
      },
    });
    const q = queue(store, 'adm', { deadLetter: { warnAbove: 1 } });
    await finished(q, store, 2, 'fail');
    const stale = q.internals.statsCache.refresh();
    await vi.waitFor(() => expect(hold).toBeDefined());
    await q.clean('failed', 0);
    hold!();
    expect((await stale).deadLetters).toBe(2);
    expect(q.internals.statsCache.latest).toBeUndefined();
    expect((await q.health()).warnings.map((w) => w.code)).not.toContain('DEAD_LETTERS_HIGH');
  });

  it('admin: a redrive drops the cached stats and wakes the workers of this queue at once', async () => {
    const { store } = spied();
    const q = queue(store, 'adm', { deadLetter: { warnAbove: 1 } });
    const ids = await finished(q, store, 2, 'fail');
    const ran: string[] = [];
    q.process(async (job) => void ran.push(job.id), { ...poll(60_000), sweepInterval: 3_600_000 });
    await new Promise((r) => setTimeout(r, 50));
    await q.internals.statsCache.refresh();
    await q.redrive(ids[0]!);
    expect(q.internals.statsCache.latest).toBeUndefined();
    await vi.waitFor(() => expect(ran).toEqual([ids[0]]), { timeout: 2000 });
    await q.internals.statsCache.refresh();
    await q.redriveAll();
    expect(q.internals.statsCache.latest).toBeUndefined();
    await vi.waitFor(() => expect(ran).toEqual(ids), { timeout: 2000 });
  });

  it('admin: obliterate stops with StoreError when a page removes nothing and is not done', async () => {
    const { store, calls } = spied({ obliterate: async () => ({ removed: 0, done: false }) });
    const q = queue(store);
    const events: unknown[] = [];
    q.on('obliterated', (e) => void events.push(e));
    const e = await q.obliterate().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreError);
    expect(calls.filter((c) => c.op === 'obliterate')).toHaveLength(1);
    expect(events).toEqual([]);
  });
});
