import { describe, expect, it, vi } from 'vitest';
import { StoreUnavailableError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import type { ClaimRequest, Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

describe('lost claim response (regression)', () => {
  it('regression: a lost claim response neither loses the job nor spends an attempt', async () => {
    const inner = new MemoryStore();
    let lose = true;
    const { store } = spyStore(inner, {
      claim: async (s: Scope, r: ClaimRequest) => {
        const res = await inner.claim(s, r);
        if (lose && res.jobs.length > 0) {
          lose = false;
          throw new StoreUnavailableError('response lost', { operation: 'claim', retryable: true, outcomeUnknown: true });
        }
        return res;
      },
    });
    const q = new Queue('lost', { store, logger: silent });
    const runs = vi.fn();
    const w = q.process(runs, poll(5));
    const { job } = await q.add(1);
    await vi.waitFor(async () => expect((await q.getJob(job.id))!.state).toBe('completed'));
    expect(await q.getJob(job.id)).toMatchObject({ attempt: 1, crashCount: 0 });
    expect(runs).toHaveBeenCalledOnce();
    await w.close();
    await q.close();
  });
});
