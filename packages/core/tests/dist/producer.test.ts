// The producer entry end to end: a Producer from '@sureq/core/producer' adds, a Queue from '@sureq/core' runs it.
import { describe, expect, it } from 'vitest';
import { MemoryStore, Queue } from '@sureq/core';
import { Producer, QueueClosedError } from '@sureq/core/producer';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('producer entry', { timeout: 30_000 }, () => {
  it('pkg: a job added from the producer entry is run by a queue from the main entry', async () => {
    const store = new MemoryStore();
    const p = new Producer('pe', { store, logger: silent });
    const q = new Queue('pe', { store, logger: silent });
    const done = new Promise<{ job: { id: string }; result: unknown }>((r) => q.once('completed', r));
    const { job } = await p.add({ n: 3 });
    q.process(async (j) => (j.data as { n: number }).n + 1);
    expect(await done).toMatchObject({ job: { id: job.id }, result: 4 });
    await p.close();
    await expect(p.add(1)).rejects.toBeInstanceOf(QueueClosedError);
    await q.close();
  });
});
