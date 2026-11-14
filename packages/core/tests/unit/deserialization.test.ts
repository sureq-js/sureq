import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeserializationError } from '../../src/errors/catalog.js';
import type { SerializedError } from '../../src/serialize/error.js';
import { Queue } from '../../src/queue/queue.js';
import type { JobRecord, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { collect, next, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const BAD = '{"secret": "SECRET-12345"'; // cut short: not valid JSON
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

type Overrides = Parameters<typeof spyStore>[1];
/** A store whose claimed and read records of the jobs in `bad` carry a stored `field` that is not valid JSON. */
function corrupting(bad: Set<string>, over: Overrides = {}, field: 'data' | 'error' = 'data', inner = new MemoryStore()): Store {
  const spoil = (rec: JobRecord): JobRecord => (bad.has(rec.id) ? { ...rec, [field]: BAD } : rec);
  return spyStore(inner, {
    claim: async (...a) => {
      const res = await inner.claim(...a);
      return { ...res, jobs: res.jobs.map(spoil) };
    },
    get: async (...a) => {
      const rec = await inner.get(...a);
      return rec && spoil(rec);
    },
    ...over,
  }).store;
}

/** Errors that escaped to the process while `fn` ran: uncaught exceptions and unhandled rejections. */
async function escaped(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const on = (e: unknown) => void seen.push(e);
  process.on('uncaughtException', on);
  process.on('unhandledRejection', on);
  try {
    await fn();
  } finally {
    process.off('uncaughtException', on);
    process.off('unhandledRejection', on);
  }
  return seen;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function queue(store: Store): Queue {
  const q = new Queue('d', { store, logger: silent, defaultJobOptions: { maxAttempts: 3 } });
  closers.push(() => q.close());
  return q;
}

describe('stored data that cannot be deserialized', () => {
  it('deserialization: a worker fails that job for good with DeserializationError and runs the others claimed with it', async () => {
    const bad = new Set<string>();
    const q = queue(corrupting(bad));
    await q.add({ n: 1 }, { id: 'bad' });
    await q.add({ n: 2 }, { id: 'good' });
    bad.add('bad');
    const ran: unknown[] = [];
    const w = q.process(async (job) => void ran.push(job.data), { ...poll(10), concurrency: 2, acknowledgeVolatileStore: true, autorun: false });
    const failed = next<{ job: { id: string; data: unknown; attempt: number }; error: SerializedError; reason: string }>(w, 'failed');
    const completed = next<{ job: { id: string } }>(w, 'completed');
    w.run();
    const [f, c] = await Promise.all([failed, completed]);
    expect(c.job.id).toBe('good');
    expect(ran).toEqual([{ n: 2 }]);
    expect(f.job).toMatchObject({ id: 'bad', data: null, attempt: 1 });
    expect(f.reason).toBe('unrecoverable');
    expect(f.error).toMatchObject({ name: 'DeserializationError', code: 'DESERIALIZATION_FAILED', message: 'the stored data of job "bad" cannot be deserialized' });
    expect(f.error.cause).toBeUndefined();
    expect(JSON.stringify(f.error)).not.toContain('SECRET');
    bad.clear();
    // failed for good on the first attempt: no retry, and it is a dead letter
    expect(await q.getJob('bad')).toMatchObject({ state: 'failed', attempt: 1, deadLetter: { reason: 'unrecoverable' } });
  });

  it('deserialization: a batch worker fails that job for good and hands the handler only the others', async () => {
    const bad = new Set<string>();
    const q = queue(corrupting(bad));
    await q.addBulk([{ data: { n: 1 }, opts: { id: 'bad' } }, { data: { n: 2 }, opts: { id: 'good' } }]);
    bad.add('bad');
    const batches: string[][] = [];
    const w = q.processBatch(async (batch) => void batches.push(batch.jobs.map((j) => j.id)), {
      ...poll(10), batchSize: 2, batchDelay: '50ms', acknowledgeVolatileStore: true, autorun: false,
    });
    const failed = next<{ job: { id: string }; error: SerializedError }>(w, 'failed');
    const completed = next<{ job: { id: string } }>(w, 'completed');
    w.run();
    const [f, c] = await Promise.all([failed, completed]);
    expect([f.job.id, c.job.id]).toEqual(['bad', 'good']);
    expect(f.error.code).toBe('DESERIALIZATION_FAILED');
    expect(batches).toEqual([['good']]);
  });

  it('deserialization: a batch of only unreadable jobs never calls the handler', async () => {
    const bad = new Set<string>();
    const q = queue(corrupting(bad));
    await q.addBulk([{ data: 1, opts: { id: 'a' } }, { data: 2, opts: { id: 'b' } }]);
    bad.add('a').add('b');
    let calls = 0;
    const w = q.processBatch(async () => void calls++, { ...poll(10), batchSize: 2, batchDelay: '50ms', acknowledgeVolatileStore: true, autorun: false });
    const failed = collect<{ job: { id: string }; error: SerializedError }>(w, 'failed', 2);
    w.run();
    const all = await failed;
    expect(all.map((f) => f.job.id).sort()).toEqual(['a', 'b']);
    for (const f of all) expect(f.error.code).toBe('DESERIALIZATION_FAILED');
    expect(calls).toBe(0);
  });

  it('deserialization: reading such a job throws DeserializationError, not a SyntaxError that quotes the data', async () => {
    const bad = new Set(['x']);
    const q = queue(corrupting(bad));
    await q.add({ n: 1 }, { id: 'x' });
    const err = await q.getJob('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeserializationError);
    expect((err as Error).message).toBe('the stored data of job "x" cannot be deserialized');
  });

  it('deserialization: a batch worker that loses the lease of an unreadable job emits leaseLost instead of throwing', async () => {
    const bad = new Set<string>();
    let refuse = false;
    const store = corrupting(bad, { renew: async () => (refuse ? { ok: false, reason: 'expired' } : { ok: true, expiresAt: Date.now() + 1000, now: Date.now() }) });
    const q = new Queue('d', { store, logger: silent, leaseDuration: '1s', defaultJobOptions: { maxAttempts: 3 } });
    closers.push(() => q.close());
    await q.add({ n: 1 }, { id: 'bad' });
    bad.add('bad');
    refuse = true;
    const lost: string[] = [];
    q.on('leaseLost', (p) => void lost.push(p.job.id));
    q.on('error', () => {});
    const out = await escaped(async () => {
      q.processBatch(async () => {}, { ...poll(10), batchSize: 5, batchDelay: '2s', acknowledgeVolatileStore: true });
      await vi.waitFor(() => expect(lost.length).toBeGreaterThan(0), { timeout: 2000 }).catch(() => {});
    });
    expect(out).toEqual([]);
    expect(lost).toEqual(['bad']);
  });

  it('deserialization: the local lease deadline of an unreadable job passing during a store outage does not crash the process', async () => {
    const bad = new Set<string>();
    let down = false;
    const store = corrupting(bad, {
      renew: async () => {
        if (down) throw new Error('ECONNRESET');
        return { ok: true, expiresAt: Date.now() + 1000, now: Date.now() };
      },
    });
    const q = new Queue('d', { store, logger: silent, leaseDuration: '1s', defaultJobOptions: { maxAttempts: 3 } });
    closers.push(() => q.close());
    await q.add({ n: 1 }, { id: 'bad' });
    bad.add('bad');
    down = true;
    const lost: string[] = [];
    q.on('leaseLost', (p) => void lost.push(p.job.id));
    q.on('error', () => {});
    const out = await escaped(async () => {
      q.processBatch(async () => {}, { ...poll(10), batchSize: 5, batchDelay: '3s', acknowledgeVolatileStore: true });
      await sleep(1500);
    });
    down = false;
    expect(out).toEqual([]);
    expect(lost).toEqual(['bad']);
  });

  it('deserialization: an unreadable job deleted as it fails still emits failed, and no internal error', async () => {
    const bad = new Set<string>();
    const q = new Queue('d', { store: corrupting(bad), logger: silent, deadLetter: false, retention: { failed: 0, resultGrace: 0 }, defaultJobOptions: { maxAttempts: 3 } });
    closers.push(() => q.close());
    await q.add({ n: 1 }, { id: 'bad' });
    bad.add('bad');
    const errors: string[] = [];
    q.on('error', (e) => void errors.push(`${e.source}/${e.context.operation}: ${e.error.message}`));
    const w = q.process(async () => {}, { ...poll(10), acknowledgeVolatileStore: true, autorun: false });
    const failed = next<{ job: { id: string }; error: SerializedError; removed?: boolean }>(w, 'failed');
    w.run();
    const f = await failed;
    expect(f).toMatchObject({ job: { id: 'bad' }, removed: true, error: { code: 'DESERIALIZATION_FAILED' } });
    await sleep(50);
    expect(errors).toEqual([]);
  });

  it('deserialization: a claimed job whose stored error is unreadable fails for good, and the jobs claimed with it run', async () => {
    const bad = new Set<string>();
    const inner = new MemoryStore();
    const q = queue(corrupting(bad, {}, 'error', inner));
    await q.add({ n: 1 }, { id: 'bad' });
    await q.add({ n: 2 }, { id: 'good' });
    bad.add('bad');
    const ran: string[] = [];
    const w = q.process(async (job) => void ran.push(job.id), { ...poll(10), concurrency: 2, acknowledgeVolatileStore: true, autorun: false });
    const failed = next<{ job: { id: string }; error: SerializedError; reason: string }>(w, 'failed');
    const completed = next<{ job: { id: string } }>(w, 'completed');
    w.run();
    const [f, c] = await Promise.all([failed, completed]);
    expect(c.job.id).toBe('good');
    expect(ran).toEqual(['good']);
    expect(f).toMatchObject({ job: { id: 'bad' }, reason: 'unrecoverable', error: { code: 'DESERIALIZATION_FAILED', message: 'the stored error of job "bad" cannot be deserialized' } });
    await vi.waitFor(() => expect(w.inFlight).toBe(0));
    expect((await inner.get({ namespace: 'default', queue: 'd' }, 'bad'))?.state).toBe('failed');
  });

  it('deserialization: a batch worker given a job whose stored error is unreadable fails it and hands the handler the rest', async () => {
    const bad = new Set<string>();
    const q = queue(corrupting(bad, {}, 'error'));
    await q.addBulk([{ data: 1, opts: { id: 'bad' } }, { data: 2, opts: { id: 'good' } }]);
    bad.add('bad');
    const batches: string[][] = [];
    const w = q.processBatch(async (b) => void batches.push(b.jobs.map((j) => j.id)), { ...poll(10), batchSize: 2, batchDelay: '50ms', acknowledgeVolatileStore: true, autorun: false });
    const failed = next<{ job: { id: string }; error: SerializedError }>(w, 'failed');
    const completed = next<{ job: { id: string } }>(w, 'completed');
    const out = await escaped(async () => {
      w.run();
      await Promise.all([failed, completed]);
    });
    expect(out).toEqual([]);
    expect((await failed).error.code).toBe('DESERIALIZATION_FAILED');
    expect(batches).toEqual([['good']]);
    await vi.waitFor(() => expect(w.inFlight).toBe(0));
  });
});
