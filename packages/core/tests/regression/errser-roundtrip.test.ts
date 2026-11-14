import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import { next, silent } from '../helpers/harness.js';

describe('error serialization round trip (regression)', () => {
  it('errser: regression cause and custom fields survive a store round trip', async () => {
    const q = new Queue('errser', { store: new MemoryStore(), logger: silent });
    const w = q.process(() => {
      throw Object.assign(new TypeError('outer', { cause: new RangeError('inner') }), { status: 503 });
    });
    const failed = next(w, 'failed');
    const { job } = await q.add(1, { maxAttempts: 1 });
    await failed;
    const fr = (await q.getJob(job.id))!.failedReason!;
    expect(fr).toMatchObject({ name: 'TypeError', message: 'outer', props: { status: 503 } });
    expect(fr.cause).toMatchObject({ name: 'RangeError', message: 'inner' });
    await q.close();
  });
});
