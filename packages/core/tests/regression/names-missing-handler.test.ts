import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import type { ClaimResult } from '../../src/store/contract.js';
import { poll } from '../helpers/poll.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('missing handler (regression)', () => {
  it('names: pod without a handler for X leaves X jobs waiting and does not fail them', async () => {
    const store = new MemoryStore();
    const podA = new Queue('mixed', { store, logger: silent });
    const podB = new Queue('mixed', { store, logger: silent });
    const claim = vi.spyOn(store, 'claim');
    const wb = podB.process({ a: () => 1 }, { ...poll(5) });
    await podA.addBulk([
      ...[1, 2, 3].map((i) => ({ data: i, opts: { name: 'x' } })),
      ...[1, 2].map((i) => ({ data: i, opts: { name: 'a' } })),
    ]);
    let n = 0;
    await new Promise<void>((r) => wb.on('completed', () => void (++n === 2 && r())));
    await new Promise((r) => setTimeout(r, 50)); // several more polls
    const counts = await store.counts(podA.internals.scope);
    expect(counts).toMatchObject({ waiting: 3, completed: 2, failed: 0 });
    const returned = (await Promise.all(claim.mock.results.map((r) => r.value as Promise<ClaimResult>))).flatMap((r) => r.jobs);
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.some((rec) => rec.name === 'x')).toBe(false);
    await Promise.all([podA.close(), podB.close()]);
  });
});
