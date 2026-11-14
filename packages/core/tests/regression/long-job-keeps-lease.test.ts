import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('long job keeps its lease (regression)', () => {
  it('lease: a job running three lease durations with heartbeats is never swept', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    const q = new Queue('long', { store, logger: silent, leaseDuration: '30s' });
    const scope = q.internals.scope;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const handler = vi.fn(async () => {
      await gate;
      return 'done';
    });
    const completed = vi.fn();
    q.on('completed', completed);
    const { job } = await q.add({});
    const w = q.process(handler, poll(50));
    await vi.advanceTimersByTimeAsync(10);
    const token = (await store.get(scope, job.id))!.token;
    for (let i = 0; i < 90; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      const r = await store.sweep(scope, { limit: 100, maxCrashes: 3, failError: '{}', poisonError: '{}' });
      expect(r.swept).toHaveLength(0);
    }
    expect(await store.get(scope, job.id)).toMatchObject({ state: 'active', token, attempt: 1 });
    open();
    await vi.advanceTimersByTimeAsync(10);
    expect(await q.getJob(job.id)).toMatchObject({ state: 'completed', result: 'done', attempt: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    await w.close();
    await q.close();
  });
});
