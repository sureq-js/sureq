import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { addVia } from '../helpers/add-via.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('priority (through the queue)', () => {
  it('priority: first and priority combine', async () => {
    const store = new MemoryStore();
    const q = new Queue('prio', { store, logger: silent });
    const label: Record<string, string> = {};
    label[await addVia(q, 'p9', { priority: 9 })] = 'p9';
    label[await addVia(q, 'p5', { priority: 5 })] = 'p5';
    label[await addVia(q, 'p5-first', { priority: 5, first: true })] = 'p5-first';
    const claimed = await claimJobs(store, q.internals.scope, { workerId: 'w', limit: 3, order: 'fifo' });
    expect(claimed.map((r) => label[r.id])).toEqual(['p9', 'p5-first', 'p5']);
  });

  it('priority: high priority does not interrupt active job', async () => {
    const q = new Queue('prio', { store: new MemoryStore(), logger: silent });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const events: string[] = [];
    const w = q.process(async (job) => {
      events.push(`start ${String(job.data)}`);
      if (job.data === 'low') await gate;
      events.push(`end ${String(job.data)}`);
    });
    const lowActive = new Promise<void>((r) => w.once('active', () => r()));
    await q.add('low', { priority: 0 });
    await lowActive;
    await q.add('high', { priority: 100 });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(['start low']);
    const both = new Promise<void>((r) => w.on('completed', ({ job }) => void (job.data === 'high' && r())));
    release();
    await both;
    expect(events).toEqual(['start low', 'end low', 'start high', 'end high']);
    await q.close();
  });
});
