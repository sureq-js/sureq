import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs, stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { addVia } from '../helpers/add-via.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const pods = (aDefaults: object, bDefaults: object) => {
  const store = new MemoryStore();
  const a = new Queue('jobs', { store, logger: silent, defaultJobOptions: aDefaults });
  const b = new Queue('jobs', { store, logger: silent, defaultJobOptions: bDefaults });
  return { store, a, b, scope: a.internals.scope };
};

describe('defaults (snapshot onto the job)', () => {
  it('defaults: effective values are snapshotted on the stored job', async () => {
    const { store, a, scope } = pods({ maxAttempts: 5, backoff: { type: 'fixed', delay: 1000 }, priority: 5 }, {});
    const id = await addVia(a, { x: 1 });
    expect(await stored(store, scope, id)).toMatchObject({ maxAttempts: 5, priority: 5, backoff: { type: 'fixed', delay: 1000 } });
  });

  it("defaults: pod with different defaults runs the job with the producer's values", async () => {
    const { store, a, b, scope } = pods({ maxAttempts: 5 }, { maxAttempts: 2 });
    const fromA = await addVia(a, {});
    expect((await stored(store, scope, fromA))!.maxAttempts).toBe(5);
    const fromB = await addVia(b, {});
    expect((await stored(store, scope, fromB))!.maxAttempts).toBe(2);
  });

  it("defaults: backoff default is snapshotted, so a worker pod with a different queue default uses the job's backoff", async () => {
    const { store, a, scope } = pods({ backoff: { type: 'fixed', delay: 250 } }, { backoff: { type: 'fixed', delay: 9999 } });
    const id = await addVia(a, {});
    const [claimed] = await claimJobs(store, scope, { workerId: 'pod-b', limit: 1, order: 'fifo' });
    expect(claimed!.id).toBe(id);
    expect(JSON.parse(claimed!.backoff as string)).toEqual({ type: 'fixed', delay: 250, jitter: 'none' }); // stored normalised
  });

  it('defaults: changing defaults does not affect existing jobs', async () => {
    const store = new MemoryStore();
    const first = new Queue('jobs', { store, logger: silent, defaultJobOptions: { priority: 3 } });
    const id = await addVia(first, {});
    new Queue('jobs', { store, logger: silent, defaultJobOptions: { priority: 8 } });
    expect((await stored(store, first.internals.scope, id))!.priority).toBe(3);
  });
});
