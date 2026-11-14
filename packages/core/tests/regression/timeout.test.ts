import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { JobContext } from '../../src/worker/context.js';
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

describe('timeouts (regression)', () => {
  it('regression: timeout aborts the signal and only fails the job after the grace; abandoned work cannot commit', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    q = new Queue('t', { store, logger: silent });
    const events = vi.fn();
    for (const e of ['completed', 'failed', 'retrying'] as const) q.on(e, events);
    const { job } = await q.add(1, { maxAttempts: 1 });
    let ctx!: JobContext;
    let finish!: (v: string) => void;
    let startedAt = 0;
    q.process((_job, c) => {
      ctx = c;
      startedAt = Date.now();
      return new Promise<string>((r) => (finish = r));
    }, { ...poll(50), timeout: 1000, timeoutGrace: 2000, sweepInterval: 3_600_000 });
    await vi.advanceTimersByTimeAsync(0);
    const rec = async () => (await stored(store, q!.internals.scope, job.id))!;

    await vi.advanceTimersByTimeAsync(startedAt + 1000 - Date.now());
    expect(ctx.signal.aborted).toBe(true);
    expect((await rec()).state).toBe('active');

    await vi.advanceTimersByTimeAsync(startedAt + 3000 - Date.now());
    const failed = await rec();
    expect(failed).toMatchObject({ state: 'failed', result: null, error: { code: 'JOB_TIMEOUT', props: { abandoned: true } } });
    expect(events).toHaveBeenCalledOnce();

    finish('late');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await rec()).toEqual(failed);
    expect(events).toHaveBeenCalledOnce();
  });
});
