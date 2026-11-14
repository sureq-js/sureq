import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from '../../src/queue/queue.js';
import type { EnsureNamespaceMetaResult, JobRecord } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { live } from '../helpers/pods.js';
import { K, K1, OLD, podOn, type Release } from '../helpers/releases.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
  vi.useRealTimers();
});

async function world() {
  useFakeTime();
  const store = new MemoryStore({ clock: () => Date.now() });
  await store.open();
  /** Handler calls per job id, and which pod ran each call. */
  const runs = new Map<string, string[]>();
  const pod = (label: string, rel: Release, opts: { slow?: number } = {}) => {
    /** What the store handed this pod: every claimed record and every swept id. */
    const got = { claimed: [] as JobRecord[], swept: [] as string[] };
    const seen = spyStore(store, {
      claim: async (sc, req) => {
        const res = await store.claim(sc, req);
        got.claimed.push(...res.jobs);
        return res;
      },
      sweep: async (sc, req) => {
        const res = await store.sweep(sc, req);
        got.swept.push(...res.swept.map((j) => j.id));
        return res;
      },
    });
    const q = podOn(seen.store, rel);
    queues.push(q);
    const events = { degraded: vi.fn(), error: vi.fn() };
    q.on('degraded', events.degraded);
    q.on('error', events.error);
    const ran: Array<{ id: string; at: number }> = [];
    const start = () => q.process(async (job) => {
      runs.set(job.id, [...(runs.get(job.id) ?? []), label]);
      ran.push({ id: job.id, at: Date.now() });
      if (opts.slow) await new Promise((r) => setTimeout(r, opts.slow));
      return null;
    }, live);
    return { q, events, ran, start, got };
  };
  const addN = async (q: Queue, n: number) => (await q.addBulk(Array.from({ length: n }, (_, i) => ({ data: { i } })))).map((o) => {
    if (!o.ok) throw new TypeError('add failed');
    return o.job.id;
  });
  const until = async (done: () => Promise<boolean>, maxMs = 120_000) => {
    for (let t = 0; t < maxMs && !(await done()); t += 100) await vi.advanceTimersByTimeAsync(100);
  };
  const scope = { namespace: 'default', queue: 'fmt' };
  return { store, runs, pod, addN, until, scope };
}

describe('format across releases', () => {
  it('format: adjacent-minor pods share a store through a format raise', async () => {
    const w = await world();
    const a = w.pod('A', K, { slow: 100 });
    const d = w.pod('D', OLD, { slow: 100 });
    a.start();
    d.start();
    const v1 = await w.addN(a.q, 100);

    const ensured: EnsureNamespaceMetaResult[] = [];
    const spied = spyStore(w.store, {
      ensureNamespaceMeta: async (...args) => {
        const r = await w.store.ensureNamespaceMeta(...args);
        ensured.push(r);
        return r;
      },
    });
    const bq = podOn(spied.store, K1);
    queues.push(bq);
    const b = { q: bq, events: { degraded: vi.fn(), error: vi.fn() }, ran: [] as string[] };
    bq.on('degraded', b.events.degraded);
    bq.on('error', b.events.error);
    await bq.ready();
    expect(ensured).toEqual([{ formatVersion: 2, created: false, raised: true }]);
    expect(await w.store.getNamespaceMeta({ namespace: 'default' })).toMatchObject({ formatVersion: 2, lastRaisedBy: '0.5.0' });
    const v2 = await w.addN(bq, 100);
    for (const id of v2) expect((await w.store.get(w.scope, id))!.formatVersion).toBe(2);
    bq.process(async (job) => {
      w.runs.set(job.id, [...(w.runs.get(job.id) ?? []), 'B']);
      b.ran.push(job.id);
      await new Promise((r) => setTimeout(r, 100));
      return null;
    }, live);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(d.events.degraded).toHaveBeenCalledTimes(1);
    // format-1 jobs added after D degraded: D reads them, but a degraded pod claims nothing
    const late = await w.addN(a.q, 50);
    await w.until(async () => (await w.store.counts(w.scope)).completed === 250);
    await vi.advanceTimersByTimeAsync(60_000);

    // D reads only format 1: the store never handed it a format-2 job, before or after it degraded
    expect(d.got.claimed.filter((j) => j.formatVersion !== 1).map((j) => j.id)).toEqual([]);
    expect(d.got.swept.filter((id) => v2.includes(id))).toEqual([]);
    expect(d.ran.filter((r) => v2.includes(r.id))).toEqual([]);
    expect(d.got.claimed.filter((j) => late.includes(j.id))).toEqual([]);
    expect(d.events.error).not.toHaveBeenCalled();
    for (const id of [...v1, ...v2, ...late]) expect(w.runs.get(id), id).toHaveLength(1);
    expect(late.every((id) => ['A', 'B'].includes(w.runs.get(id)![0]!))).toBe(true);
    expect(a.ran.some((r) => v2.includes(r.id))).toBe(true);
    expect(b.ran.some((id) => v1.includes(id))).toBe(true);
    for (const pod of [a, b]) {
      expect(pod.events.degraded).not.toHaveBeenCalled();
      expect(pod.events.error).not.toHaveBeenCalled();
    }
    expect((await d.q.health()).live).toBe(true);

    const before = w.store.dump();
    const c = podOn(w.store, OLD);
    queues.push(c);
    await expect(c.ready()).rejects.toMatchObject({ reason: 'too-new' });
    expect(w.store.dump()).toEqual(before);
  });

  it('format: adjacent releases k and k+1 share a store and process each other\'s jobs', async () => {
    const w = await world();
    const k = w.pod('K', K, { slow: 10 });
    const k1 = w.pod('K1', K1, { slow: 10 });
    const fromK = await w.addN(k.q, 20);
    const fromK1 = await w.addN(k1.q, 20);
    k.start();
    k1.start();
    await w.until(async () => (await w.store.counts(w.scope)).completed === 40);
    for (const id of [...fromK, ...fromK1]) expect(w.runs.get(id), id).toHaveLength(1);
    expect(k.ran.some((r) => fromK1.includes(r.id))).toBe(true);
    expect(k1.ran.some((r) => fromK.includes(r.id))).toBe(true);
    for (const pod of [k, k1]) {
      expect(pod.events.degraded).not.toHaveBeenCalled();
      expect(pod.events.error).not.toHaveBeenCalled();
    }
  });
});
