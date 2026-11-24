import { describe, expect, it, vi } from 'vitest';
import { BulkAddError, InvalidMergeResultError, MergeConflictError, PayloadTooLargeError, StoreError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import type { Scope, Store, UpdateRequest } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { spyStore } from '../helpers/spy-store.js';
import { claimJobs, fakeClock } from '../helpers/store.js';

type Data = Record<string, unknown>;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const merge = (e: Readonly<Job<Data>>, i: Readonly<Data>): Data => ({ ...e.data, ...i });

function setup(opts: { wrap?: (inner: MemoryStore) => Store; queue?: Record<string, unknown> } = {}) {
  const { c, clock } = fakeClock();
  const raw = new MemoryStore({ clock });
  const store = opts.wrap ? opts.wrap(raw) : raw;
  const q = new Queue<Data>('q', { store, logger: silent, ...opts.queue });
  const events = { added: 0, duplicate: [] as unknown[] };
  q.on('added', () => void events.added++);
  q.on('duplicate', (e) => void events.duplicate.push(e));
  const scope = q.internals.scope;
  const total = async () => Object.entries(await raw.counts(scope)).reduce((n, [k, v]) => (k === 'blocked' ? n : n + v), 0);
  return { c, raw, q, events, scope, total };
}

/** A store whose `update` runs `before` first (with the inner store), counting calls. */
function wrapUpdate(before: (inner: MemoryStore, scope: Scope, req: UpdateRequest, call: number) => Promise<'conflict' | void>) {
  let calls = 0;
  return (inner: MemoryStore) =>
    spyStore(inner, {
      update: async (scope, req) => {
        const verdict = await before(inner, scope, req, ++calls);
        return verdict === 'conflict' ? { ok: false, reason: 'conflict' } : inner.update(scope, req);
      },
    }).store;
}

describe('merge function', () => {
  it('merge: first add of a new id stores data unchanged and does not call the function', async () => {
    const { q } = setup();
    const fn = vi.fn(merge);
    const r = await q.add({ a: 1 }, { id: 'm', onDuplicate: fn });
    expect(r).toMatchObject({ added: true, job: { data: { a: 1 } } });
    expect(fn).not.toHaveBeenCalled();
  });

  it('dedup: merge fn result is written and action is merged', async () => {
    const { q, raw, scope, events } = setup();
    await q.add({ a: 1 }, { id: 'm' });
    const rev = (await raw.get(scope, 'm'))!.rev;
    const r = await q.add({ b: 2 }, { id: 'm', onDuplicate: merge });
    expect(r).toMatchObject({ added: false, duplicate: { action: 'merged', existingState: 'waiting', by: 'id' } });
    expect(r.job.data).toEqual({ a: 1, b: 2 });
    expect((await raw.get(scope, 'm'))!.rev).toBe(rev + 1);
    expect(events).toEqual({ added: 1, duplicate: [{ id: 'm', action: 'merged', existingState: 'waiting', by: 'id' }] });
  });

  it('merge: duplicate event fires with action merged', async () => {
    const { q, events } = setup();
    await q.add({ a: 1 }, { id: 'm' });
    await q.add({ b: 2 }, { id: 'm', onDuplicate: merge });
    expect(events.duplicate).toEqual([{ id: 'm', action: 'merged', existingState: 'waiting', by: 'id' }]);
  });

  it('merge: function result becomes data and keeps id, priority, runAt, createdAt, attempt', async () => {
    const { q, c } = setup();
    const first = (await q.add({ a: 1 }, { id: 'm', priority: 9, delay: '1m' })).job;
    c.t += 10;
    const r = await q.add({ b: 2 }, { id: 'm', priority: 1, onDuplicate: merge });
    expect(r.duplicate).toMatchObject({ action: 'merged', existingState: 'delayed' });
    const { id, priority, runAt, createdAt, attempt } = r.job;
    expect({ id, priority, runAt, createdAt, attempt }).toEqual({ id: 'm', priority: 9, runAt: first.runAt, createdAt: first.createdAt, attempt: 0 });
  });

  it('merge: delayed retry job is merged and keeps attempt', async () => {
    const { q, raw, scope } = setup();
    await q.add({ a: 1 }, { id: 'm' });
    const [job] = await claimJobs(raw, scope);
    const failed = await raw.fail(scope, { id: 'm', token: job!.token, error: '{}', retryInMs: 5000 });
    const r = await q.add({ b: 2 }, { id: 'm', onDuplicate: merge });
    expect(r.duplicate).toMatchObject({ action: 'merged', existingState: 'delayed' });
    expect(r.job).toMatchObject({ attempt: 1, runAt: failed.ok ? failed.runAt : -1, data: { a: 1, b: 2 } });
  });

  it('merge: active job is not merged and result reports ignored with existingState active', async () => {
    const { q, raw, scope } = setup();
    await q.add({ a: 1 }, { id: 'm' });
    await claimJobs(raw, scope);
    const fn = vi.fn(merge);
    const r = await q.add({ b: 2 }, { id: 'm', onDuplicate: fn });
    expect(r).toMatchObject({ added: false, duplicate: { action: 'ignored', existingState: 'active', by: 'id' }, job: { data: { a: 1 } } });
    expect(fn).not.toHaveBeenCalled();
  });

  it('merge: finished job under pending uniqueWhile creates a new job', async () => {
    const { q, raw, scope } = setup();
    await q.add({ a: 1 }, { id: 'm' });
    const [job] = await claimJobs(raw, scope);
    await raw.complete(scope, { id: 'm', token: job!.token, result: null });
    const fn = vi.fn(merge);
    expect(await q.add({ b: 2 }, { id: 'm', onDuplicate: fn })).toMatchObject({ added: true, job: { data: { b: 2 } } });
    expect(fn).not.toHaveBeenCalled();
  });

  it('merge: merged data is checked against maxPayloadBytes', async () => {
    const { q, raw, scope } = setup({ queue: { maxPayloadBytes: 30 } });
    await q.add({ a: 'x'.repeat(10) }, { id: 'm' });
    const before = await raw.get(scope, 'm');
    await expect(q.add({ b: 'y'.repeat(10) }, { id: 'm', onDuplicate: merge })).rejects.toThrow(PayloadTooLargeError);
    expect(await raw.get(scope, 'm')).toEqual(before);
  });

  it('merge: undefined or promise return throws InvalidMergeResultError', async () => {
    const { q, raw, scope } = setup();
    await q.add({ a: 1 }, { id: 'm' });
    const before = await raw.get(scope, 'm');
    const bad = [() => undefined, () => Promise.resolve({}), async () => ({}), () => ({ n: 1n })];
    for (const fn of bad) {
      const e = await q.add({ b: 2 }, { id: 'm', onDuplicate: fn as never }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(InvalidMergeResultError);
      expect(e).toMatchObject({ jobId: 'm' });
    }
    expect(await raw.get(scope, 'm')).toEqual(before);
  });

  it('dedup: throwing merge fn writes nothing and rejects add', async () => {
    const { q, raw, scope } = setup();
    await q.add({ a: 1 }, { id: 'm' });
    const before = await raw.get(scope, 'm');
    const boom = new Error('boom');
    // the thrown value is the cause of an InvalidMergeResultError, so callers can branch on the code
    await expect(q.add({ b: 2 }, { id: 'm', onDuplicate: () => { throw boom; } })).rejects.toSatisfy((e) => e instanceof InvalidMergeResultError && e.cause === boom);
    expect(await raw.get(scope, 'm')).toEqual(before);
  });

  it('merge: function may run more than once and still yields one merged value', async () => {
    const wrap = wrapUpdate(async (inner, scope, req, call) => {
      if (call !== 1) return;
      // another writer lands first
      await inner.update(scope, { id: req.id, expectedRev: req.expectedRev, patch: { data: '{"a":1,"other":3}' } });
      return 'conflict';
    });
    const { q } = setup({ wrap });
    await q.add({ a: 1 }, { id: 'm' });
    const fn = vi.fn(merge);
    const r = await q.add({ b: 2 }, { id: 'm', onDuplicate: fn });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.job.data).toEqual({ a: 1, other: 3, b: 2 });
  });

  it('dedup: merge fn is retried on conflict and gives up with MergeConflictError', async () => {
    const { q } = setup({ wrap: wrapUpdate(async () => 'conflict') });
    await q.add({ a: 1 }, { id: 'm' });
    const fn = vi.fn(merge);
    const e = await q.add({ b: 2 }, { id: 'm', onDuplicate: fn }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MergeConflictError);
    expect(e).toMatchObject({ jobId: 'm' });
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it('merge: claim between read and write is reported as ignored, never a second job', async () => {
    const wrap = wrapUpdate(async (inner, scope, _req, call) => void (call === 1 && (await claimJobs(inner, scope))));
    const { q, total } = setup({ wrap });
    await q.add({ a: 1 }, { id: 'm' });
    const r = await q.add({ b: 2 }, { id: 'm', onDuplicate: merge });
    expect(r).toMatchObject({ added: false, duplicate: { action: 'ignored', existingState: 'active' }, job: { data: { a: 1 } } });
    expect(await total()).toBe(1);
  });

  it('merge: job removed between read and write is added as a new job', async () => {
    const wrap = wrapUpdate(async (inner, scope, req, call) => void (call === 1 && (await inner.remove(scope, { id: req.id }))));
    const { q, total } = setup({ wrap });
    await q.add({ a: 1 }, { id: 'm' });
    const fn = vi.fn(merge);
    const r = await q.add({ b: 2 }, { id: 'm', onDuplicate: fn });
    expect(r).toMatchObject({ added: true, job: { data: { b: 2 } } });
    expect(fn.mock.calls.length).toBeLessThanOrEqual(1);
    expect(await total()).toBe(1);
  });

  it('dedup: id function is not re-run on merge retries', async () => {
    const { q } = setup({ wrap: wrapUpdate(async (_i, _s, _r, call) => (call <= 3 ? 'conflict' : undefined)) });
    await q.add({ a: 1 }, { id: 'm' });
    const id = vi.fn(() => 'm');
    const fn = vi.fn(merge);
    expect((await q.add({ b: 2 }, { id, onDuplicate: fn })).duplicate?.action).toBe('merged');
    expect(id).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('merge: mutation of existing or incoming inside the function is blocked', async () => {
    const { q } = setup();
    await q.add({ a: { deep: 1 } }, { id: 'm' });
    const mutateExisting = (e: Readonly<Job<Data>>) => {
      (e.data['a'] as Data)['deep'] = 2;
      return e.data;
    };
    const mutateIncoming = (_e: unknown, i: Readonly<Data>) => {
      (i as Data)['b'] = 3;
      return i;
    };
    const frozen = (e: unknown) => e instanceof InvalidMergeResultError && e.cause instanceof TypeError;
    await expect(q.add({ b: 2 }, { id: 'm', onDuplicate: mutateExisting })).rejects.toSatisfy(frozen);
    await expect(q.add({ b: 2 }, { id: 'm', onDuplicate: mutateIncoming as never })).rejects.toSatisfy(frozen);
    const same = await q.add({ b: 2 }, { id: 'm', onDuplicate: (e) => e.data });
    expect(same).toMatchObject({ duplicate: { action: 'merged' }, job: { data: { a: { deep: 1 } } } });
  });

  it('merge: addBulk folds in-call duplicates in input order', async () => {
    const { q } = setup();
    const fold = (e: Readonly<Job<Data>>, i: Readonly<Data>): Data => ({ ns: [...(e.data['ns'] as number[]), ...(i['ns'] as number[])] });
    const out = await q.addBulk([1, 2, 3].map((n) => ({ data: { ns: [n] }, opts: { id: 'a', onDuplicate: fold } })));
    expect(out.map((o) => (o.ok ? (o.duplicate?.action ?? 'added') : 'error'))).toEqual(['added', 'merged', 'merged']);
    expect((await q.getJob('a'))!.data).toEqual({ ns: [1, 2, 3] });
  });

  it('merge: addBulk atomic with a failing merge writes nothing', async () => {
    const { q, raw, scope } = setup();
    await q.add({ a: 1 }, { id: 'held' });
    const before = await raw.counts(scope);
    const boom = new Error('boom');
    const items = [
      { data: { x: 1 }, opts: { id: 'new' } },
      { data: { b: 2 }, opts: { id: 'held', onDuplicate: () => { throw boom; } } },
    ];
    const e = (await q.addBulk(items, { atomic: true }).catch((x: unknown) => x)) as BulkAddError;
    expect(e).toBeInstanceOf(BulkAddError);
    expect(e).toMatchObject({ index: 1, jobIds: ['new', 'held'] });
    expect(e.cause).toBeInstanceOf(InvalidMergeResultError);
    expect((e.cause as InvalidMergeResultError).cause).toBe(boom);
    const inCall = [{ data: { a: 1 }, opts: { id: 'n2' } }, { data: { b: 1 }, opts: { id: 'n2', onDuplicate: () => undefined as never } }];
    await expect(q.addBulk(inCall, { atomic: true })).rejects.toMatchObject({ index: 1 });
    expect(await raw.counts(scope)).toEqual(before);
    const ok = await q.addBulk([{ data: { c: 1 }, opts: { id: 'held', onDuplicate: merge } }], { atomic: true });
    expect(ok[0]).toMatchObject({ ok: true, duplicate: { action: 'merged' }, job: { data: { a: 1, c: 1 } } });
  });

  it('merge: addBulk non-atomic keeps every other input when one merge function throws', async () => {
    const { q, events } = setup();
    await q.add({ a: 1 }, { id: 'held' });
    const boom = new TypeError('boom');
    const items = [
      { data: { x: 1 }, opts: { id: 'x' } },
      { data: { b: 2 }, opts: { id: 'held', onDuplicate: () => { throw boom; } } },
      { data: { y: 1 }, opts: { id: 'y' } },
    ];
    const out = await q.addBulk(items);
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    const slot = out[1]!;
    const error = slot.ok ? undefined : slot.error;
    expect(error).toBeInstanceOf(InvalidMergeResultError);
    expect(error).toMatchObject({ jobId: 'held', cause: boom, message: 'The merge function for job "held" threw' });
    expect(events.added).toBe(3);
    expect((await q.getJob('held'))!.data).toEqual({ a: 1 });
  });

  it('merge: addBulk atomic reports the committed inputs before rejecting a merge that failed after the write', async () => {
    // another writer changes the held job between the dry pass and the write, so the merge runs again
    const racing = (inner: MemoryStore) =>
      spyStore(inner, {
        add: async (scope, jobs, opts) => {
          const held = jobs.length === 3 ? await inner.get(scope, 'held') : null;
          if (held) await inner.update(scope, { id: 'held', expectedRev: held.rev, patch: { data: '{"a":5}' } });
          return inner.add(scope, jobs, opts);
        },
      }).store;
    const { q, events } = setup({ wrap: racing });
    await q.add({ a: 1 }, { id: 'held' });
    let calls = 0;
    // the dry pass succeeds, the real merge after the write throws
    const flaky = (e: Readonly<Job<Data>>) => {
      if (++calls > 1) throw new TypeError('late');
      return e.data;
    };
    const items = [{ data: { x: 1 }, opts: { id: 'x' } }, { data: { b: 2 }, opts: { id: 'held', onDuplicate: flaky } }, { data: { y: 1 }, opts: { id: 'y' } }];
    const e = (await q.addBulk(items, { atomic: true }).catch((x: unknown) => x)) as BulkAddError;
    expect(e).toBeInstanceOf(BulkAddError);
    expect(e).toMatchObject({ index: 1, jobIds: ['x', 'held', 'y'] });
    expect(events.added).toBe(3);
    expect(await q.getJob('x')).not.toBeNull();
    expect(await q.getJob('y')).not.toBeNull();
  });

  it('merge: a lazily promoted store record is seen as waiting by the result and the merge function', async () => {
    // a store that reports a due delayed job as delayed until something reads it with a later time
    const lazy = (inner: MemoryStore) =>
      spyStore(inner, {
        add: async (scope, jobs, opts) =>
          (await inner.add(scope, jobs, opts)).map((o) =>
            o.status === 'duplicate' && o.job.state === 'waiting' ? { ...o, existingState: 'delayed' as const, job: { ...o.job, state: 'delayed' as const } } : o,
          ),
      }).store;
    const { q, c } = setup({ wrap: lazy });
    await q.add({ a: 1 }, { id: 'm', delay: 100 });
    c.t += 200;
    const ignored = await q.add({ b: 2 }, { id: 'm' });
    expect(ignored.job.state).toBe('waiting');
    const seen: string[] = [];
    await q.add({ b: 2 }, { id: 'm', onDuplicate: (e) => (seen.push(e.state), { ...e.data }) });
    expect(seen).toEqual(['waiting']);
  });

  it('merge: an unknown-outcome store error on the re-add carries the job id', async () => {
    let adds = 0;
    const wrap = (inner: MemoryStore) =>
      spyStore(inner, {
        add: async (scope, jobs, opts) => {
          if (++adds === 3) throw new StoreError('lost', { operation: 'add', retryable: true, outcomeUnknown: true });
          return inner.add(scope, jobs, opts);
        },
        update: async (scope, req) => {
          await inner.remove(scope, { id: req.id });
          return inner.update(scope, req);
        },
      }).store;
    const { q } = setup({ wrap });
    await q.add({ a: 1 }, { id: 'm' });
    const e = await q.add({ b: 2 }, { id: 'm', onDuplicate: merge }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreError);
    expect(e).toMatchObject({ jobIds: ['m'] });
  });

  const union = (e: Readonly<Job<{ ids: number[] }>>, i: Readonly<{ ids: number[] }>) => ({ ids: [...e.data.ids, ...i.ids] });

  async function concurrentMerges(writers: number) {
    const store = new MemoryStore();
    const queues = Array.from({ length: writers }, () => new Queue<{ ids: number[] }>('race', { store, logger: silent }));
    await queues[0]!.add({ ids: [] }, { id: 'one' });
    const settled = await Promise.allSettled(queues.map((q, n) => q.add({ ids: [n] }, { id: 'one', onDuplicate: union })));
    const ids = (await queues[0]!.getJob('one'))!.data.ids;
    const counts = await queues[0]!.getCounts();
    return { settled, ids, total: counts.waiting + counts.delayed + counts.active };
  }

  it('merge: 10 concurrent merges into one waiting job all land', async () => {
    const { settled, ids, total } = await concurrentMerges(10);
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    expect([...ids].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(total).toBe(1);
  });

  it('merge: more writers than tries never lose a resolved payload', async () => {
    const { settled, ids, total } = await concurrentMerges(30);
    expect(ids.length, 'more than one merge landed').toBeGreaterThan(1);
    for (const [n, s] of settled.entries()) {
      if (s.status === 'fulfilled') expect(ids.filter((x) => x === n)).toHaveLength(1);
      else {
        expect(s.reason).toBeInstanceOf(MergeConflictError);
        expect(ids).not.toContain(n);
      }
    }
    expect(total).toBe(1);
  });
});
