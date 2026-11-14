import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import type { Worker } from '../../src/worker/worker.js';
import { getJobVia } from '../helpers/get-job.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const queues: Queue[] = [];
const setup = (store = new MemoryStore()) => {
  const q = new Queue('results', { store, logger: silent });
  queues.push(q);
  return { store, q, scope: q.internals.scope };
};
const nextDone = (w: Worker<unknown, unknown>) => new Promise<void>((r) => (w.once('completed', () => r()), w.once('failed', () => r())));
/** Run one job whose handler returns `value`, and read it back. */
const runOne = async (value: unknown) => {
  const s = setup();
  const w = s.q.process(() => value);
  const done = nextDone(w);
  const { job } = await s.q.add(1);
  await done;
  return { ...s, id: job.id, job: (await getJobVia(s.q, job.id))! };
};

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
});

describe('job result storage', () => {
  it('result: handler return value is readable from getJob after completion', async () => {
    const { job } = await runOne({ a: [1, 2] });
    expect(job.state).toBe('completed');
    expect(job.result).toEqual({ a: [1, 2] });
  });

  it('result: result is written atomically with completed state', async () => {
    const s = setup();
    const seen: unknown[] = [];
    const realComplete = s.store.complete.bind(s.store);
    vi.spyOn(s.store, 'complete').mockImplementation(async (scope, req) => {
      const out = await realComplete(scope, req);
      const rec = (await stored(s.store, scope, req.id))!;
      seen.push([rec.state, rec.result]);
      return out;
    });
    const w = s.q.process(() => ({ ok: true }));
    const viaListener = new Promise<unknown>((r) => w.once('completed', async ({ job }) => r(await getJobVia(s.q, job.id))));
    await s.q.add(1);
    expect(await viaListener).toMatchObject({ state: 'completed', result: { ok: true } });
    expect(seen).toEqual([['completed', '{"ok":true}']]);
  });

  it('result: undefined return stores no result and reads back as undefined; null return reads back as null', async () => {
    const u = await runOne(undefined);
    expect((await stored(u.store, u.scope, u.id))!.result).toBeNull();
    expect(u.job.result).toBeUndefined();
    const n = await runOne(null);
    expect((await stored(n.store, n.scope, n.id))!.result).toBe('null');
    expect(n.job.result).toBeNull();
  });

  it('result: falsy values 0, false and empty string round trip', async () => {
    for (const v of [0, false, '']) expect((await runOne(v)).job.result, JSON.stringify(v)).toBe(v);
  });

  it('result: non-completed job has undefined result; failed job keeps error not result', async () => {
    const s = setup();
    const { job: waiting } = await s.q.add(1);
    expect((await getJobVia(s.q, waiting.id))!.result).toBeUndefined();
    const w = s.q.process(() => Promise.reject(new TypeError('nope')));
    const done = nextDone(w);
    await done;
    const failed = (await getJobVia(s.q, waiting.id))!;
    expect(failed.state).toBe('failed');
    expect(failed.result).toBeUndefined();
    expect(failed.error!.message).toBe('nope');
  });

  it('result: result is gone when the record is removed', async () => {
    const { q, job } = await runOne({ x: 1 });
    expect(await job.remove()).toBe(true);
    expect(await getJobVia(q, job.id)).toBeNull();
  });

  it('result: completed event carries the round-tripped result', async () => {
    const c = { t: 1_000_000 };
    const s = setup(new MemoryStore({ clock: () => c.t }));
    const w = s.q.process(() => {
      c.t += 250;
      return { when: new Date(0), gone: undefined, n: 1 };
    });
    const fromWorker = new Promise<{ job: { id: string; state: string }; result: unknown; durationMs: number }>((r) => w.once('completed', r as never));
    const fromQueue = new Promise<{ result: unknown }>((r) => s.q.once('completed', r as never));
    const { job } = await s.q.add(1);
    const wp = await fromWorker;
    const qp = await fromQueue;
    const expected = { when: '1970-01-01T00:00:00.000Z', n: 1 };
    expect(wp.result).toEqual(expected);
    expect(qp.result).toEqual(expected);
    expect(wp.result).toEqual((await getJobVia(s.q, job.id))!.result);
    expect(wp.durationMs).toBe(250);
    expect(wp.job.state).toBe('completed');
  });

  it('result: second pod reads the same result', async () => {
    const { store, q, id } = await runOne({ shared: true });
    const other = setup(store).q;
    expect((await getJobVia(other, id))!.result).toEqual((await getJobVia(q, id))!.result);
    expect((await getJobVia(other, id))!.result).toEqual({ shared: true });
  });
});
