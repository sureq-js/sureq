import { describe, expect, it } from 'vitest';
import type { RegisterWorkerRequest } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';

const NS = { namespace: 'n' };
const reg = (over: Record<string, unknown> = {}): RegisterWorkerRequest => ({
  workerId: 'w1', queues: ['q'], concurrency: 1, sureqVersion: '0.3.0', formatVersion: 1, heartbeatIntervalMs: 1000, host: 'h', pid: null,
  labels: {}, scheduler: false, ...over,
}) as RegisterWorkerRequest;

describe('memstore worker registry', () => {
  it('memstore: worker records are copies in and out', async () => {
    const store = new MemoryStore({ clock: () => 1000 });
    await store.open();
    const req = reg({ labels: { a: '1' } });
    await store.registerWorker(NS, req);
    req.labels['a'] = 'changed';
    const [rec] = (await store.listWorkers(NS, {})).workers;
    rec!.labels['a'] = 'mutated';
    expect((await store.listWorkers(NS, {})).workers[0]!.labels).toEqual({ a: '1' });
  });

  it('memstore: bad worker registry requests are refused before any write', async () => {
    const store = new MemoryStore({ clock: () => 1000 });
    await store.open();
    const bad = [
      store.registerWorker(NS, reg({ queues: [''] })),
      store.registerWorker(NS, reg({ names: 'a' })),
      store.registerWorker(NS, reg({ concurrency: 0 })),
      store.registerWorker(NS, reg({ sureqVersion: '' })),
      store.registerWorker(NS, reg({ host: 1 })),
      store.registerWorker(NS, reg({ labels: { a: 1 } })),
      store.registerWorker(NS, reg({ scheduler: 'yes' })),
      store.registerWorker({ namespace: '' }, reg()),
      store.heartbeatWorker(NS, { workerId: 'w1', activeJobs: -1, concurrency: 1, status: 'running', scheduler: false }),
      store.heartbeatWorker(NS, { workerId: 'w1', activeJobs: 0, concurrency: 1, status: 'gone' as never, scheduler: false }),
      store.unregisterWorker(NS, { workerId: '' }),
      store.listWorkers(NS, { queue: '' }),
      store.purgeWorkers(NS, { staleIntervals: -1, limit: 1 }),
      store.purgeWorkers(NS, { staleIntervals: 1.5, limit: 1 }),
      store.purgeWorkers(NS, { staleForMs: 1000, limit: 1 } as never),
      store.purgeWorkers(NS, { staleIntervals: 0, limit: 0 }),
    ];
    for (const p of bad) await expect(p).rejects.toMatchObject({ code: 'STORE_BAD_REQUEST' });
    expect((await store.listWorkers(NS, {})).workers).toEqual([]);
  });
});
