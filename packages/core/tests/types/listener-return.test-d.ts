import { test } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { Producer } from '../../src/producer.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';

// Listeners may return anything (the value is ignored), like Node's EventEmitter. Before, the
// `void | Promise<void>` return type rejected arrows such as `({ job }) => ids.push(job.id)` (TS2322).
test('events: a listener may return any value', () => {
  const q = new Queue<{ n: number }>('q');
  const p = new Producer<{ n: number }>('q', { store: new MemoryStore() });
  const ids: string[] = [];
  const seen = new Set<string>();
  const byId = new Map<string, number>();
  q.on('completed', ({ job }) => ids.push(job.id));
  q.on('completed', ({ job }) => seen.add(job.id));
  q.once('failed', ({ job }) => byId.set(job.id, 1));
  q.on('completed', async ({ job }) => { ids.push(job.id); });
  const fn = ({ job }: { job: { id: string } }) => ids.push(job.id);
  q.on('added', fn);
  q.off('added', fn);
  p.on('added', ({ job }) => ids.push(job.id));
  const w = q.process(async () => {});
  w.on('completed', ({ job }) => ids.push(job.id));
  w.once('failed', ({ job }) => seen.add(job.id));
});
