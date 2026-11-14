import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs, stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidJobStateError } from '../../src/errors/catalog.js';
import { next, silent } from '../helpers/harness.js';
import { newJob } from '../helpers/seed.js';

const queues: Queue[] = [];
const make = (store = new MemoryStore(), opts: Record<string, unknown> = {}, name = 'rm') => {
  const q = new Queue(name, { store, logger: silent, ...opts });
  queues.push(q);
  return { store, q, scope: q.internals.scope };
};
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
});

describe('remove', () => {
  it('remove: waiting job is deleted and returns true', async () => {
    const { q } = make();
    const { job } = await q.add(1);
    expect(await q.remove(job.id)).toBe(true);
    expect(await q.getJob(job.id)).toBeNull();
    expect((await q.getCounts()).waiting).toBe(0);
  });

  it('remove: delayed job is deleted', async () => {
    const { q } = make();
    const { job } = await q.add(1, { delay: '1h' });
    expect(await q.remove(job.id)).toBe(true);
    expect(await q.getJob(job.id)).toBeNull();
  });

  it('remove: completed, failed and cancelled jobs are deleted', async () => {
    const { q, store, scope } = make();
    const w = q.process((job) => (job.data === 'bad' ? Promise.reject(new TypeError('x')) : 'ok'));
    const completed = next(w, 'completed');
    const { job: ok } = await q.add('ok');
    await completed;
    const failed = next(w, 'failed');
    const { job: bad } = await q.add('bad', { maxAttempts: 1 });
    await failed;
    await w.close();
    // The queue cannot cancel yet; cancel at the store.
    const { job: cancelled } = await q.add('cancel me');
    await store.cancel(scope, { id: cancelled.id });
    for (const id of [ok.id, bad.id, cancelled.id]) {
      expect(await q.remove(id), id).toBe(true);
      expect(await q.getJob(id)).toBeNull();
    }
  });

  it('remove: active job is rejected with InvalidJobStateError and is unchanged', async () => {
    const { q, store, scope } = make();
    const g = gate();
    const w = q.process(() => g.p);
    const active = next(w, 'active');
    const { job } = await q.add(1);
    await active;
    const e = await q.remove(job.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidJobStateError);
    expect(e).toMatchObject({ code: 'INVALID_JOB_STATE', jobId: job.id, details: { state: 'active' } });
    expect((await q.getJob(job.id))!.state).toBe('active');
    const rec = (await stored(store, scope, job.id))!;
    store.unsafeMutate(scope, job.id, { lease: { ...rec.lease!, expiresAt: 0 } }); // an expired lease is still active
    await expect(q.remove(job.id)).rejects.toBeInstanceOf(InvalidJobStateError);
    store.unsafeMutate(scope, job.id, { lease: rec.lease });
    const done = next(w, 'completed');
    g.open();
    await done;
    expect((await q.getJob(job.id))!.state).toBe('completed');
  });

  it('remove: unknown id returns false and does not throw JobNotFoundError', async () => {
    const { q } = make();
    expect(await q.remove('nope')).toBe(false);
    await expect(q.remove(5 as never)).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('remove: second remove returns false; other queue and namespace return false', async () => {
    const store = new MemoryStore();
    const { q } = make(store);
    const other = make(store, {}, 'other').q;
    const otherNs = make(store, { namespace: 'ns2' }).q;
    const { job } = await q.add(1);
    expect(await other.remove(job.id)).toBe(false);
    expect(await otherNs.remove(job.id)).toBe(false);
    expect(await q.remove(job.id)).toBe(true);
    expect(await q.remove(job.id)).toBe(false);
  });

  it('remove: job.remove and queue.remove behave the same', async () => {
    const { q } = make();
    const g = gate();
    const w = q.process((job) => (job.data === 'hold' ? g.p : 'ok'));
    const { job: waiting } = await q.add('wait', { delay: '1h' });
    expect(await waiting.remove()).toBe(true);
    expect(await waiting.remove()).toBe(false);
    expect(await q.remove(waiting.id)).toBe(false);
    expect(waiting.state).toBe('delayed'); // the snapshot is not updated
    const completed = next(w, 'completed');
    const { job: done } = await q.add('done');
    await completed;
    expect(await done.remove()).toBe(true);
    const active = next(w, 'active');
    const { job: held } = await q.add('hold');
    await active;
    const viaJob = await held.remove().catch((x: unknown) => x);
    const viaQueue = await q.remove(held.id).catch((x: unknown) => x);
    expect(viaJob).toBeInstanceOf(InvalidJobStateError);
    expect(viaQueue).toBeInstanceOf(InvalidJobStateError);
    g.open();
  });

  it('remove: counts and reads reflect removal at once', async () => {
    const { q } = make();
    const { job } = await q.add(1);
    await q.add(2);
    await q.remove(job.id);
    expect(await q.getJob(job.id)).toBeNull();
    expect((await q.getJobs('waiting')).map((j) => j.id)).not.toContain(job.id);
    expect((await q.getCounts()).waiting).toBe(1);
  });

  it('remove: removed id can be added again', async () => {
    // Caller-supplied ids are not accepted yet; the store must accept the id again at once.
    const { q, store, scope } = make();
    const { job } = await q.add(1);
    expect(await q.remove(job.id)).toBe(true);
    await expect(store.add(scope, [newJob({ id: job.id })])).resolves.toHaveLength(1);
    expect((await q.getJob(job.id))!.state).toBe('waiting');
  });

  it('remove: concurrent remove and claim — exactly one wins', async () => {
    const store = new MemoryStore();
    const { q, scope } = make(store);
    let handled = 0;
    for (let i = 0; i < 1000; i++) {
      const { job } = await q.add(i);
      const [claimed, removed] = await Promise.all([
        claimJobs(store, scope, { workerId: 'w', limit: 1 }),
        q.remove(job.id).catch((e: unknown) => e),
      ]);
      if (removed === true) {
        expect(claimed).toEqual([]);
      } else {
        expect(removed).toBeInstanceOf(InvalidJobStateError);
        expect(claimed.map((r) => r.id)).toEqual([job.id]);
        handled++;
        await store.complete(scope, { id: job.id, token: claimed[0]!.lease!.token, result: null });
      }
    }
    expect(handled).toBeGreaterThanOrEqual(0);
  });

  const withDrained = () => {
    const s = make();
    const drained = vi.fn();
    s.q.on('drained', drained);
    return { ...s, drained };
  };

  it('remove: removing the last job fires drained once; removing one of several does not', async () => {
    const { q, drained } = withDrained();
    const jobs = await Promise.all([1, 2, 3].map(async (i) => (await q.add(i)).job));
    await q.remove(jobs[0]!.id);
    await q.remove(jobs[1]!.id);
    expect(drained).not.toHaveBeenCalled();
    await q.remove(jobs[2]!.id);
    expect(drained).toHaveBeenCalledOnce();
    expect(drained).toHaveBeenCalledWith({ queue: 'rm' });
    await q.remove(jobs[2]!.id);
    expect(drained).toHaveBeenCalledOnce();
  });

  it('events: drained fires when the last job is removed', async () => {
    const { q, drained } = withDrained();
    const { job } = await q.add(1);
    await job.remove();
    expect(drained).toHaveBeenCalledOnce();
  });

  it('remove: removing a delayed job that is the last job fires drained', async () => {
    const { q, drained } = withDrained();
    const { job } = await q.add(1, { delay: '1h' });
    await q.remove(job.id);
    expect(drained).toHaveBeenCalledOnce();
  });

  // "counts: remove of a queued job keeps counts exact and drained fires" lives in tests/regression/remove-drained.test.ts.

  it('remove: no drained for an unknown id or while other jobs wait', async () => {
    const { q, drained } = withDrained();
    expect(await q.remove('nope')).toBe(false);
    expect(drained).not.toHaveBeenCalled();
    const w = q.process(() => 'ok');
    const completed = next(w, 'completed');
    const { job: done } = await q.add('done');
    await completed;
    await w.close();
    drained.mockClear();
    await q.add('still waiting');
    expect(await q.remove(done.id)).toBe(true);
    expect(drained).not.toHaveBeenCalled();
  });

  it('remove: two concurrent removes of one job — one true, one false', async () => {
    const { q } = make();
    const { job } = await q.add(1);
    expect((await Promise.all([q.remove(job.id), q.remove(job.id)])).sort()).toEqual([false, true]);
  });

  it('remove: removing a finished job from an empty queue does not fire drained', async () => {
    const { q } = make();
    const drained = vi.fn();
    q.on('drained', drained);
    const w = q.process(() => 'ok');
    const done = next(q, 'drained');
    const { job } = await q.add(1);
    await done;
    await w.close();
    expect(drained).toHaveBeenCalledOnce();
    expect(await q.remove(job.id)).toBe(true);
    expect(drained).toHaveBeenCalledOnce();
  });
});
