import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseLostError, StoreNotReadyError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import { Queue } from '../../src/queue/queue.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { clientFor } from '../../src/store/client.js';
import type { ClaimRequest, CompleteResult, Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { withLostResponses } from '../helpers/lost-response.js';
import { outageStore } from '../helpers/outage.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

/** No jitter anywhere, and no sweep unless a test asks for one. */
const steady = { ...poll(50), random: () => 0.5, sweepInterval: 3_600_000 };

/** A queue on `store` (wrapped by `wrap`), probing every 100 ms while it is down. */
function world(o: { wrap?: (inner: MemoryStore) => Store; queue?: QueueOptions } = {}) {
  useFakeTime();
  const inner = new MemoryStore({ clock: () => Date.now() });
  const { store, ctl } = outageStore(o.wrap?.(inner) ?? inner);
  clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
  const q = new Queue('w', { store, logger: silent, ...o.queue });
  queues.push(q);
  const events = { completed: vi.fn(), failed: vi.fn(), retrying: vi.fn(), leaseLost: vi.fn(), error: vi.fn<(e: ErrorEvent) => void>() };
  for (const [k, fn] of Object.entries(events)) q.on(k as 'failed', fn as () => void);
  const ops = (op: string, from = -Infinity) => ctl.calls.filter((c) => c.op === op && c.at >= from);
  return { inner, store, ctl, q, events, ops, scope: q.internals.scope };
}

describe('reconnect: the worker during an outage', () => {
  it('reconnect: claiming pauses during outage and resumes after', async () => {
    const w = world();
    w.q.process(() => 'ok', steady);
    await vi.advanceTimersByTimeAsync(100);
    w.ctl.down = true;
    await vi.advanceTimersByTimeAsync(100); // the next claim fails: the outage is known
    expect(w.q.connectionState).toBe('reconnecting');
    const from = performance.now();
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.ops('claim', from)).toEqual([]);
    expect(w.ops('now', from).length).toBeGreaterThanOrEqual(19);
    const { job } = await w.inner.add(w.scope, [{ id: 'j1', data: '1', formatVersion: 1, maxAttempts: 3 }]).then(([o]) => o as { job: { id: string } });
    w.ctl.down = false;
    await vi.advanceTimersByTimeAsync(300);
    expect((await w.inner.get(w.scope, job.id))!.state).toBe('completed');
    expect(w.events.error).toHaveBeenCalledOnce();
  });

  it('reconnect: outage shorter than the lease does not abort running handlers', async () => {
    const w = world({ queue: { leaseDuration: '5s' } });
    let aborted = false;
    w.q.process(async (_job, ctx) => {
      ctx.signal.addEventListener('abort', () => (aborted = true));
      await new Promise((r) => setTimeout(r, 3000));
      return 'done';
    }, steady);
    const { job } = await w.q.add(1);
    await vi.advanceTimersByTimeAsync(500);
    w.ctl.down = true;
    await vi.advanceTimersByTimeAsync(2000);
    w.ctl.down = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(aborted).toBe(false);
    expect(w.events.leaseLost).not.toHaveBeenCalled();
    expect(w.events.completed).toHaveBeenCalledOnce();
    expect((await w.inner.get(w.scope, job.id))!.state).toBe('completed');
  });

  it('reconnect: outage longer than the lease aborts locally with LeaseLostError', async () => {
    const w = world({ queue: { leaseDuration: '2s' } });
    let reason: unknown;
    w.q.process((_job, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve((reason = ctx.signal.reason)))), steady);
    await w.q.add(1);
    await vi.advanceTimersByTimeAsync(100);
    w.ctl.down = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(reason).toBeInstanceOf(LeaseLostError);
    expect(w.events.leaseLost).toHaveBeenCalledOnce();
    expect(w.events.completed).not.toHaveBeenCalled();
  });

  it('reconnect: claim with unknown outcome is repeated with the same claimId and burns no attempt', async () => {
    let spy!: ReturnType<typeof spyStore>;
    const w = world({ wrap: (inner) => (spy = spyStore(withLostResponses(inner, 'claim', 1))).store });
    const { job } = await w.q.add(1);
    const runs = vi.fn();
    w.q.process(runs, steady);
    await vi.advanceTimersByTimeAsync(300);
    const claims = spy.calls.filter((c) => c.op === 'claim').map((c) => (c.args[1] as ClaimRequest).claimId);
    expect(claims[1]).toBe(claims[0]);
    expect(runs).toHaveBeenCalledOnce();
    expect(await w.inner.get(w.scope, job.id)).toMatchObject({ state: 'completed', attempt: 1, crashCount: 0 });
  });

  it('reconnect: renew with unknown outcome is retried until the local lease deadline', async () => {
    let spy!: ReturnType<typeof spyStore>;
    const w = world({ wrap: (inner) => (spy = spyStore(withLostResponses(inner, 'renew', 2))).store, queue: { leaseDuration: '3s' } });
    const { job } = await w.q.add(1);
    w.q.process(() => new Promise((r) => setTimeout(() => r('ok'), 5000)), steady);
    await vi.advanceTimersByTimeAsync(5200);
    const renews = spy.calls.filter((c) => c.op === 'renew').map((c) => c.at);
    // Two renews lost at about 1 s and 1.5 s, the retry lands before the 3 s deadline.
    expect(renews.length).toBeGreaterThanOrEqual(3);
    expect(renews[2]! - renews[0]!).toBeLessThan(3000);
    expect(w.events.leaseLost).not.toHaveBeenCalled();
    expect(w.events.completed).toHaveBeenCalledOnce();
    expect((await w.inner.get(w.scope, job.id))!.state).toBe('completed');
  });

  it('reconnect: complete during outage is retried within the lease and applied after reconnect, exactly once', async () => {
    const answers: CompleteResult[] = [];
    let applied = 0;
    const w = world({
      wrap: (inner) =>
        withLostResponses(
          spyStore(inner, {
            complete: async (s: Scope, r: Parameters<Store['complete']>[1]) => {
              const res = await inner.complete(s, r);
              answers.push(res);
              if (res.ok && !res.repeated) applied++;
              return res;
            },
          }).store,
          'complete',
          2,
        ),
    });
    const { job } = await w.q.add(1);
    w.q.process(() => 'result', steady);
    await vi.advanceTimersByTimeAsync(1000);
    expect(applied).toBe(1);
    expect(answers.map((a) => a.ok && (a.repeated ?? false))).toEqual([false, true, true]);
    expect(w.events.completed).toHaveBeenCalledOnce();
    expect(w.events.completed.mock.calls[0]![0]).toMatchObject({ result: 'result' });
    expect(await w.inner.get(w.scope, job.id)).toMatchObject({ state: 'completed', attempt: 1 });
    expect(w.events.error).not.toHaveBeenCalled();
  });

  it('reconnect: complete retried past the lease deadline reports unconfirmed without failing the job', async () => {
    const w = world({ queue: { leaseDuration: '1s' } });
    w.ctl.failing = (op) => w.ctl.down || op === 'complete';
    const { job } = await w.q.add(1);
    const worker = w.q.process(() => 'never stored', steady);
    const t0 = performance.now();
    await vi.advanceTimersByTimeAsync(990);
    expect(w.events.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(w.events.error).toHaveBeenCalledOnce();
    const e = w.events.error.mock.calls[0]![0];
    expect(e).toMatchObject({ source: 'store', context: { jobId: job.id, operation: 'complete' } });
    expect(e.error.message).toBe(`outcome of 'complete' for job '${job.id}' is unconfirmed`);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1000);
    for (const k of ['failed', 'retrying', 'completed', 'leaseLost'] as const) expect(w.events[k]).not.toHaveBeenCalled();
    expect(w.ops('fail')).toEqual([]);
    expect(worker.inFlight).toBe(0);
    expect(await w.inner.get(w.scope, job.id)).toMatchObject({ state: 'active', crashCount: 0 });
  });

  it('reconnect: a close that times out during an outage stops the finalising retries', async () => {
    const w = world();
    w.ctl.failing = (op) => w.ctl.down || op === 'complete';
    await w.q.add(1);
    w.q.process(() => 'done', steady);
    await vi.advanceTimersByTimeAsync(500); // the complete is being retried
    queues.splice(queues.indexOf(w.q), 1);
    const closing = w.q.close({ timeoutMs: 100 });
    // the timeout, the 2 s abort grace, then the second a pending write gets to answer
    await vi.advanceTimersByTimeAsync(100 + 2000 + 1000);
    await closing;
    const after = w.ctl.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.ctl.calls.length).toBe(after);
    for (const k of ['completed', 'failed', 'error'] as const) expect(w.events[k]).not.toHaveBeenCalled();
  });

  it('reconnect: sweeper skips ticks while reconnecting', async () => {
    const w = world();
    w.q.process(() => 'ok', { ...steady, sweepInterval: 500 });
    await vi.advanceTimersByTimeAsync(600);
    expect(w.ops('sweep')).toHaveLength(1);
    w.ctl.down = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(w.q.connectionState).toBe('reconnecting');
    const from = performance.now();
    await vi.advanceTimersByTimeAsync(3000);
    expect(w.ops('sweep', from)).toEqual([]);
    w.ctl.down = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(w.ops('sweep', from).length).toBeGreaterThanOrEqual(1);
  });

  it('reconnect: ready waits through an outage and rejects with StoreNotReadyError at its timeout', async () => {
    const w = world();
    await w.q.ready();
    w.ctl.down = true;
    const short = w.q.ready({ timeoutMs: 100 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await short).toBeInstanceOf(StoreNotReadyError);
    const long = w.q.ready({ timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(2000);
    w.ctl.down = false;
    await vi.advanceTimersByTimeAsync(100);
    await expect(long).resolves.toBeUndefined();
  });
});
