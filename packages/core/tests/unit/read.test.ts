import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { serializeError } from '../../src/serialize/error.js';
import { next, silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

const queues: Queue[] = [];
const make = (name: string, store: MemoryStore, opts: Record<string, unknown> = {}) => {
  const q = new Queue(name, { store, logger: silent, ...opts });
  queues.push(q);
  return q;
};

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
});

describe('getJob', () => {
  it('read: getJob returns null for unknown id and for another queue\'s id', async () => {
    const store = new MemoryStore();
    const a = make('a', store);
    const b = make('b', store);
    const other = make('a', store, { namespace: 'other' });
    const { job } = await a.add(1);
    expect(await a.getJob('nope')).toBeNull();
    expect(await b.getJob(job.id)).toBeNull();
    expect(await other.getJob(job.id)).toBeNull();
    expect((await a.getJob(job.id))!.id).toBe(job.id);
    await expect(a.getJob(5 as never)).rejects.toBeInstanceOf(InvalidOptionError);
  });

  it('read: data result and error are deserialized', async () => {
    const store = new MemoryStore();
    const q = make('q', store);
    const w = q.process((job) => {
      if (job.data === 'bad') throw new TypeError('broken');
      return { ok: [1] };
    });
    const done = next(w, 'completed');
    const { job } = await q.add({ n: [1, { s: 'x' }] });
    await done;
    const read = (await q.getJob(job.id))!;
    expect(read.data).toEqual({ n: [1, { s: 'x' }] });
    expect(read.result).toEqual({ ok: [1] });
    const failed = next(w, 'failed');
    const { job: bad } = await q.add('bad', { maxAttempts: 1 });
    await failed;
    expect((await q.getJob(bad.id))!.error).toMatchObject({ name: 'TypeError', message: 'broken' });
  });

  it('read: nothing is cached; a store change is visible on the next call', async () => {
    const store = new MemoryStore();
    const q = make('q', store);
    const { job } = await q.add(1);
    expect((await q.getJob(job.id))!.state).toBe('waiting');
    await store.remove(q.internals.scope, { id: job.id });
    expect(await q.getJob(job.id)).toBeNull();
  });
});

/** A queue whose store clock the test drives, plus direct store steps to place jobs in each state. */
const timed = (opts: Record<string, unknown> = {}) => {
  const c = { t: 1_000_000 };
  const store = new MemoryStore({ clock: () => c.t });
  const q = make('t', store, opts);
  const scope = q.internals.scope;
  const err = JSON.stringify(serializeError(new TypeError('x'), { maxErrorBytes: 16_384, storeStacks: false }));
  const claimOne = async () => (await claimJobs(store, scope, { workerId: 'w', limit: 1, order: 'fifo' }))[0]!;
  return {
    c,
    store,
    q,
    scope,
    claimOne,
    complete: async () => {
      const r = await claimOne();
      c.t += 10;
      await store.complete(scope, { id: r.id, token: r.lease!.token, result: null });
      return r.id;
    },
    failFinal: async () => {
      const r = await claimOne();
      c.t += 10;
      await store.fail(scope, { id: r.id, token: r.lease!.token, error: err });
      return r.id;
    },
  };
};
const ids = (jobs: Array<{ id: string }>) => jobs.map((j) => j.id);

describe('getJobs', () => {
  it('read: getJobs paginates with offset and limit in the documented order for every state', async () => {
    for (const state of ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const) {
      const s = timed();
      const opts = state === 'delayed' ? { delay: '1h' as const } : { maxAttempts: 1 };
      for (let i = 0; i < 5; i++) await s.q.add(i, opts);
      for (let i = 0; i < 5; i++) {
        if (state === 'active') {
          await s.claimOne();
          s.c.t += 10;
        }
        if (state === 'completed') await s.complete();
        if (state === 'failed') await s.failFinal();
      }
      const all = await s.q.getJobs(state, { limit: 1000 });
      expect(all.length, state).toBe(state === 'cancelled' ? 0 : 5);
      const pages = [await s.q.getJobs(state, { limit: 2 }), await s.q.getJobs(state, { offset: 2, limit: 2 }), await s.q.getJobs(state, { offset: 4, limit: 2 })];
      expect(ids(pages.flat()), state).toEqual(ids(all));
      if (state !== 'cancelled') expect(pages[2]).toHaveLength(1);
      expect(await s.q.getJobs(state, { offset: 10 })).toEqual([]);
      expect(await s.q.getJobs(state, { limit: 0 })).toEqual([]);
      for (const j of all) expect(j.state).toBe(state);
    }
  });

  it('read: getJobs order is seq asc for waiting, runAt asc for delayed, startedAt asc for active, finishedAt desc for terminal states', async () => {
    const s = timed();
    const w1 = (await s.q.add('w1')).job.id;
    const w2 = (await s.q.add('w2')).job.id;
    const wFirst = (await s.q.add('wf', { first: true })).job.id;
    expect(ids(await s.q.getJobs('waiting'))).toEqual([wFirst, w1, w2]);

    const d = timed();
    const d3 = (await d.q.add(3, { delay: '3s' })).job.id;
    const d1 = (await d.q.add(1, { delay: '1s' })).job.id;
    const d2a = (await d.q.add(2, { delay: '2s' })).job.id;
    const d2b = (await d.q.add(2, { delay: '2s' })).job.id;
    expect(ids(await d.q.getJobs('delayed'))).toEqual([d1, d2a, d2b, d3]);

    const a = timed();
    for (let i = 0; i < 3; i++) await a.q.add(i);
    const claimed: string[] = [];
    for (let i = 0; i < 3; i++) {
      claimed.push((await a.claimOne()).id);
      a.c.t += 100;
    }
    expect(ids(await a.q.getJobs('active'))).toEqual(claimed);

    const t = timed();
    for (let i = 0; i < 3; i++) await t.q.add(i);
    const done: string[] = [];
    for (let i = 0; i < 3; i++) done.push(await t.complete());
    expect(ids(await t.q.getJobs('completed'))).toEqual([...done].reverse());
  });

  it('read: finished jobs with the same finishedAt are ordered by seq desc', async () => {
    const s = timed();
    const added: string[] = [];
    for (let i = 0; i < 3; i++) added.push((await s.q.add(i, { maxAttempts: 1 })).job.id);
    const claimed = await claimJobs(s.store, s.scope, { workerId: 'w', limit: 3, order: 'fifo' });
    for (const r of claimed) await s.store.complete(s.scope, { id: r.id, token: r.lease!.token, result: null }); // same clock: equal finishedAt
    expect(ids(await s.q.getJobs('completed'))).toEqual([...added].reverse());
  });

  it('read: getJobs waiting order ignores priority and the queue order option', async () => {
    const s = timed({ order: 'lifo' });
    const added: string[] = [];
    for (const priority of [5, 0, 9]) added.push((await s.q.add(priority, { priority })).job.id);
    expect(ids(await s.q.getJobs('waiting'))).toEqual(added);
  });

  it('order: getJobs listing is independent of the queue order option', async () => {
    const store = new MemoryStore();
    const fifo = make('o', store, { order: 'fifo' });
    const lifo = make('o', store, { order: 'lifo' });
    for (let i = 0; i < 4; i++) await (i % 2 ? fifo : lifo).add(i);
    expect(ids(await fifo.getJobs('waiting'))).toEqual(ids(await lifo.getJobs('waiting')));
  });

  it('read: getJobs limit above max throws InvalidOptionError', async () => {
    const s = timed();
    await expect(s.q.getJobs('waiting', { limit: 1001 })).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(s.q.getJobs('waiting', { limit: 1000 })).resolves.toEqual([]);
    await s.q.addBulk(Array.from({ length: 150 }, (_, i) => ({ data: i })));
    expect(await s.q.getJobs('waiting')).toHaveLength(100);
  });

  it('read: delayed job past runAt counts as waiting (listing)', async () => {
    const s = timed();
    const { job } = await s.q.add(1, { delay: '5s' });
    expect(ids(await s.q.getJobs('delayed'))).toEqual([job.id]);
    s.c.t += 5000;
    expect(await s.q.getJobs('delayed')).toEqual([]);
    expect(ids(await s.q.getJobs('waiting'))).toEqual([job.id]);
  });

  it('read: getCounts has all six keys, zero filled', async () => {
    const counts = await timed().q.getCounts();
    expect(counts).toEqual({ waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 });
    expect(Object.keys(counts)).toHaveLength(7);
  });

  it('read: counts match the jobs after every transition kind', async () => {
    const s = timed();
    const STATES = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const;
    const fromLists = async () => {
      const out: Record<string, number> = {};
      for (const st of STATES) {
        let n = 0;
        for (let offset = 0; ; offset += 1000) {
          const page = await s.q.getJobs(st, { offset, limit: 1000 });
          n += page.length;
          if (page.length < 1000) break;
        }
        out[st] = n;
      }
      return out;
    };
    const check = async (step: string) => {
      const { blocked, ...counts } = await s.q.getCounts();
      expect(blocked, step).toBe(0);
      expect(counts, step).toEqual(await fromLists());
    };
    const err = JSON.stringify(serializeError(new TypeError('x'), { maxErrorBytes: 16_384, storeStacks: false }));
    const { job: w } = await s.q.add('waiting');
    await check('add immediate');
    await s.q.add('delayed', { delay: '1s' });
    await check('add delayed');
    s.c.t += 1000;
    await check('delayed becomes due');
    const claimed = await s.claimOne();
    await check('claim');
    await s.store.complete(s.scope, { id: claimed.id, token: claimed.lease!.token, result: null });
    await check('complete');
    const retry = await s.claimOne();
    await s.store.fail(s.scope, { id: retry.id, token: retry.lease!.token, error: err, retryInMs: 60_000 });
    await check('retry to delayed');
    const { job: f } = await s.q.add('final', { maxAttempts: 1 });
    const fin = (await claimJobs(s.store, s.scope, { workerId: 'w', limit: 10, order: 'fifo' })).find((r) => r.id === f.id)!;
    await s.store.fail(s.scope, { id: fin.id, token: fin.lease!.token, error: err });
    await check('terminal fail');
    await s.store.remove(s.scope, { id: w.id });
    await check('remove waiting');
    await s.store.remove(s.scope, { id: claimed.id });
    await check('remove completed');
  });

  it('read: counts equal list lengths on a quiet queue', async () => {
    const s = timed();
    await s.q.addBulk(Array.from({ length: 7 }, (_, i) => ({ data: i })));
    await s.q.add(1, { delay: '1h' });
    const c = await s.q.getCounts();
    expect(c.waiting).toBe((await s.q.getJobs('waiting')).length);
    expect(c.delayed).toBe((await s.q.getJobs('delayed')).length);
  });

  it('read: read-your-writes after add from a second queue object (second pod)', async () => {
    const store = new MemoryStore();
    const a = make('rw', store);
    const b = make('rw', store);
    await a.add(1);
    expect((await b.getCounts()).waiting).toBe(1);
  });

  it('read: counts stay exact under 1000 concurrent adds, claims and completes across N pods', async () => {
    const store = new MemoryStore();
    const pods = Array.from({ length: 4 }, () => make('pods', store));
    let completed = 0;
    const all = new Promise<void>((r) => pods.forEach((p) => p.on('completed', () => void (++completed === 1000 && r()))));
    let maxSum = 0;
    const sample = setInterval(async () => {
      const c = await pods[0]!.getCounts();
      maxSum = Math.max(maxSum, c.waiting + c.delayed + c.active + c.completed + c.failed + c.cancelled);
    }, 1);
    pods.forEach((p) => p.process(() => 'ok', { concurrency: 5, ...poll(5) }));
    await Promise.all(Array.from({ length: 1000 }, (_, i) => pods[i % 4]!.add(i)));
    await all;
    clearInterval(sample);
    const c = await pods[0]!.getCounts();
    expect(c.completed).toBe(1000);
    expect(c.waiting + c.delayed + c.active).toBe(0);
    expect(c.waiting + c.delayed + c.active + c.completed + c.failed + c.cancelled).toBe(1000);
    expect(maxSum).toBeLessThanOrEqual(1000);
  }, 30_000);

  it('read: delayed job past runAt counts as waiting (counts)', async () => {
    const s = timed();
    await s.q.add(1, { delay: '5s' });
    expect(await s.q.getCounts()).toMatchObject({ delayed: 1, waiting: 0 });
    s.c.t += 5000;
    expect(await s.q.getCounts()).toMatchObject({ delayed: 0, waiting: 1 });
  });

  it('read: invalid getJobs arguments throw InvalidOptionError', async () => {
    const s = timed();
    for (const range of [{ offset: -1 }, { offset: 1.5 }, { limit: -1 }, { limit: 2.5 }, { limit: 'x' }, { bogus: 1 }]) {
      await expect(s.q.getJobs('waiting', range as never), JSON.stringify(range)).rejects.toBeInstanceOf(InvalidOptionError);
    }
    await expect(s.q.getJobs('paused' as never)).rejects.toBeInstanceOf(InvalidOptionError);
  });
});
