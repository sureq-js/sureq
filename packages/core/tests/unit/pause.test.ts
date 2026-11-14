import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerClosedError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import type { PauseEvent } from '../../src/queue/pause.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import type { ReleaseRequest } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.allSettled(queues.splice(0).map((q) => q.close({ timeoutMs: 0 })));
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL = 20;

/** A queue on a spied MemoryStore; `holdClaim` holds the next claim's answer (its write is applied) until released. */
function setup(opts: QueueOptions = {}) {
  const inner = new MemoryStore();
  const releases: ReleaseRequest[] = [];
  let held: { reached: () => void; gate: Promise<void> } | undefined;
  const spy = spyStore(inner, {
    claim: async (s, r) => {
      const res = await inner.claim(s, r);
      const h = held;
      held = undefined;
      if (h) {
        h.reached();
        await h.gate;
      }
      return res;
    },
    release: (s, r) => (releases.push(r), inner.release(s, r)),
  });
  const q = new Queue('p', { store: spy.store, logger: silent, ...poll(POLL), ...opts });
  queues.push(q);
  const claims = () => spy.calls.filter((c) => c.op === 'claim').length;
  const rec = async (id: string) => (await inner.get(q.internals.scope, id))!;
  const holdClaim = () => {
    const reached = deferred();
    const gate = deferred();
    held = { reached: reached.resolve, gate: gate.promise };
    return { reached: reached.promise, release: gate.resolve };
  };
  return { inner, spy, q, claims, rec, releases, holdClaim };
}

describe('pause: local', () => {
  it('pause: paused worker makes no claim calls', async () => {
    const { q, claims } = setup();
    const handler = vi.fn();
    const w = q.process(handler);
    await w.pause();
    const before = claims();
    await q.add(1);
    await sleep(POLL * 3);
    expect(claims()).toBe(before);
    expect(handler).not.toHaveBeenCalled();
  });

  it('pause: active jobs finish normally while paused', async () => {
    const { q, rec } = setup();
    const g = deferred();
    const started = deferred();
    const w = q.process(async () => {
      started.resolve();
      await g.promise;
    });
    const { job } = await q.add(1);
    await started.promise;
    await w.pause();
    const completed = new Promise((r) => w.once('completed', r));
    g.resolve();
    await completed;
    expect((await rec(job.id)).state).toBe('completed');
  });

  it('pause: job returned by an in-flight claim is released and not started', async () => {
    const { q, rec, releases, holdClaim } = setup();
    const handler = vi.fn();
    const w = q.process(handler, { autorun: false });
    const { job } = await q.add(1);
    const held = holdClaim();
    void w.run();
    await held.reached;
    const pausing = w.pause();
    held.release();
    await pausing;
    expect(handler).not.toHaveBeenCalled();
    expect((await rec(job.id)).state).toBe('waiting');
    expect(releases).toEqual([expect.objectContaining({ id: job.id, refundAttempt: true, handlerStarted: false, reason: 'pause' })]);
  });

  it('pause: released job has its attempt restored and crashCount unchanged', async () => {
    const { q, rec, releases, holdClaim } = setup();
    const w = q.process(() => {}, { autorun: false });
    const { job } = await q.add(1);
    const held = holdClaim();
    void w.run();
    await held.reached;
    const token = (await rec(job.id)).lease!.token;
    const pausing = w.pause();
    held.release();
    await pausing;
    expect(await rec(job.id)).toMatchObject({ attempt: 0, crashCount: 0, lease: null });
    expect(releases[0]!.token).toBe(token);
  });

  it('pause: pause resolves after no more jobs can start', async () => {
    const { q, holdClaim } = setup();
    const w = q.process(() => {}, { autorun: false });
    await q.add(1);
    const held = holdClaim();
    void w.run();
    await held.reached;
    let resolved = false;
    const pausing = w.pause().then(() => (resolved = true));
    await sleep(POLL);
    expect(resolved).toBe(false);
    held.release();
    await pausing;
    expect(resolved).toBe(true);
  });

  it('pause: waitForActive resolves after running jobs settle', async () => {
    const { q } = setup();
    const g = deferred();
    const started = deferred();
    const w = q.process(async () => {
      started.resolve();
      await g.promise;
    });
    await q.add(1);
    await started.promise;
    let resolved = false;
    const pausing = w.pause({ waitForActive: true }).then(() => (resolved = true));
    await sleep(POLL);
    expect(resolved).toBe(false);
    g.resolve();
    await pausing;
    expect(w.inFlight).toBe(0);
  });

  it('pause: pause options are validated', async () => {
    const { q } = setup();
    const w = q.process(() => {});
    await expect(w.pause({ waitForActive: 'yes' } as never)).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    await expect(w.pause({ waitFor: true } as never)).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    expect(w.isPaused()).toBe(false);
  });

  it('pause: resume wakes the loop and jobs start immediately', async () => {
    vi.useFakeTimers();
    const { q } = setup(poll(60_000));
    const handler = vi.fn();
    const w = q.process(handler);
    await w.pause();
    await q.add(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(handler).not.toHaveBeenCalled();
    w.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('pause: pause and resume are idempotent', async () => {
    const { q } = setup();
    const w = q.process(() => {});
    const events: string[] = [];
    w.on('paused', () => void events.push('paused'));
    w.on('resumed', () => void events.push('resumed'));
    await w.pause();
    await w.pause();
    expect(w.isPaused()).toBe(true);
    w.resume();
    w.resume();
    expect(w.isPaused()).toBe(false);
    expect(events).toEqual(['paused', 'resumed']);
  });

  it('pause: pausing one worker does not pause another worker in the same pod', async () => {
    const { q } = setup();
    const a = q.process({ a: vi.fn() });
    const bHandler = vi.fn();
    const b = q.process({ b: bHandler });
    await a.pause();
    await q.add(1, { name: 'b' });
    await vi.waitFor(() => expect(bHandler).toHaveBeenCalledOnce());
    expect([a.isPaused(), b.isPaused()]).toEqual([true, false]);
  });

  it('pause: autorun false then pause stays idle after run', async () => {
    const { q, claims } = setup();
    const handler = vi.fn();
    const w = q.process(handler, { autorun: false });
    await w.pause();
    await q.add(1);
    await w.run();
    await sleep(POLL * 3);
    expect(claims()).toBe(0);
    w.resume();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  });

  it('pause: pause after close throws WorkerClosedError', async () => {
    const { q } = setup();
    const w = q.process(() => {});
    await w.close();
    await expect(w.pause()).rejects.toBeInstanceOf(WorkerClosedError);
    expect(() => w.resume()).toThrow(WorkerClosedError);
  });

  it('pause: pause and resume while the worker is stopping throw WorkerClosedError', async () => {
    const { q } = setup();
    const g = deferred();
    const started = deferred();
    const w = q.process(async () => {
      started.resolve();
      await g.promise;
    });
    const paused = vi.fn();
    w.on('paused', paused);
    await q.add(1);
    await started.promise;
    const closing = w.close();
    expect(w.state).toBe('stopping');
    await expect(w.pause()).rejects.toBeInstanceOf(WorkerClosedError);
    expect(() => w.resume()).toThrow(WorkerClosedError);
    g.resolve();
    await closing;
    expect([paused.mock.calls.length, w.isPaused('local')]).toEqual([0, false]);
  });

  it('pause: heartbeat keeps renewing leases of active jobs while paused', async () => {
    const { q, rec } = setup({ leaseDuration: '1s' });
    const g = deferred();
    const started = deferred();
    const w = q.process(async () => {
      started.resolve();
      await g.promise;
    }, { sweepInterval: '500ms' });
    const stalled = vi.fn();
    q.on('stalled', stalled);
    const { job } = await q.add(1);
    await started.promise;
    const token = (await rec(job.id)).lease!.token;
    await w.pause();
    await sleep(1500);
    expect(await rec(job.id)).toMatchObject({ state: 'active', crashCount: 0 });
    expect((await rec(job.id)).lease!.token).toBe(token);
    expect(stalled).not.toHaveBeenCalled();
    g.resolve();
  });

  it('pause: local pause does not call the store pause API', async () => {
    const { q, spy } = setup();
    const w = q.process(() => {});
    await w.pause();
    w.resume();
    await w.pause();
    expect(spy.calls.filter((c) => c.op === 'setPaused' || c.op === 'isPaused')).toEqual([]);
  });

  it('pause: no job starts after pause resolves under concurrent adds', async () => {
    const { q } = setup();
    let starts = 0;
    const w = q.process(() => void starts++, { concurrency: 5 });
    let pausing: Promise<void> | undefined;
    const adds: Promise<unknown>[] = [];
    for (let i = 0; i < 200; i++) {
      adds.push(q.add(i));
      if (i === 100) pausing = w.pause();
      if (i % 10 === 0) await sleep(0);
    }
    await pausing;
    const after = starts;
    await Promise.all(adds);
    await sleep(POLL * 3);
    expect(starts).toBe(after);
    expect(starts).toBeLessThan(200);
  });

  it("pause: pause then resume before the first claim returns releases that claim's jobs and claims again", async () => {
    const { q, rec, releases, holdClaim } = setup();
    const ran: number[] = [];
    const w = q.process((job) => void ran.push(job.data as number), { autorun: false, concurrency: 2 });
    const a = (await q.add(1)).job.id;
    const b = (await q.add(2)).job.id;
    const held = holdClaim();
    void w.run();
    await held.reached;
    const pausing = w.pause();
    w.resume();
    held.release();
    await pausing;
    expect(releases.map((r) => [r.id, r.reason])).toEqual([[a, 'pause'], [b, 'pause']]);
    await vi.waitFor(async () => {
      expect((await rec(a)).state).toBe('completed');
      expect((await rec(b)).state).toBe('completed');
    });
    expect(ran.sort()).toEqual([1, 2]);
    expect((await rec(a)).attempt).toBe(1);
  });

  it('pause: a throwing paused listener does not reject pause', async () => {
    const { q } = setup();
    const w = q.process(() => {});
    const errors: ErrorEvent[] = [];
    w.on('error', (e) => void errors.push(e));
    w.on('paused', () => {
      throw new TypeError('listener broke');
    });
    const seen: PauseEvent[] = [];
    w.on('paused', (e) => void seen.push(e));
    await w.pause();
    expect(w.isPaused('local')).toBe(true);
    expect(seen).toHaveLength(1);
    expect(errors).toEqual([expect.objectContaining({ source: 'listener' })]);
  });
});
