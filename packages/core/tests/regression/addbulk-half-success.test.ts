import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('addBulk half success (regression)', () => {
  it('bulk: half-success is reported per input and caller can tell which jobs were added', async () => {
    const store = new MemoryStore();
    const q = new Queue('half', { store, logger: silent });
    const scope = q.internals.scope;
    const bad = new Set([1, 4, 8]);
    const outcomes = await q.addBulk(Array.from({ length: 10 }, (_, i) => ({ data: i, ...(bad.has(i) && { opts: { maxAttempts: 0 } }) })));
    expect(outcomes.map((o) => o.ok)).toEqual(Array.from({ length: 10 }, (_, i) => !bad.has(i)));
    const addedIds = outcomes.flatMap((o) => (o.ok ? [o.job.id] : []));
    for (const id of addedIds) expect(await stored(store, scope, id)).toBeDefined();
    // Failed slots carry no id, and nothing beyond the added jobs exists in the store.
    expect(store.dump().jobs.map((r) => r.id).sort()).toEqual([...addedIds].sort());
    for (const [i, o] of outcomes.entries()) if (!o.ok) expect(o, String(i)).not.toHaveProperty('job');
  });
});
