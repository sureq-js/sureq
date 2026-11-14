import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BulkAddError, FilterError, InvalidOptionError, JobRejectedError, PayloadTooLargeError, SerializationError, StoreUnavailableError,
} from '../../src/errors/catalog.js';
import type { ErrorEvent, QueueEvents } from '../../src/events/types.js';
import type { Job } from '../../src/job/job.js';
import type { FilterFn } from '../../src/queue/filter.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import { clientFor } from '../../src/store/client.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { outageStore } from '../helpers/outage.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

type Data = Record<string, unknown>;
const queues: Queue<Data>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close()));
});

function setup(filter: FilterFn<Data> | undefined, opts: QueueOptions<Data> = {}) {
  const inner = new MemoryStore();
  const { store, calls } = spyStore(inner);
  const q = new Queue<Data>('f', { store, logger: silent, ...(filter && { filter }), ...opts });
  queues.push(q);
  const rejected: Array<QueueEvents['rejected']> = [];
  q.on('rejected', (e) => void rejected.push(e));
  const waiting = async () => (await q.getCounts()).waiting;
  return { q, calls, rejected, waiting, inner };
}

const caught = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('filter on add', () => {
  it('filter: true accepts and the job is added', async () => {
    const { q } = setup(() => true);
    const r = await q.add({ a: 1 });
    expect(r.added).toBe(true);
    expect((await q.getJob(r.job.id))?.data).toEqual({ a: 1 });
  });

  it('filter: false rejects with reason filtered and nothing is stored', async () => {
    const { q, waiting } = setup(() => false);
    const e = await caught(q.add({ a: 1 }));
    expect(e).toBeInstanceOf(JobRejectedError);
    expect(e).toMatchObject({ reason: 'filtered', operation: 'add', jobId: null, code: 'JOB_REJECTED' });
    expect(await waiting()).toBe(0);
  });

  it('filter: string verdict becomes the reason', async () => {
    const { q } = setup(() => 'no account');
    await expect(q.add({})).rejects.toMatchObject({ name: 'JobRejectedError', reason: 'no account' });
  });

  it('filter: empty reason becomes filtered', async () => {
    for (const verdict of ['', { reject: '' }] as const) {
      const { q, rejected } = setup(() => verdict);
      await expect(q.add({})).rejects.toMatchObject({ reason: 'filtered' });
      expect(rejected[0]?.reason).toBe('filtered');
    }
  });

  it('filter: object verdict carries code and details', async () => {
    const { q } = setup(() => ({ reject: 'bad', code: 'E1', details: { row: 3 } }));
    const e = (await caught(q.add({}))) as JobRejectedError;
    expect(e).toMatchObject({ reason: 'bad', reasonCode: 'E1' });
    expect(e.details['details']).toEqual({ row: 3 });
  });

  it('filter: undefined verdict is a FilterError not an accept', async () => {
    const verdicts: unknown[] = [undefined, null, 1, {}, { reject: 5 }, { reject: 'x', code: 7 }, Promise.resolve(undefined)];
    for (const v of verdicts) {
      const { q, waiting, rejected } = setup(() => v as never);
      const e = await caught(q.add({ a: 1 }));
      expect(e).toBeInstanceOf(FilterError);
      expect((e as FilterError).timedOut).toBe(false);
      expect((e as FilterError).cause).toBeInstanceOf(TypeError);
      expect(((e as FilterError).cause as Error).message).toMatch(/^the filter returned \w+, not a verdict$/);
      expect(await waiting()).toBe(0);
      expect(rejected).toEqual([]);
    }
  });

  it('filter: throwing filter rejects add with FilterError and stores nothing', async () => {
    for (const fn of [() => { throw new TypeError('down'); }, () => Promise.reject(new TypeError('down'))]) {
      const { q, waiting } = setup(fn);
      const e = (await caught(q.add({}))) as FilterError;
      expect(e).toBeInstanceOf(FilterError);
      expect(e).toMatchObject({ timedOut: false, code: 'FILTER_ERROR' });
      expect((e.cause as Error).message).toBe('down');
      expect(await waiting()).toBe(0);
    }
  });

  it('filter: async filter timeout gives FilterError timedOut', async () => {
    useFakeTime();
    const { q, waiting } = setup(() => new Promise<never>(() => {}), { filterTimeoutMs: 1000 });
    const p = caught(q.add({}));
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await p;
    expect(e).toBeInstanceOf(FilterError);
    expect((e as FilterError).timedOut).toBe(true);
    expect(await waiting()).toBe(0);
  });

  it('filter: the default timeout is 5 s', async () => {
    useFakeTime();
    const { q } = setup(() => new Promise<never>(() => {}));
    const p = caught(q.add({}));
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ timedOut: true });
  });

  it('filter: rejected event fires once with id, reason and operation', async () => {
    const { q, rejected } = setup(() => 'nope');
    await caught(q.add({}, { id: 'job-1' }));
    await caught(q.add({}));
    expect(rejected).toEqual([
      { id: 'job-1', reason: 'nope', operation: 'add' },
      { id: null, reason: 'nope', operation: 'add' },
    ]);
    expect('reasonCode' in rejected[0]!).toBe(false);
  });

  it('filter: the context carries queue, name, id, options and operation', async () => {
    const seen: unknown[] = [];
    const { q } = setup((_d, ctx) => (seen.push(ctx), true), { id: (d) => `x-${String(d['n'])}`, defaultJobOptions: { maxAttempts: 4 } });
    await q.add({ n: 1 }, { name: 'send', priority: 2 });
    expect(seen).toEqual([{ queue: 'f', name: 'send', id: 'x-1', opts: { maxAttempts: 4, name: 'send', priority: 2 }, operation: 'add' }]);
    expect(Object.isFrozen((seen[0] as { opts: object }).opts)).toBe(true);
  });

  it('filter: runs after schema validation and before serialization, size check and the store call', async () => {
    const spy = vi.fn(() => true);
    const { q } = setup(spy, { maxPayloadBytes: 1000 });
    await expect(q.add({}, { priority: 'high' as never })).rejects.toBeInstanceOf(InvalidOptionError);
    expect(spy).not.toHaveBeenCalled();

    const big = { big: 'x'.repeat(2000) };
    await expect(setup(() => false, { maxPayloadBytes: 1000 }).q.add(big)).rejects.toBeInstanceOf(JobRejectedError);
    await expect(setup(() => true, { maxPayloadBytes: 1000 }).q.add(big)).rejects.toBeInstanceOf(PayloadTooLargeError);

    await expect(setup(() => false).q.add({ n: 1n })).rejects.toBeInstanceOf(JobRejectedError);
    await expect(setup(() => true).q.add({ n: 1n })).rejects.toBeInstanceOf(SerializationError);
  });

  it('filter: no store call is made for a rejected add', async () => {
    const { q, calls } = setup(() => false);
    await q.add({}, { id: 'warm' }).catch(() => {});
    await q.getCounts();
    const before = calls.length;
    await expect(q.add({ a: 1 })).rejects.toBeInstanceOf(JobRejectedError);
    expect(calls.slice(before)).toEqual([]);

    const { store, ctl } = outageStore();
    const down = new Queue<Data>('d', { store, logger: silent, filter: () => 'no', onDisconnected: 'reject' });
    queues.push(down);
    ctl.down = true;
    const e = await caught(down.add({}));
    expect(e).toBeInstanceOf(JobRejectedError);
    expect(e).not.toBeInstanceOf(StoreUnavailableError);
    expect(ctl.calls).toEqual([]);
    ctl.down = false;
  });

  it('filter: replace runs the filter on incoming data', async () => {
    const seen: Array<{ data: unknown; op: string }> = [];
    let accept = true;
    const { q } = setup((d, ctx) => (seen.push({ data: d, op: ctx.operation }), accept));
    await q.add({ v: 1 }, { id: 'j' });
    accept = false;
    const e = await caught(q.add({ v: 2 }, { id: 'j', onDuplicate: 'replace' }));
    expect(e).toMatchObject({ name: 'JobRejectedError', operation: 'replace', jobId: 'j' });
    expect(seen[1]).toEqual({ data: { v: 2 }, op: 'replace' });
    expect((await q.getJob('j'))?.data).toEqual({ v: 1 });
  });

  it('filter: duplicate ignore path still runs the filter first', async () => {
    let accept = true;
    const { q } = setup(() => accept);
    await q.add({ v: 1 }, { id: 'j' });
    const duplicates: unknown[] = [];
    q.on('duplicate', (e) => void duplicates.push(e));
    accept = false;
    await expect(q.add({ v: 2 }, { id: 'j' })).rejects.toBeInstanceOf(JobRejectedError);
    expect(duplicates).toEqual([]);
  });

  it('filter: retries, redrive and retry do not run the filter', async () => {
    const spy = vi.fn(() => true);
    const { q } = setup(spy, { defaultJobOptions: { backoff: 0 } });
    let runs = 0;
    // the first job fails twice; the others fail until redriven
    const again = () => Promise.reject(new TypeError('again'));
    const w = q.process((job) => (job.data['a'] === 1 ? (++runs < 3 ? again() : 'ok') : job.redriveCount === 0 ? again() : 'ok'), poll(5));
    const done = new Promise((r) => w.once('completed', r));
    await q.add({ a: 1 }, { maxAttempts: 3 });
    await done;
    expect(runs).toBe(3);
    expect(spy).toHaveBeenCalledTimes(1);
    // two dead letters, one redriven through queue.redrive and one through job.retry: both run again unfiltered
    let deadLettered = 0;
    const dead = new Promise((r) => w.on('deadLettered', () => void (++deadLettered === 2 && r(undefined))));
    const one = (await q.add({ a: 2 }, { maxAttempts: 1 })).job;
    const two = (await q.add({ a: 3 }, { maxAttempts: 1 })).job;
    await dead;
    expect(spy).toHaveBeenCalledTimes(3);
    const finished = new Promise((r) => w.on('completed', (e) => void (e.job.id === two.id && r(undefined))));
    await q.redrive(one.id);
    await (await q.getJob(two.id))!.retry();
    await finished;
    expect((await q.getJob(one.id))!.state).toBe('completed');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('filter: rejected payload is not logged', async () => {
    const lines: unknown[] = [];
    const capture = {
      debug: (...a: unknown[]) => void lines.push(['debug', ...a]),
      info: (...a: unknown[]) => void lines.push(['info', ...a]),
      warn: (...a: unknown[]) => void lines.push(['warn', ...a]),
      error: (...a: unknown[]) => void lines.push(['error', ...a]),
    };
    const { q } = setup(() => ({ reject: 'bad', code: 'E1' }), { logger: capture });
    await caught(q.add({ secret: 'tok-123' }, { id: 'j' }));
    expect(JSON.stringify(lines)).not.toContain('tok-123');
    expect(lines).toContainEqual(['debug', 'add rejected by the filter', { queue: 'f', jobId: 'j', reason: 'bad', reasonCode: 'E1' }]);
  });

  it('filter: reason longer than 1000 characters is truncated and details are kept', async () => {
    const details = { rows: Array.from({ length: 500 }, (_, i) => i) };
    const { q, rejected } = setup(() => ({ reject: 'r'.repeat(1500), details }));
    const e = (await caught(q.add({}))) as JobRejectedError;
    expect(e.reason).toHaveLength(1000);
    expect(rejected[0]!.reason).toHaveLength(1000);
    expect(e.details['details']).toEqual(details);
    expect('details' in rejected[0]!).toBe(false);
  });

  it('filter: a throwing rejected listener is reported and add still throws JobRejectedError', async () => {
    const { q } = setup(() => false);
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    q.on('rejected', () => {
      throw new TypeError('l');
    });
    await expect(q.add({})).rejects.toBeInstanceOf(JobRejectedError);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.source).toBe('listener');
  });

  it('filter: an add held for the store is filtered once', async () => {
    useFakeTime();
    const inner = new MemoryStore();
    const { store, ctl } = outageStore(inner);
    clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });
    const spy = vi.fn(() => true);
    const q = new Queue<Data>('h', { store, logger: silent, filter: spy, onDisconnected: 'wait' });
    queues.push(q);
    await q.ready();
    ctl.down = true;
    await q.getCounts().catch(() => {});
    const p = q.add({ a: 1 });
    await vi.advanceTimersByTimeAsync(250);
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).added).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await q.getCounts()).waiting).toBe(1);
  });

  it("filter: data passed to the filter is frozen and the caller's object is not", async () => {
    const mutate = setup((d) => {
      (d as Data)['x'] = 1;
      return true;
    });
    const input = { a: { b: 1 } };
    const e = await caught(mutate.q.add(input));
    expect(e).toBeInstanceOf(FilterError);
    expect((e as FilterError).cause).toBeInstanceOf(TypeError);
    expect(input).toEqual({ a: { b: 1 } });

    let frozen = false;
    const read = setup((d) => ((frozen = Object.isFrozen(d) && Object.isFrozen(d['a'])), true));
    const r = await read.q.add(input);
    expect(frozen).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.a)).toBe(false);
    expect((await read.q.getJob(r.job.id))?.data).toEqual({ a: { b: 1 } });
  });

  it('filter: invalid filter options throw InvalidOptionError', () => {
    const path = (opts: Record<string, unknown>) => {
      try {
        new Queue('x', { logger: silent, ...opts });
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidOptionError);
        return (e as InvalidOptionError).issues.map((i) => i.path);
      }
      return [];
    };
    expect(path({ filter: 'x' })).toEqual(['filter']);
    for (const v of [0, 1.5, 2_147_483_648]) expect(path({ filterTimeoutMs: v })).toEqual(['filterTimeoutMs']);
    expect(path({ filterTimeoutMs: 2_147_483_647 })).toEqual([]);
  });
});

describe('filter on bulk adds and merged data', () => {
  const odd = (d: Readonly<Data>) => ((d['n'] as number) % 2 === 1 ? 'odd' : true);
  const five = () => [0, 1, 2, 3, 4].map((n) => ({ data: { n } }));

  it('filter: addBulk returns the error in the rejected slot and adds the rest in order', async () => {
    const { q, rejected, waiting } = setup(odd);
    const out = await q.addBulk(five());
    expect(out.map((o) => o.ok)).toEqual([true, false, true, false, true]);
    for (const i of [1, 3]) {
      const o = out[i]!;
      expect(!o.ok && o.error).toBeInstanceOf(JobRejectedError);
      expect(!o.ok && o.error).toMatchObject({ reason: 'odd' });
    }
    expect(await waiting()).toBe(3);
    expect((await q.getJobs('waiting')).map((j) => j.data['n'])).toEqual([0, 2, 4]);
    expect(rejected).toHaveLength(2);
  });

  it('filter: addBulk atomic with one rejection stores nothing', async () => {
    const { q, calls, waiting, rejected } = setup(odd);
    const e = (await caught(q.addBulk(five(), { atomic: true }))) as BulkAddError;
    expect(e).toBeInstanceOf(BulkAddError);
    expect(e.cause).toBeInstanceOf(JobRejectedError);
    expect(e).toMatchObject({ index: 1, jobIds: [] });
    expect(calls.filter((c) => c.op === 'add')).toEqual([]);
    expect(await waiting()).toBe(0);
    expect(rejected).toHaveLength(2);
  });

  it('filter: addBulk runs at most 16 filters at once and keeps input order', async () => {
    useFakeTime();
    let inFlight = 0;
    let max = 0;
    const { q } = setup(async () => {
      max = Math.max(max, ++inFlight);
      await new Promise((r) => setTimeout(r, 3000));
      inFlight--;
      return true;
    });
    const p = q.addBulk(Array.from({ length: 40 }, (_, n) => ({ data: { n } })));
    await vi.advanceTimersByTimeAsync(9000);
    const out = await p;
    expect(max).toBe(16);
    expect(out.map((o) => (o.ok ? o.job.data['n'] : -1))).toEqual(Array.from({ length: 40 }, (_, n) => n));
  });

  /** A waiting job `m` holding `{ count: 1 }`, and a filter that refuses merged counts above 2. */
  async function holder() {
    const ops: Array<{ op: string; data: unknown }> = [];
    const s = setup((d, ctx) => (ops.push({ op: ctx.operation, data: d }), ctx.operation === 'merge' && (d['count'] as number) > 2 ? 'too many' : true));
    await s.q.add({ count: 1 }, { id: 'm' });
    const duplicates: unknown[] = [];
    s.q.on('duplicate', (e) => void duplicates.push(e));
    const onDuplicate = (j: Readonly<Job<Data>>, inc: Readonly<Data>) => ({ count: (j.data['count'] as number) + (inc['count'] as number) });
    const stored = () => s.inner.get(s.q.internals.scope, 'm');
    ops.length = 0;
    s.calls.length = 0;
    return { ...s, ops, duplicates, onDuplicate, stored, before: await stored() };
  }

  it('filter: merged data is filtered and a rejection leaves the job unchanged', async () => {
    const h = await holder();
    const e = await caught(h.q.add({ count: 5 }, { id: 'm', onDuplicate: h.onDuplicate }));
    expect(e).toBeInstanceOf(JobRejectedError);
    expect(e).toMatchObject({ operation: 'merge', jobId: 'm', reason: 'too many' });
    const after = await h.stored();
    expect(after?.data).toBe('{"count":1}');
    expect(after?.rev).toBe(h.before?.rev);
    expect(h.duplicates).toEqual([]);
    expect(h.ops).toEqual([{ op: 'add', data: { count: 5 } }, { op: 'merge', data: { count: 6 } }]);
    expect(h.rejected).toEqual([{ id: 'm', reason: 'too many', operation: 'merge' }]);
  });

  it('merge: merged data failing filter rejects add and leaves job unchanged', async () => {
    const h = await holder();
    await expect(h.q.add({ count: 5 }, { id: 'm', onDuplicate: h.onDuplicate })).rejects.toBeInstanceOf(JobRejectedError);
    const pick = (r: typeof h.before) => r && { data: r.data, rev: r.rev, attempt: r.attempt, runAt: r.runAt };
    expect(pick(await h.stored())).toEqual(pick(h.before));
    expect(h.calls.filter((c) => c.op === 'update')).toEqual([]);
    expect(h.duplicates).toEqual([]);
  });

  it('filter: atomic addBulk merge rejection writes nothing', async () => {
    const h = await holder();
    const e = (await caught(h.q.addBulk([{ data: { count: 5 }, opts: { id: 'm', onDuplicate: h.onDuplicate } }], { atomic: true }))) as BulkAddError;
    expect(e).toBeInstanceOf(BulkAddError);
    expect(e.cause).toBeInstanceOf(JobRejectedError);
    expect(h.calls.filter((c) => c.op === 'add' || c.op === 'update')).toEqual([]);
    expect(await h.stored()).toEqual(h.before);
  });

  it('filter: non-atomic addBulk merge rejection fills that slot', async () => {
    const h = await holder();
    const out = await h.q.addBulk([{ data: { count: 5 }, opts: { id: 'm', onDuplicate: h.onDuplicate } }, { data: { count: 0 } }]);
    expect(out[0]).toMatchObject({ ok: false, error: { name: 'JobRejectedError', operation: 'merge' } });
    expect(out[1]?.ok).toBe(true);
    expect((await h.stored())?.data).toBe('{"count":1}');
  });
});
