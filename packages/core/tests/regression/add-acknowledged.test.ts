import { describe, expect, it, vi } from 'vitest';
import { clientFor } from '../../src/store/client.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { outageStore } from '../helpers/outage.js';
import { Queue } from '../../src/queue/queue.js';
import type { NewJob, Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';

const gated = (outcome: 'open' | 'reject') => {
  const inner = new MemoryStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { store } = spyStore(inner, {
    add: async (s: Scope, jobs: NewJob[], o?: { atomic?: boolean }) => {
      await gate;
      if (outcome === 'reject') throw new TypeError('write failed');
      return inner.add(s, jobs, o);
    },
  });
  return { inner, release, q: new Queue('ack', { store, logger: silent }) };
};

describe('acknowledged add (regression)', () => {
  it('regression: add resolves only after the store acknowledged the write', async () => {
    const { inner, release, q } = gated('open');
    let resolved = false;
    const p = q.add(1).then((r) => ((resolved = true), r));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
    expect(inner.dump().jobs).toEqual([]);
    release();
    const { job } = await p;
    expect(await q.getJob(job.id)).toMatchObject({ id: job.id, state: 'waiting' });

    const failing = gated('reject');
    const f = failing.q.add(1);
    failing.release();
    await expect(f).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: true });
    expect(failing.inner.dump().jobs).toEqual([]);
  });

  it('regression: add is never acknowledged before persistence, including during an outage', async () => {
    useFakeTime();
    try {
      const inner = new MemoryStore();
      const { store, ctl } = outageStore(inner);
      clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
      const q = new Queue('ack', { store, logger: silent, onDisconnected: 'wait', maxWait: 60_000 });
      await q.ready();
      ctl.down = true;
      let resolved = false;
      const p = q.add(1).then((r) => {
        // Resolving means the record is there.
        expect(inner.dump().jobs.map((j) => j.id)).toContain(r.job.id);
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(5000);
      // The pod "crashes" here: nothing was persisted and nothing was acknowledged.
      expect(resolved).toBe(false);
      expect(inner.dump().jobs).toEqual([]);
      ctl.down = false;
      await vi.advanceTimersByTimeAsync(100);
      await p;
      expect(resolved).toBe(true);
      await q.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
