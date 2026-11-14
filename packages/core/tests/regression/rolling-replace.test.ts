import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { live } from '../helpers/pods.js';
import { K, K1, OLD, podOn, type Release } from '../helpers/releases.js';

/** The default run is quick; `SUREQ_STRESS_JOBS` sets the release size. */
const JOBS = Number(process.env['SUREQ_STRESS_JOBS'] ?? 10_000);
const PODS = 4;
const BATCH = 250;

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
  vi.useRealTimers();
});

async function opened() {
  useFakeTime();
  const store = new MemoryStore({ clock: () => Date.now() });
  await store.open();
  return store;
}

describe('rolling replace across releases', () => {
  it('regression: old and new pods share a store through a rolling replace with no lost or double-run jobs', async () => {
    const store = await opened();
    const scope = { namespace: 'default', queue: 'fmt' };
    const calls = new Map<string, number>();
    const degraded = vi.fn();
    const start = (rel: Release) => {
      const q = podOn(store, rel);
      queues.push(q);
      q.on('degraded', degraded);
      q.process((job) => void calls.set(job.id, (calls.get(job.id) ?? 0) + 1), { ...live, concurrency: 20 });
      return q;
    };
    const producer = podOn(store, K);
    queues.push(producer);
    const pods = Array.from({ length: PODS }, () => start(K));
    let added = 0;
    const addSome = async () => {
      const n = Math.min(BATCH, JOBS - added);
      if (n > 0) await producer.addBulk(Array.from({ length: n }, (_, i) => ({ data: { n: added + i } })));
      added += n;
    };
    for (let i = 0; i < PODS; i++) {
      await addSome();
      let closed = false;
      void pods[i]!.close().then(() => (closed = true));
      while (!closed) await vi.advanceTimersByTimeAsync(10);
      pods[i] = start(K1);
      for (let t = 0; t < 2000; t += 100) {
        await addSome();
        await vi.advanceTimersByTimeAsync(100);
      }
    }
    for (let t = 0; t < 600_000 && (added < JOBS || (await store.counts(scope)).completed < JOBS); t += 100) {
      await addSome();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect((await store.counts(scope)).completed).toBe(JOBS);
    expect(store.dump().jobs.filter((j) => j.state !== 'completed')).toEqual([]);
    expect(calls.size).toBe(JOBS);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(degraded).not.toHaveBeenCalled();
    expect(store.dump().meta['default']).toMatchObject({ formatVersion: 2, lastRaisedBy: K1.sureqVersion });
  }, 60_000);

  it('regression: older pod refuses to start against a newer store', async () => {
    const store = await opened();
    const k1 = podOn(store, K1);
    queues.push(k1);
    await k1.ready();
    const before = store.dump();
    const old = podOn(store, OLD);
    queues.push(old);
    old.on('error', () => {});
    await expect(old.ready()).rejects.toMatchObject({ name: 'StoreFormatError', reason: 'too-new' });
    old.process(() => null, live).on('error', () => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.dump()).toEqual(before);
    expect(await store.listWorkers({ namespace: 'default' }, {})).toMatchObject({ workers: [] });
  });
});
