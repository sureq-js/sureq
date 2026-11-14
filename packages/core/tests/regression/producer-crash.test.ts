import { describe, expect, it } from 'vitest';
import { Producer } from '../../src/producer.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { next, silent } from '../helpers/harness.js';
import { live } from '../helpers/pods.js';

describe('producer crash (regression)', () => {
  it('regression: producer killed right after add resolves does not lose the job', async () => {
    const store = new MemoryStore();
    let p: Producer | undefined = new Producer('crash', { store, logger: silent });
    const { job } = await p.add({ n: 1 });
    // the process dies: the producer object is dropped without close()
    p = undefined;
    const q = new Queue('crash', { store, logger: silent });
    expect((await q.getJob(job.id))!.state).toBe('waiting');
    const done = next<{ job: { id: string } }>(q, 'completed');
    q.process(async () => 'ok', live);
    expect((await done).job.id).toBe(job.id);
    await q.close();
  });
});
