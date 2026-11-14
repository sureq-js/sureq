import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import type { JobRecord } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

const queues: Queue[] = [];
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

/** Optional record fields a previous-release pod does not know about. */
const NEW_FIELDS = ['deadLetter', 'retainUntil', 'keep', 'redriveCount', 'lastError', 'attemptsTruncated', 'scheduleKey', 'scheduledFor'] as const;
const newFields = (rec: JobRecord) => Object.fromEntries(NEW_FIELDS.map((k) => [k, rec[k]]));

describe('progress (mixed releases)', () => {
  it('format: previous-release pods keep claiming and completing jobs created by current pods (new optional fields preserved)', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const q = new Queue('mixed', { store, logger: silent, notify: false });
    queues.push(q);
    const errors = vi.fn();
    q.on('error', errors);
    const scope = q.internals.scope;
    // A current pod adds the jobs; one has run once, reported progress and is waiting for its retry.
    const retried = await q.add({ n: 3 }, { maxAttempts: 3, backoff: 60_000 });
    const w = q.process(async (_job, ctx) => {
      await ctx.progress(1, 4, 'earlier attempt');
      throw new TypeError('retry me');
    }, { ...poll(50), random: () => 0.5, sweepInterval: 3_600_000, autorun: false });
    const failed = new Promise((r) => w.once('retrying', r));
    void w.run();
    await vi.advanceTimersByTimeAsync(10);
    await failed;
    await w.close({ timeoutMs: 0 });
    const plain = await q.add({ n: 1 });
    const kept = await q.add({ n: 2 });
    store.unsafeMutate(scope, kept.job.id, { keep: '{"count":5}' });
    expect((await store.get(scope, retried.job.id))!).toMatchObject({ state: 'delayed', attempt: 1, progress: { value: expect.any(String) } });
    const before = new Map<string, Record<string, unknown>>();
    for (const id of [plain.job.id, kept.job.id, retried.job.id]) before.set(id, newFields((await store.get(scope, id))!));

    // The previous-release pod, once the retry is due: the old request shapes only, no hold, started, batchId or other new fields.
    await vi.advanceTimersByTimeAsync(61_000);
    const claimed = await store.claim(scope, { workerId: 'old-pod', limit: 10, leaseMs: 30_000, claimId: 'old-1' });
    expect(claimed.jobs.map((j) => j.id).sort()).toEqual([plain.job.id, kept.job.id, retried.job.id].sort());
    for (const job of claimed.jobs) {
      expect((await store.renew(scope, { id: job.id, token: job.token, leaseMs: 30_000 })).ok).toBe(true);
      expect((await store.complete(scope, { id: job.id, token: job.token, result: '"old"' })).ok).toBe(true);
    }
    for (const id of before.keys()) {
      const rec = (await store.get(scope, id))!;
      expect(rec.state, id).toBe('completed');
      expect(newFields(rec), id).toEqual(before.get(id));
      // a new claim resets progress, whichever release claimed
      expect(rec.progress, id).toBeNull();
      expect((await q.getJob(id))!).toMatchObject({ state: 'completed', result: 'old', progress: null });
    }
    expect((await store.get(scope, kept.job.id))!.keep).toBe('{"count":5}');
    expect(errors).not.toHaveBeenCalled();
  });
});
