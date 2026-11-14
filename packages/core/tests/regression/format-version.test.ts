import { describe, expect, it } from 'vitest';
import { MemoryStore, Queue } from '@sureq/core';
import { serializeError } from '../../src/serialize/error.js';
import { silent } from '../helpers/harness.js';
import { claimJobs } from '../helpers/store.js';

/** Small seeded PRNG (mulberry32). */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('stored format (regression)', () => {
  it('fmtver: regression every record carries formatVersion', async () => {
    const rand = rng(0xf0f0);
    const c = { t: 1_000_000 };
    const store = new MemoryStore({ clock: () => c.t });
    const queues = [
      new Queue('a', { store, logger: silent }),
      new Queue('b', { store, logger: silent }),
      new Queue('a', { store, logger: silent, namespace: 'ns2' }),
      new Queue('b', { store, logger: silent, namespace: 'ns2' }),
    ];
    const err = JSON.stringify(serializeError(new TypeError('x'), { maxErrorBytes: 16_384, storeStacks: false }));
    const active: Array<{ q: Queue; id: string; token: number }> = [];
    const known: Array<{ q: Queue; id: string }> = [];
    for (let op = 0; op < 500; op++) {
      const q = queues[Math.floor(rand() * queues.length)]!;
      const scope = q.internals.scope;
      const r = rand();
      if (r < 0.3) known.push({ q, id: (await q.add(op)).job.id });
      else if (r < 0.4) known.push({ q, id: (await q.add(op, { delay: Math.floor(rand() * 50) })).job.id });
      else if (r < 0.6) {
        for (const x of await claimJobs(store, scope, { workerId: 'w', limit: 2 })) active.push({ q, id: x.id, token: x.lease!.token });
      } else if (r < 0.75 && active.length) {
        const a = active.splice(Math.floor(rand() * active.length), 1)[0]!;
        await store.complete(a.q.internals.scope, { id: a.id, token: a.token, result: null });
      } else if (r < 0.9 && active.length) {
        const a = active.splice(Math.floor(rand() * active.length), 1)[0]!;
        await store.fail(a.q.internals.scope, { id: a.id, token: a.token, error: err, retryInMs: Math.floor(rand() * 20) });
      } else if (known.length) {
        const k = known[Math.floor(rand() * known.length)]!;
        await k.q.remove(k.id).catch(() => false); // an active job is refused; that is fine here
      }
      c.t += Math.floor(rand() * 10);
    }
    const snap = store.dump();
    expect(snap.jobs.length).toBeGreaterThan(0);
    for (const rec of snap.jobs) expect(rec.formatVersion, rec.id).toBe(1);
    expect(Object.keys(snap.meta).sort()).toEqual(['default', 'ns2']);
    for (const [ns, meta] of Object.entries(snap.meta)) expect(meta.formatVersion, ns).toBe(1);
  });
});
