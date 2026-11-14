import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { StoreError } from '../../src/errors/catalog.js';
import type { StoreOp } from '../../src/store/types.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Small seeded PRNG (mulberry32) so a failure reproduces. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('add durability (regression)', () => {
  it('add: every resolved add is present in the store after a simulated crash', async () => {
    const rand = rng(0x5eed);
    const crash = (op: StoreOp, outcomeUnknown: boolean) => {
      if (op === 'add' && rand() < 0.15) throw new StoreError('simulated crash', { operation: 'add', retryable: true, outcomeUnknown });
    };
    // before: nothing written, definite failure. after: write applied, but the caller cannot know.
    const store = new MemoryStore({ faults: { before: (op) => crash(op, false), after: (op) => crash(op, true) } });
    const q = new Queue('durable', { store, logger: silent });
    const scope = q.internals.scope;
    const resolved: string[] = [];
    const ambiguous: string[] = [];
    let definite = 0;
    for (let i = 0; i < 200; i++) {
      try {
        resolved.push((await q.add({ i })).job.id);
      } catch (e) {
        expect(e).toBeInstanceOf(StoreError);
        const err = e as StoreError;
        if (err.outcomeUnknown) ambiguous.push(err.jobIds![0]!);
        else {
          expect(err.jobIds).toBeUndefined();
          definite++;
        }
      }
    }
    expect(resolved.length).toBeGreaterThan(100);
    expect(ambiguous.length).toBeGreaterThan(0);
    expect(definite).toBeGreaterThan(0);
    for (const id of resolved) expect(await stored(store, scope, id), id).toMatchObject({ id, state: 'waiting', attempt: 0, formatVersion: 1 });
    for (const id of ambiguous) {
      const rec = await stored(store, scope, id);
      if (rec) expect(rec).toMatchObject({ id, state: 'waiting', attempt: 0, formatVersion: 1, data: expect.any(String) });
    }
    // Definite failures wrote nothing: the store holds exactly the resolved jobs plus any applied ambiguous ones.
    const present = (await Promise.all(ambiguous.map((id) => stored(store, scope, id)))).filter(Boolean).length;
    expect((await store.counts(scope)).waiting).toBe(resolved.length + present);
  });
});
