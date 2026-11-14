import { describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import type { CompleteResult, Payload, Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const sweepReq = { limit: 100, maxCrashes: 3, failError: '{"v":1,"name":"E","message":"f"}', poisonError: '{"v":1,"name":"E","message":"p"}' };

describe('store clock jump (regression)', () => {
  it('regression: a forward jump of the store clock requeues active jobs and fences the stale workers', async () => {
    const clock = { t: 1_700_000_000_000 };
    const inner = new MemoryStore({ clock: () => clock.t });
    const results: CompleteResult[] = [];
    const { store: storeA } = spyStore(inner, {
      complete: async (s: Scope, r: { id: string; token: number; result: Payload | null }) => {
        const res = await inner.complete(s, r);
        results.push(res);
        return res;
      },
    });
    const qa = new Queue('jump', { store: storeA, logger: silent });
    const qb = new Queue('jump', { store: inner, logger: silent });
    const completed = vi.fn();
    qa.on('completed', completed);
    qb.on('completed', completed);
    let openA!: () => void;
    const gateA = new Promise<void>((r) => (openA = r));
    const wa = qa.process(async () => (await gateA, 'from A'), poll(5));
    const { job } = await qa.add(1);
    await vi.waitFor(() => expect(wa.inFlight).toBe(1));

    // Jump past the lease the claim took, read from the stored record.
    const rec = (await inner.get(qa.internals.scope, job.id))!;
    const lease = rec.lease!.expiresAt - rec.startedAt!;
    clock.t += lease + 1;
    expect((await inner.sweep(qa.internals.scope, sweepReq)).swept.map((s) => s.action)).toEqual(['requeued']);
    const wb = qb.process(() => 'from B', poll(5));
    await vi.waitFor(async () => expect((await qb.getJob(job.id))!.state).toBe('completed'));

    openA();
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(wa.inFlight).toBe(0));
    expect(completed).toHaveBeenCalledOnce();
    expect(await qb.getJob(job.id)).toMatchObject({ result: 'from B', attempt: 2 });

    // Stepping the store clock back again neither re-runs anything nor stops new work.
    clock.t -= lease + 1;
    await wa.close();
    const ran = vi.fn(() => 'later');
    await wb.close();
    const wc = qb.process(ran, poll(5));
    const { job: later } = await qb.add(2);
    await vi.waitFor(async () => expect((await qb.getJob(later.id))!.state).toBe('completed'));
    expect(ran).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledTimes(2);
    await wc.close();
    await Promise.all([qa.close(), qb.close()]);
  });
});
