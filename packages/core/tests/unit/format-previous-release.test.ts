import { hostname } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { live, twoPods } from '../helpers/pods.js';

describe('format (previous release)', () => {
  it('format: a previous-release pod and the current pod share a store; the current pod closes jobs the previous one claimed without error (attempt row upserted)', async () => {
    const w = twoPods({ name: 'prev' });
    try {
      const errors = vi.fn();
      w.a.on('error', errors);
      const { job: a } = await w.a.add({ n: 'a' });
      const { job: b } = await w.a.add({ n: 'b' });
      // The previous pod speaks the store protocol directly, with its own request shapes: it writes no attempt rows.
      const { jobs } = await w.store.claim(w.scope, { workerId: 'previous', limit: 2, leaseMs: 30_000, claimId: 'p1', history: false });
      expect(jobs.map((j) => j.id)).toEqual([a.id, b.id]);
      const token = Object.fromEntries(jobs.map((j) => [j.id, j.token]));
      expect((await w.a.getAttempts(a.id)).attempts).toEqual([]);
      // ...and dies. The current pod cancels B while active, and its sweeper sweeps A once the lease ran out.
      expect(await w.a.cancel(b.id)).toMatchObject({ cancelled: true, previousState: 'active' });
      w.clock.t += 30_001;
      const worker = w.a.process(() => 'done', live);
      await vi.advanceTimersByTimeAsync(700);
      expect(await w.a.getJob(a.id)).toMatchObject({ state: 'completed', attempt: 2 });
      const rowsA = (await w.a.getAttempts(a.id)).attempts;
      expect(rowsA.map((r) => [r.token, r.outcome, r.endedBy, r.host, r.workerId])).toEqual([
        [token[a.id], 'crashed', 'sweeper', null, 'previous'],
        [expect.any(Number), 'completed', 'worker', hostname(), worker.id],
      ]);
      expect(rowsA[1]!.token).toBeGreaterThan(token[a.id]!);
      const rowsB = (await w.a.getAttempts(b.id)).attempts;
      expect(rowsB.map((r) => [r.token, r.outcome, r.endedBy, r.host])).toEqual([[token[b.id], 'cancelled', 'cancel', null]]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.teardown();
    }
  });
});
