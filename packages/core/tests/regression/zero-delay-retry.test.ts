import { afterEach, describe, expect, it } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import type { JobRecord, Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

/** A store that, as the contract allows, keeps a due job `delayed` until a claim moves it. */
class LazyPromoteStore extends MemoryStore {
  override async get(scope: Scope, id: string): Promise<JobRecord | null> {
    const rec = await super.get(scope, id);
    return rec?.state === 'waiting' && rec.attempt > 0 ? { ...rec, state: 'delayed' } : rec;
  }
}

describe('zero-delay retry', () => {
  const queues: Queue[] = [];
  afterEach(async () => {
    await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  });

  it('events: a zero-delay retry reports waiting', async () => {
    let now = 1_000_000;
    const store = new LazyPromoteStore({ clock: () => now });
    const queue = new Queue('z', { store, logger: silent, defaultJobOptions: { backoff: 0 } });
    queues.push(queue);
    let attempts = 0;
    // Store time moves on between the add and the failure, as it does in production.
    const w = queue.process(() => {
      if (++attempts > 1) return 'ok';
      now += 1000;
      return Promise.reject(new TypeError('x'));
    }, poll(5));
    const retrying = new Promise<{ delayMs: number; job: { state: string } }>((r) => w.once('retrying', r as never));
    await queue.add(1, { maxAttempts: 3 });
    const payload = await retrying;
    expect(payload.delayMs).toBe(0);
    expect(payload.job.state).toBe('waiting');
  });
});
