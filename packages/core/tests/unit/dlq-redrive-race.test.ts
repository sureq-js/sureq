import { describe, expect, it, vi } from 'vitest';
import type { QueueEvents } from '../../src/events/types.js';
import { Queue } from '../../src/queue/queue.js';
import type { RedriveOutcome } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { collect, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { rng } from '../helpers/pods.js';

/** Add `n` jobs with one attempt each and let a throwing worker dead-letter them all; returns the ids in add order. */
async function deadLetterAll(q: Queue, n: number): Promise<string[]> {
  const ids = (await q.addBulk(Array.from({ length: n }, (_, i) => ({ data: i, opts: { maxAttempts: 1 } })))).map((r) => (r.ok ? r.job.id : ''));
  const w = q.process(() => Promise.reject(new TypeError('boom')), { ...poll(1), concurrency: 100 });
  await collect(w, 'deadLettered', n);
  await w.close();
  return ids;
}

describe('dead-letter redrive (concurrency)', () => {
  it('dlq: concurrent redrives move each dead letter once', async () => {
    const store = new MemoryStore();
    const [a, b, c] = ['A', 'B', 'C'].map(() => new Queue('race', { store, logger: silent, maxBulkSize: 2000 })) as [Queue, Queue, Queue];
    const ids = await deadLetterAll(a, 2000);
    expect(await a.countDeadLetters()).toBe(2000);
    const seq = new Map<string, number>();
    for (const id of ids) seq.set(id, (await a.getJob(id))!.seq);
    const redriven: Array<QueueEvents['redriven']> = [];
    for (const q of [a, b, c]) q.on('redriven', (e) => void redriven.push(e));
    const ran: string[] = [];
    const worker = a.process((job) => void ran.push(job.id), { ...poll(5), concurrency: 8 });
    const random = rng(7);
    const some = Array.from({ length: 300 }, () => ids[Math.floor(random() * ids.length)]!);
    const [sa, sb, sc, byId] = await Promise.all([
      a.redriveAll({}, { pageSize: 50 }), b.redriveAll({}, { pageSize: 50 }), c.redriveAll({}, { pageSize: 50 }), b.redrive(some),
    ]);
    const viaIds = (byId as RedriveOutcome[]).filter((o) => o.status === 'redriven').length;
    expect(sa.redriven + sb.redriven + sc.redriven + viaIds).toBe(2000);
    expect([sa.done, sb.done, sc.done]).toEqual([true, true, true]);
    await vi.waitFor(async () => expect((await a.getCounts()).completed).toBe(2000), { timeout: 20_000, interval: 20 });
    expect(redriven.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(ran.sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const job = (await a.getJob(id))!;
      expect([job.redriveCount, job.seq]).toEqual([1, seq.get(id)]);
    }
    expect(await a.countDeadLetters()).toBe(0);
    await worker.close();

    // without workers: two parallel redrives of 200 more, then one claim takes them in their original order
    const more = await deadLetterAll(b, 200);
    const [r1, r2] = await Promise.all([a.redriveAll(), c.redriveAll()]);
    expect(r1.redriven + r2.redriven).toBe(200);
    const { jobs } = await store.claim(a.internals.scope, { workerId: 'w', limit: 200, leaseMs: 60_000, claimId: 'all' });
    expect(jobs.map((j) => j.id)).toEqual(more);
    await Promise.all([a, b, c].map((q) => q.close()));
  }, 30_000);
});
