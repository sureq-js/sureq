import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import { JobNotFoundError, QueueClosedError } from '../../src/errors/catalog.js';
import { next, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

const queues: Queue[] = [];
const make = (store = new MemoryStore()) => {
  const q = new Queue('cx', { store, logger: silent, ...poll(20) });
  queues.push(q);
  return { store, q, scope: q.internals.scope };
};
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 200 })));
});

describe('cancel', () => {
  it('cancel: waiting job becomes cancelled and never runs', async () => {
    const { q, store, scope } = make();
    // a retrying job: delayed with one attempt spent
    const { job: retrying } = await q.add('r', { maxAttempts: 3, backoff: { type: 'fixed', delay: '1h' } });
    const failing = q.process(() => {
      throw new TypeError('again');
    });
    await next(failing, 'retrying');
    await failing.close();
    const { job: waiting } = await q.add('w');
    const { job: delayed } = await q.add('d', { delay: '1h' });

    const r1 = await q.cancel(waiting.id);
    expect(r1).toMatchObject({ cancelled: true, previousState: 'waiting' });
    expect(r1.job.state).toBe('cancelled');
    expect(await q.cancel(delayed.id)).toMatchObject({ cancelled: true, previousState: 'delayed', job: { state: 'cancelled' } });
    const r3 = await q.cancel(retrying.id);
    expect(r3).toMatchObject({ cancelled: true, previousState: 'delayed' });
    expect(r3.job.attempt).toBeGreaterThanOrEqual(1);
    expect(await q.getCounts()).toMatchObject({ waiting: 0, delayed: 0, cancelled: 3 });

    const handler = vi.fn();
    q.process(handler);
    await sleep(80);
    expect(handler).not.toHaveBeenCalled();
    expect((await store.get(scope, waiting.id))!.state).toBe('cancelled');
  });

  it('cancel: unknown id throws JobNotFoundError', async () => {
    const { q } = make();
    const err = await q.cancel('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobNotFoundError);
    expect(err).toMatchObject({ code: 'JOB_NOT_FOUND', jobId: 'nope' });
  });

  it('cancel: second cancel is idempotent and fires no event', async () => {
    const { q } = make();
    const { job } = await q.add(1);
    await q.cancel(job.id);
    const events = vi.fn();
    q.on('cancelled', events);
    expect(await q.cancel(job.id)).toMatchObject({ cancelled: false, reason: 'already-terminal', state: 'cancelled', job: { id: job.id } });
    expect(events).not.toHaveBeenCalled();
  });

  it('cancel: completed and failed jobs return already-terminal with their state', async () => {
    const { q } = make();
    const w = q.process((job) => (job.data === 'bad' ? Promise.reject(new TypeError('x')) : 'ok'));
    const completed = next(w, 'completed');
    const { job: ok } = await q.add('ok');
    await completed;
    const failed = next(w, 'failed');
    const { job: bad } = await q.add('bad', { maxAttempts: 1 });
    await failed;
    expect(await q.cancel(ok.id)).toMatchObject({ cancelled: false, reason: 'already-terminal', state: 'completed', job: { state: 'completed' } });
    expect(await q.cancel(bad.id)).toMatchObject({ cancelled: false, reason: 'already-terminal', state: 'failed', job: { state: 'failed' } });
  });

  it('cancel: cancelled event fires once with previousState', async () => {
    const { q } = make();
    const events = vi.fn();
    q.on('cancelled', events);
    const { job } = await q.add(1);
    await q.cancel(job.id);
    expect(events).toHaveBeenCalledOnce();
    const payload = events.mock.calls[0]![0] as { job: { id: string; state: string }; previousState: string };
    expect(payload).toMatchObject({ previousState: 'waiting', job: { id: job.id, state: 'cancelled' } });
  });

  it('cancel: job.cancel is equivalent to queue.cancel', async () => {
    const { q } = make();
    const { job } = await q.add(1);
    const first = await job.cancel();
    expect(first).toMatchObject({ cancelled: true, previousState: 'waiting', job: { id: job.id, state: 'cancelled' } });
    expect(await job.cancel()).toMatchObject({ cancelled: false, reason: 'already-terminal', state: 'cancelled' });
    expect(job.state).toBe('waiting');
  });

  it('cancel: cancelled job can be re-added under pending uniqueness', async () => {
    const { q } = make();
    await q.add(1, { id: 'same' });
    await q.cancel('same');
    const again = await q.add(2, { id: 'same' });
    expect(again.added).toBe(true);
    expect(again.job.state).toBe('waiting');
  });

  it('cancel: cancelling the last waiting job fires drained', async () => {
    const { q } = make();
    const drained = vi.fn();
    q.on('drained', drained);
    const jobs = await Promise.all([1, 2, 3].map(async (i) => (await q.add(i)).job));
    await q.cancel(jobs[0]!.id);
    await q.cancel(jobs[1]!.id);
    expect(drained).not.toHaveBeenCalled();
    await q.cancel(jobs[2]!.id);
    expect(drained).toHaveBeenCalledOnce();
  });

  it('cancel: cancelling the last active job fires drained after counts are zero', async () => {
    const { q } = make();
    const g = gate();
    const w = q.process(async (_job, ctx) => {
      await g.p;
      return ctx.signal.aborted;
    });
    const started = next(w, 'active');
    const { job } = await q.add(1);
    await started;
    const seen: unknown[] = [];
    q.on('drained', async () => void seen.push(await q.getCounts()));
    await q.cancel(job.id);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const { blocked, cancelled, ...rest } = seen[0] as Record<string, number>;
    expect(Object.values(rest).every((n) => n === 0)).toBe(true);
    expect([blocked, cancelled]).toEqual([0, 1]);
    g.open();
    await sleep(30);
    expect(seen).toHaveLength(1);
  });

  it('cancel: cancelling a terminal or unknown job never fires drained', async () => {
    const { q, store, scope } = make();
    const { job } = await q.add(1);
    // cancelled behind this queue object's back: nothing here armed the latch for it
    await store.cancel(scope, { id: job.id });
    const q2 = make(store).q;
    const drained = vi.fn();
    q2.on('drained', drained);
    await q2.cancel(job.id);
    await q2.cancel('nope').catch(() => {});
    expect(drained).not.toHaveBeenCalled();
  });

  it('cancel: works while the queue is paused', async () => {
    const { q } = make();
    await q.pause();
    const { job } = await q.add(1);
    expect(await q.cancel(job.id)).toMatchObject({ cancelled: true, previousState: 'waiting' });
  });

  it('cancel: works on a producer-only queue', async () => {
    const { q } = make();
    const { job } = await q.add(1);
    expect(await q.cancel(job.id)).toMatchObject({ cancelled: true });
  });

  it('cancel: on closed queue throws QueueClosedError', async () => {
    const { q } = make();
    const { job } = await q.add(1);
    void q.close();
    await expect(q.cancel(job.id)).rejects.toBeInstanceOf(QueueClosedError);
  });

  it('cancel: a non-string id is rejected', async () => {
    const { q } = make();
    await expect(q.cancel(1 as unknown as string)).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });
});
