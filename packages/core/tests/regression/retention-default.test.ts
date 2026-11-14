import { describe, expect, it } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { runRetentionPass } from '../../src/retention/cleaner.js';
import { finishExt } from '../../src/retention/policy.js';
import type { JobRecord } from '../../src/store/contract.js';
import { harness } from '../helpers/harness.js';

const DAY = 86_400_000;
const pass = async (q: Queue): Promise<number> => (await runRetentionPass({ client: q.internals.client, scope: q.internals.scope, retention: q.internals.retention })).removed;

/**
 * Finish `n` new jobs the way a worker of `q` does: one claim, then each job's complete or fail carries the queue's
 * resolved retention for its outcome (a fail as a dead letter when the queue keeps them).
 */
async function finish(h: ReturnType<typeof harness>, n: number, outcome: 'completed' | 'failed'): Promise<string[]> {
  const q = h.queue;
  const { scope, retention, deadLetter } = q.internals;
  await q.addBulk(Array.from({ length: n }, (_, i) => ({ data: i, opts: { maxAttempts: 1 } })));
  const { jobs } = await h.raw.claim(scope, { workerId: 'w', limit: n, leaseMs: 60_000, claimId: `c${h.clock.now}-${n}` });
  for (const j of jobs as JobRecord[]) {
    if (outcome === 'completed') await h.raw.complete(scope, { id: j.id, token: j.token, result: null, ...finishExt(retention, j, 'completed') });
    else {
      const ext = deadLetter.enabled ? { deadLetter: {} } : { deadLetter: false as const, ...finishExt(retention, j, 'failed') };
      await h.raw.fail(scope, { id: j.id, token: j.token, error: '{"v":1,"name":"E","message":"boom"}', ...ext });
    }
  }
  return jobs.map((j) => j.id);
}

describe('regression: default retention', () => {
  it('regression: finished jobs beyond the default retention are removed and do not pile up', async () => {
    const h = harness();
    await h.queue.ready();
    for (let i = 0; i < 2; i++) await finish(h, 500, 'completed');
    await finish(h, 1, 'completed');
    const [dead] = await finish(h, 1, 'failed');
    h.clock.advance(30_000);
    await pass(h.queue);
    expect((await h.queue.getCounts()).completed).toBe(1000);
    const plain = harness({ queue: { deadLetter: false } });
    await plain.queue.ready();
    const [failed] = await finish(plain, 1, 'failed');
    plain.clock.advance(14 * DAY);
    await pass(plain.queue);
    expect(await plain.queue.getJob(failed!)).toBeNull();
    h.clock.advance(14 * DAY);
    await pass(h.queue);
    expect(await h.queue.getJob(dead!)).not.toBeNull();
    await Promise.all([h.queue.close(), plain.queue.close()]);
  });

  it('regression: finished jobs are kept per the default policy and removed only by a stated rule', async () => {
    const h = harness();
    await h.queue.ready();
    const done = [...(await finish(h, 500, 'completed')), ...(await finish(h, 505, 'completed'))];
    const [dead] = await finish(h, 1, 'failed');
    const { job: cancelled } = await h.queue.add('c');
    await h.queue.cancel(cancelled.id);
    h.clock.advance(30_000);
    await pass(h.queue);
    const left = new Set((await h.queue.getJobs('completed', { limit: 1000 })).map((j) => j.id));
    // the newest 1000 by finishedAt then seq: the first five finished went
    expect(left).toEqual(new Set(done.slice(5)));
    expect(await h.queue.getJob(cancelled.id)).not.toBeNull();
    h.clock.advance(14 * DAY);
    await pass(h.queue);
    expect(await h.queue.getJob(cancelled.id)).toBeNull();
    h.clock.advance(365 * DAY);
    await pass(h.queue);
    expect((await h.queue.getJob(dead!))?.deadLetter?.reason).toBe('exhausted');
    await h.queue.close();
  });
});
