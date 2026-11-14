import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { stored } from '../helpers/store.js';

let q: Queue | undefined;
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await q?.close({ timeoutMs: 100 });
});

describe('abandoned handler frees its slot (regression)', () => {
  it('regression: a handler that ignores the abort signal is failed after the grace and its slot is freed', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    q = new Queue('t', { store, logger: silent });
    const first = await q.add('stuck', { maxAttempts: 1 });
    let finish!: (v: string) => void;
    const starts: Array<{ data: unknown; at: number }> = [];
    const worker = q.process((job) => {
      starts.push({ data: job.data, at: Date.now() });
      return job.data === 'stuck' ? new Promise<string>((r) => (finish = r)) : 'ok';
    }, { ...poll(50), concurrency: 1, timeout: 1000, timeoutGrace: 500, sweepInterval: 3_600_000 });
    await vi.advanceTimersByTimeAsync(0);
    const t0 = starts[0]!.at;
    const rec = async (id: string) => (await stored(store, q!.internals.scope, id))!;

    await vi.advanceTimersByTimeAsync(t0 + 1500 - Date.now());
    const failed = await rec(first.job.id);
    expect(failed).toMatchObject({ state: 'failed', error: { name: 'JobTimeoutError', props: { abandoned: true } } });
    expect(worker.inFlight).toBe(0);

    const second = await q.add('next', { maxAttempts: 1 });
    const addedAt = Date.now();
    await vi.advanceTimersByTimeAsync(1);
    expect(starts.map((s) => s.data)).toEqual(['stuck', 'next']);
    expect(starts[1]!.at - addedAt).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(10);
    expect((await rec(second.job.id)).state).toBe('completed');

    finish('late');
    await vi.advanceTimersByTimeAsync(100);
    expect(await rec(first.job.id)).toEqual(failed);
  });
});
