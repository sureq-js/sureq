import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreNotReadyError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { clientFor } from '../../src/store/client.js';
import { harness, next, silent } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe('ready and store time', () => {
  it('ready: resolves after open and one now call', async () => {
    const raw = new MemoryStore();
    const g = gate();
    const spy = spyStore(raw, { open: () => g.p.then(() => raw.open()) });
    const q = new Queue('r', { store: spy.store, logger: silent });
    let done = false;
    const ready = q.ready().then(() => (done = true));
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    g.open();
    await ready;
    expect(spy.calls.map((c) => c.op)).toEqual(['open', 'ensureNamespaceMeta', 'now']);
  });

  it('ready: concurrent calls share one attempt', async () => {
    const spy = spyStore(new MemoryStore());
    const q = new Queue('r', { store: spy.store, logger: silent });
    await Promise.all(Array.from({ length: 10 }, () => q.ready()));
    expect(spy.calls.filter((c) => c.op === 'open')).toHaveLength(1);
    expect(spy.calls.filter((c) => c.op === 'now')).toHaveLength(1);
  });

  it('ready: rejects with StoreNotReadyError after the timeout', async () => {
    vi.useFakeTimers();
    const hanging = spyStore(new MemoryStore(), { open: () => new Promise(() => {}) }).store;
    const h = new Queue('r', { store: hanging, logger: silent }).ready({ timeoutMs: 50 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(49);
    await vi.advanceTimersByTimeAsync(1);
    expect(await h).toBeInstanceOf(StoreNotReadyError);

    const down = spyStore(new MemoryStore(), { open: () => Promise.reject(new Error('down')) });
    clientFor(down.store).configure({ initialDelayMs: 100, maxDelayMs: 30_000, factor: 2, jitter: 0.2, random: () => 0.5 });
    const dq = new Queue('r', { store: down.store, logger: silent });
    const d = dq.ready({ timeoutMs: 350 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(350);
    const e = (await d) as StoreNotReadyError;
    expect(e).toBeInstanceOf(StoreNotReadyError);
    expect(((e.cause as Error).cause as Error).message).toBe('down');
    // It retried on the reconnect schedule while down; the probe goes on until the queue closes.
    const opens = () => down.calls.filter((c) => c.op === 'open').length;
    expect(opens()).toBe(3); // at 0, 100 and 300 ms
    await vi.advanceTimersByTimeAsync(400);
    expect(opens()).toBe(4); // at 700 ms
    await dq.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clock: getStoreTime makes one now call and caches nothing', async () => {
    const clock = { t: 5_000 };
    const spy = spyStore(new MemoryStore({ clock: () => clock.t }));
    const q = new Queue('r', { store: spy.store, logger: silent });
    expect(await q.getStoreTime()).toBe(5_000);
    clock.t = 7_000;
    expect(await q.getStoreTime()).toBe(7_000);
    expect(spy.calls.filter((c) => c.op === 'now')).toHaveLength(2);
  });
});

/** Every number anywhere inside `v`. */
function numbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (v instanceof Date) out.push(v.getTime());
  else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) numbers(x, out);
  return out;
}

describe('store clock authority', () => {
  it('contract: core never calls a store method with a Date or pod time', async () => {
    const SENTINEL = 4_102_444_800_000;
    vi.spyOn(Date, 'now').mockReturnValue(SENTINEL);
    const h = harness();
    const spy = spyStore(h.raw);
    const q = new Queue('pod', { store: spy.store, logger: silent, defaultJobOptions: { backoff: 100 } });
    await q.add({ n: 1 }, { delay: 1000 });
    const w = q.process((job) => {
      if ((job.data as { n: number }).n === 2) throw new TypeError('retry me');
    });
    const done = next(w, 'completed');
    const retried = next(w, 'retrying');
    h.clock.advance(1000);
    await q.add({ n: 2 });
    await Promise.all([done, retried]);
    await w.close();
    for (const c of spy.calls) {
      for (const n of numbers(c.args)) expect(Math.abs(n - SENTINEL), `${c.op}`).toBeGreaterThan(3_600_000);
      expect(JSON.stringify(c.args)).not.toMatch(/"\d{4}-\d\d-\d\dT/);
    }
  });

  it('clock: backoff delay is sent as retryInMs', async () => {
    const h = harness();
    const spy = spyStore(h.raw);
    const q = new Queue('pod', { store: spy.store, logger: silent, defaultJobOptions: { backoff: 250 } });
    const w = q.process(() => {
      throw new TypeError('again');
    });
    const retried = next(w, 'retrying');
    await q.add(1, { maxAttempts: 2 });
    await retried;
    await w.close();
    const fail = spy.calls.find((c) => c.op === 'fail')!;
    const req = fail.args[1] as Record<string, unknown>;
    expect(Number.isInteger(req['retryInMs'])).toBe(true);
    expect(req['retryInMs']).toBe(250);
    for (const k of ['runAt', 'expiresAt', 'now']) expect(req).not.toHaveProperty(k);
  });

  it('clock: Date.now appears in core source only in the listed pod-local places', () => {
    const root = join(import.meta.dirname, '../../src');
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    const hits = files.filter((f) => readFileSync(join(root, f), 'utf8').includes('Date.now')).map((f) => relative(root, join(root, f)));
    // uuidv7's default (worker ids), pause event `at`, health `checkedAt` and `lastLoopAt`, the memory store's default clock.
    expect(hits.sort()).toEqual(['health/health.ts', 'queue/base.ts', 'store/memory/memory-store.ts', 'util/uuidv7.ts', 'worker/worker.ts']);
  });

  it('ready: a pending ready rejects with QueueClosedError when the queue closes', async () => {
    vi.useFakeTimers();
    const down = spyStore(new MemoryStore(), { open: () => Promise.reject(new Error('down')) });
    const q = new Queue('r', { store: down.store, logger: silent });
    const r = q.ready().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(150);
    await q.close();
    expect(await r).toMatchObject({ code: 'QUEUE_CLOSED' });
    const hanging = spyStore(new MemoryStore(), { open: () => new Promise(() => {}) }).store;
    const h = new Queue('r', { store: hanging, logger: silent });
    const hr = h.ready().catch((e: unknown) => e);
    await h.close();
    expect(await hr).toMatchObject({ code: 'QUEUE_CLOSED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ready: reads after close reject with QueueClosedError and never reopen the store', async () => {
    const spy = spyStore(new MemoryStore());
    const q = new Queue('r', { store: spy.store, logger: silent });
    q.internals.client.attach(true); // as if the queue had created it
    await q.ready();
    await q.close();
    const opens = spy.calls.filter((c) => c.op === 'open').length;
    for (const call of [() => q.getJob('x'), () => q.getStoreTime(), () => q.ready(), () => q.getCounts(), () => q.getJobs('waiting'), () => q.remove('x')]) {
      await expect(call()).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    }
    expect(spy.calls.filter((c) => c.op === 'open')).toHaveLength(opens);
  });
});
