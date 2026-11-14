import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { clientFor } from '../../src/store/client.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { outageStore } from '../helpers/outage.js';
import { spyStore } from '../helpers/spy-store.js';

afterEach(() => vi.useRealTimers());

describe('liveness', () => {
  it('regression: a pod with a dead claim loop reports live false so the platform restarts it', async () => {
    useFakeTime();
    const inner = new MemoryStore({ clock: () => Date.now() });
    // The worker "dead" sends a claim that never answers while the store stays connected: its loop is wedged.
    const stuck = spyStore(inner, { claim: (scope, req) => (req.workerId === 'dead' ? new Promise(() => {}) : inner.claim(scope, req)) }).store;
    const { store, ctl } = outageStore(stuck);
    clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
    const q = new Queue('pod', { store, logger: silent });
    const opts = { random: () => 0.5, sweepInterval: 3_600_000 };
    q.process(() => 'ok', { ...opts, workerId: 'dead' });
    q.process(() => 'ok', opts);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await q.health()).toMatchObject({ live: false, status: 'down', store: { ok: true } });

    // A store outage alone never fails liveness, however long it lasts.
    const other = new Queue('pod2', { store, logger: silent });
    other.process(() => 'ok', opts);
    await vi.advanceTimersByTimeAsync(100);
    ctl.down = true;
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await other.health()).live).toBe(true);
    }
    ctl.down = false;
    const closing = Promise.all([q.close({ timeoutMs: 0 }), other.close({ timeoutMs: 0 })]);
    await vi.advanceTimersByTimeAsync(10_000);
    await closing;
  });
});
