import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { StoreError } from '../../src/errors/catalog.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('huge result (regression)', () => {
  it('resultsize: huge result with a size-limited fault store ends failed with ResultTooLargeError, never stuck active', async () => {
    const store = new MemoryStore();
    // A store that cannot hold big records: an oversized complete would leave the job active.
    const realComplete = store.complete.bind(store);
    store.complete = async (scope, req) => {
      if ((req.result?.length ?? 0) > 1000) throw new StoreError('record too large', { operation: 'complete', retryable: false, outcomeUnknown: false });
      return realComplete(scope, req);
    };
    const q = new Queue('huge', { store, logger: silent, maxResultBytes: 1000 });
    const w = q.process(() => 'r'.repeat(5 * 1024));
    const failed = new Promise<void>((r) => w.once('failed', () => r()));
    const { job } = await q.add(1);
    await failed;
    const rec = (await stored(store, q.internals.scope, job.id))!;
    expect(rec.state).toBe('failed');
    expect(rec.error).toMatchObject({ name: 'ResultTooLargeError' });
    await q.close();
  });
});
