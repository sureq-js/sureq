import { describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '../../src/events/types.js';
import { Queue } from '../../src/queue/queue.js';
import type { ClaimRequest, Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

describe('claim failure slot (regression)', () => {
  it('regression: throwing handler and failing claim both free their slot', async () => {
    const inner = new MemoryStore();
    let first = true;
    const { store } = spyStore(inner, {
      claim: (s: Scope, r: ClaimRequest) => (first ? ((first = false), Promise.reject('x')) : inner.claim(s, r)),
    });
    const q = new Queue('slot', { store, logger: silent });
    const ids = (await q.addBulk([1, 2, 3].map((n) => ({ data: n, opts: { maxAttempts: 1 } })))).map((o) => (o as { job: { id: string } }).job.id);
    const errors: ErrorEvent[] = [];
    const failed = vi.fn();
    const w = q.process((job) => {
      if (job.data === 1) throw new TypeError('handler');
    }, { concurrency: 1, ...poll(5) });
    w.on('error', (e) => void errors.push(e));
    w.on('failed', failed);
    await vi.waitFor(async () => expect((await q.getCounts()).completed).toBe(2));
    await vi.waitFor(() => expect(w.inFlight).toBe(0));
    expect(errors.map((e) => [e.source, e.context.operation])).toEqual([['store', 'claim']]);
    expect(failed).toHaveBeenCalledOnce();
    const states = await Promise.all(ids.map(async (id) => (await q.getJob(id))!.state));
    expect(states).toEqual(['failed', 'completed', 'completed']);
    await w.close();
    await q.close();
  });
});
