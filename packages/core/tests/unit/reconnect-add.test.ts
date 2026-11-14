import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreUnavailableError } from '../../src/errors/catalog.js';
import { resolveAmbiguousAdd } from '../../src/queue/outage.js';
import { Queue } from '../../src/queue/queue.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { clientFor } from '../../src/store/client.js';
import type { JobRecord, NewJob, Scope, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { outageStore } from '../helpers/outage.js';
import { spyStore } from '../helpers/spy-store.js';

beforeEach(() => useFakeTime());
afterEach(() => {
  vi.useRealTimers();
});

const steady = (store: Store) => clientFor(store).configure({ initialDelayMs: 100, maxDelayMs: 100, factor: 2, jitter: 0, random: () => 0.5 });

/** A queue on an outage store that is already down (the outage is known). */
async function downQueue(opts: QueueOptions = {}) {
  const inner = new MemoryStore();
  const { store, ctl } = outageStore(inner);
  steady(store);
  const q = new Queue('r', { store, logger: silent, ...opts });
  await q.ready();
  ctl.down = true;
  await q.getCounts().catch(() => {});
  ctl.calls.length = 0;
  return { inner, store, ctl, q };
}

const lost = (op: string) => new StoreUnavailableError('response lost', { operation: op, retryable: true, outcomeUnknown: true });

describe('reconnect: add during an outage', () => {
  it('reconnect: add rejects immediately in reject mode with outcomeUnknown false', async () => {
    const { q, ctl } = await downQueue();
    await expect(q.add(1)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: false });
    expect(ctl.calls.filter((c) => c.op === 'add')).toEqual([]);
    await q.close();
  });

  it('reconnect: add waits in wait mode and resolves only after the store acknowledged it', async () => {
    const { q, ctl, inner } = await downQueue({ onDisconnected: 'wait' });
    const order: string[] = [];
    let id = '';
    const p = q.add(1).then((r) => {
      id = r.job.id;
      order.push(inner.dump().jobs.some((j) => j.id === r.job.id) ? 'resolved after store' : 'resolved before store');
      return r;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual([]);
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(100);
    const r = await p;
    expect(order).toEqual(['resolved after store']);
    expect(r).toMatchObject({ added: true, job: { id, state: 'waiting' } });
    await q.close();
  });

  it('reconnect: add in wait mode rejects after maxWait', async () => {
    const { q } = await downQueue({ onDisconnected: 'wait', maxWait: 1000 });
    const p = q.add(1).catch((e: unknown) => e);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: false });
    await q.close();
  });

  it('reconnect: add in wait mode rejects when the buffer is full', async () => {
    const { q, ctl } = await downQueue({ onDisconnected: 'wait', maxBufferedAdds: 2 });
    const a = q.add('a');
    const b = q.add('b');
    await vi.advanceTimersByTimeAsync(0);
    await expect(q.add('c')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: false });
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(100);
    await expect(a).resolves.toMatchObject({ added: true });
    await expect(b).resolves.toMatchObject({ added: true });
    await q.close();
  });

  it('reconnect: buffered adds are sent in call order', async () => {
    const { q, ctl } = await downQueue({ onDisconnected: 'wait' });
    const adds = ['a', 'b', 'c'].map((d) => q.add(d));
    await vi.advanceTimersByTimeAsync(0);
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(100);
    const jobs = (await Promise.all(adds)).map((r) => r.job);
    expect(jobs.map((j) => j.data)).toEqual(['a', 'b', 'c']);
    const listed = await q.getJobs('waiting');
    expect(listed.map((j) => j.data)).toEqual(['a', 'b', 'c']);
    await q.close();

    // An addBulk takes more steps before its write than a single add; the later add still goes after it.
    const mixed = await downQueue({ onDisconnected: 'wait' });
    const bulk = mixed.q.addBulk([1, 2, 3, 4, 5].map((n) => ({ data: `bulk${n}` })));
    const single = mixed.q.add('single');
    await vi.advanceTimersByTimeAsync(0);
    mixed.ctl.down = false;
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([bulk, single]);
    expect((await mixed.q.getJobs('waiting')).map((j) => j.data)).toEqual(['bulk1', 'bulk2', 'bulk3', 'bulk4', 'bulk5', 'single']);
    await mixed.q.close();
  });

  it('reconnect: buffered adds are sent in call order with a filter configured', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const filters: Array<[string, NonNullable<QueueOptions['filter']>]> = [
      ['sync', () => true],
      ['async', async () => true],
      ['slow first', async (d) => (await delay(d === 'a' || d === 'bulk1' ? 300 : 10), true)],
    ];
    for (const [label, filter] of filters) {
      const singles = await downQueue({ onDisconnected: 'wait', filter });
      const adds = ['a', 'b', 'c'].map((d) => singles.q.add(d));
      await vi.advanceTimersByTimeAsync(0);
      singles.ctl.down = false;
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all(adds);
      expect((await singles.q.getJobs('waiting')).map((j) => j.data), label).toEqual(['a', 'b', 'c']);
      await singles.q.close();

      const mixed = await downQueue({ onDisconnected: 'wait', filter });
      const bulk = mixed.q.addBulk([1, 2, 3].map((n) => ({ data: `bulk${n}` })));
      const single = mixed.q.add('single');
      await vi.advanceTimersByTimeAsync(0);
      mixed.ctl.down = false;
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([bulk, single]);
      expect((await mixed.q.getJobs('waiting')).map((j) => j.data), label).toEqual(['bulk1', 'bulk2', 'bulk3', 'single']);
      await mixed.q.close();
    }
  });

  it('reconnect: a connected add does not wait for a slower filter of an earlier add', async () => {
    const q = new Queue('c', { logger: silent, filter: (d) => (d === 'slow' ? new Promise((r) => setTimeout(() => r(true), 1000)) : true) });
    const order: string[] = [];
    const slow = q.add('slow').then(() => order.push('slow'));
    const fast = q.add('fast').then(() => order.push('fast'));
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(['fast']);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([slow, fast]);
    expect(order).toEqual(['fast', 'slow']);
    await q.close();
  });

  /** Down queue whose store drops again on the third `now` after it comes back (probe, first add, second add). */
  async function dropMidDrain(opts: QueueOptions) {
    const d = await downQueue({ onDisconnected: 'wait', ...opts });
    let nows = 0;
    let armed = false;
    d.ctl.failing = (op) => {
      if (armed && !d.ctl.down && op === 'now' && ++nows === 3) {
        d.ctl.down = true;
        armed = false;
      }
      return d.ctl.down;
    };
    const recover = () => {
      armed = true;
      d.ctl.down = false;
    };
    return { ...d, recover };
  }

  it('reconnect: a drop during the drain keeps the unsent adds in call order for the next reconnect', async () => {
    const { q, ctl, recover } = await dropMidDrain({ maxBufferedAdds: 4 });
    const adds = ['a', 'b', 'c', 'd'].map((d) => q.add(d));
    await vi.advanceTimersByTimeAsync(0);
    recover();
    await vi.advanceTimersByTimeAsync(100); // a lands, the store drops while b is prepared
    expect(q.connectionState).toBe('reconnecting');
    expect(q.internals.addGate.buffered).toBe(3);
    // New adds during the stall follow the buffer rules: one more fits, the next is refused.
    const e = q.add('e');
    await expect(q.add('f')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: false, message: expect.stringContaining('maxBufferedAdds') });
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([...adds, e]);
    expect((await q.getJobs('waiting')).map((j) => j.data)).toEqual(['a', 'b', 'c', 'd', 'e']);
    await q.close();
  });

  it('reconnect: adds behind a drain stalled by a drop still reject at maxWait', async () => {
    const { q, recover } = await dropMidDrain({ maxWait: 1000 });
    const adds = ['a', 'b', 'c'].map((d) => q.add(d).catch((x: unknown) => x));
    await vi.advanceTimersByTimeAsync(0);
    recover();
    await vi.advanceTimersByTimeAsync(100);
    expect(q.internals.addGate.buffered).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    const [a, b, c] = await Promise.all(adds);
    expect(a).toMatchObject({ added: true });
    for (const r of [b, c]) expect(r).toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: false, message: expect.stringContaining('maxWait') });
    expect(q.internals.addGate.buffered).toBe(0);
    await q.close();
  });

  it("reconnect: a drain stalled by a drop keeps each held add's original maxWait deadline", async () => {
    const { q, recover } = await dropMidDrain({ maxWait: 1000 });
    const start = performance.now();
    const settled: unknown[] = [];
    const adds = ['a', 'b', 'c'].map((d, i) => q.add(d).catch((x: unknown) => x).then((r) => (settled[i] = r)));
    await vi.advanceTimersByTimeAsync(600);
    recover();
    await vi.advanceTimersByTimeAsync(100); // a lands, the store drops again; b and c are held again
    expect(q.internals.addGate.buffered).toBe(2);
    await vi.advanceTimersByTimeAsync(start + 1000 - performance.now());
    expect(settled.filter((r) => r !== undefined)).toHaveLength(3);
    const [a, b, c] = await Promise.all(adds);
    expect(a).toMatchObject({ added: true });
    for (const r of [b, c]) expect(r).toMatchObject({ code: 'STORE_UNAVAILABLE', message: expect.stringContaining('maxWait') });
    await q.close();
  });

  it('reconnect: addBulk with invalid options is decided at once during an outage', async () => {
    const { q, ctl } = await downQueue({ onDisconnected: 'wait' });
    const bad = { data: 1, opts: { priority: 1.5 } };
    await expect(q.addBulk([{ data: 0 }, bad], { atomic: true })).rejects.toMatchObject({ code: 'BULK_ADD_FAILED', index: 1, cause: { code: 'INVALID_OPTION' } });
    const out = await q.addBulk([bad, bad]);
    expect(out.map((o) => !o.ok && o.error.code)).toEqual(['INVALID_OPTION', 'INVALID_OPTION']);
    expect(q.internals.addGate.buffered).toBe(0);
    expect(ctl.calls).toEqual([]);
    await q.close();
  });

  it('reconnect: an add with invalid options fails with InvalidOptionError at once during an outage', async () => {
    const { q, ctl } = await downQueue({ onDisconnected: 'wait' });
    await expect(q.add(1, { priority: 1.5 })).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    await expect(q.add(1, { delay: '1s', runAt: 5 })).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    expect(q.internals.addGate.buffered).toBe(0);
    expect(ctl.calls).toEqual([]);
    await q.close();
  });

  it('reconnect: add before the first successful connect follows onDisconnected (default reject)', async () => {
    const make = (opts: QueueOptions) => {
      const raw = new MemoryStore();
      let up = false;
      const { store } = spyStore(raw, { open: () => (up ? raw.open() : Promise.reject(new TypeError('no route'))) });
      steady(store);
      return { q: new Queue('r', { store, logger: silent, ...opts }), comeUp: () => (up = true) };
    };
    const rejecting = make({});
    await expect(rejecting.q.add(1)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: false });
    await rejecting.q.close();

    const waiting = make({ onDisconnected: 'wait' });
    const p = waiting.q.add(1);
    await vi.advanceTimersByTimeAsync(50);
    waiting.comeUp();
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toMatchObject({ added: true });
    await waiting.q.close();
  });

  it('reconnect: add already sent with a generated id is retried and resolves added true', async () => {
    const raw = new MemoryStore();
    let lose = 1;
    const { store, calls } = spyStore(raw, {
      add: async (s: Scope, jobs: NewJob[], o?: { atomic?: boolean }) => {
        const r = await raw.add(s, jobs, o);
        if (lose-- > 0) throw lost('add');
        return r;
      },
    });
    steady(store);
    const q = new Queue('r', { store, logger: silent });
    const p = q.add({ n: 1 });
    await vi.advanceTimersByTimeAsync(100);
    const r = await p;
    expect(r).toMatchObject({ added: true, job: { data: { n: 1 } } });
    expect(raw.dump().jobs).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'add')).toHaveLength(1);
    await q.close();
  });

  it('reconnect: add retry finds a finished job with the generated id via get and resolves added true without a second insert', async () => {
    const raw = new MemoryStore();
    const scope: Scope = { namespace: 'default', queue: 'r' };
    let lose = 1;
    const { store, calls } = spyStore(raw, {
      add: async (s: Scope, jobs: NewJob[], o?: { atomic?: boolean }) => {
        const r = await raw.add(s, jobs, o);
        if (lose-- > 0) {
          // The job runs to the end before the add's caller hears back.
          const [claimed] = (await raw.claim(scope, { workerId: 'w', limit: 1, leaseMs: 30_000, claimId: 'c1' })).jobs;
          await raw.complete(scope, { id: claimed!.id, token: claimed!.lease!.token, result: null });
          throw lost('add');
        }
        return r;
      },
    });
    steady(store);
    const q = new Queue('r', { store, logger: silent });
    const p = q.add(1);
    await vi.advanceTimersByTimeAsync(100);
    const r = await p;
    expect(r).toMatchObject({ added: true, job: { state: 'completed' } });
    expect(calls.filter((c) => c.op === 'add')).toHaveLength(1);
    await q.close();
  });

  it('reconnect: duplicate by singletonKey on a retry is not inferred as the earlier attempt', async () => {
    const other = { id: 'someone-else' } as JobRecord;
    const dup = { status: 'duplicate', action: 'ignored', by: 'singletonKey', existingState: 'waiting', job: other } as const;
    const out = await resolveAmbiguousAdd({ get: async () => null, send: async () => dup }, 'mine', true, lost('add'));
    expect(out).toBe(dup);
  });

  it('reconnect: duplicate whose existing id differs from the generated id is not inferred', async () => {
    const dup = { status: 'duplicate', action: 'ignored', by: 'id', existingState: 'waiting', job: { id: 'other' } as JobRecord } as const;
    expect(await resolveAmbiguousAdd({ get: async () => null, send: async () => dup }, 'mine', true, lost('add'))).toBe(dup);
    const same = { ...dup, job: { id: 'mine' } as JobRecord };
    expect(await resolveAmbiguousAdd({ get: async () => null, send: async () => same }, 'mine', true, lost('add'))).toEqual({ status: 'added', job: same.job });
  });

  it('reconnect: add already sent with a caller id rejects with outcomeUnknown true', async () => {
    const original = lost('add');
    const get = vi.fn();
    await expect(resolveAmbiguousAdd({ get, send: vi.fn() }, 'callers-id', false, original)).rejects.toBe(original);
    expect(original.outcomeUnknown).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('reconnect: an ambiguous add with a caller id whose first write landed is not sent again', async () => {
    for (const id of ['mine', (d: { n: number }) => `job-${d.n}`]) {
      const raw = new MemoryStore();
      let lose = 1;
      const { store, calls } = spyStore(raw, {
        add: async (s: Scope, jobs: NewJob[], o?: { atomic?: boolean }) => {
          const r = await raw.add(s, jobs, o);
          if (lose-- > 0) throw lost('add');
          return r;
        },
      });
      steady(store);
      const merge = vi.fn((existing: Readonly<{ data: { n: number } }>) => existing.data);
      const q = new Queue<{ n: number }>('r', { store, logger: silent, onDuplicate: merge });
      const events: string[] = [];
      q.on('duplicate', () => void events.push('duplicate'));
      q.on('added', () => void events.push('added'));
      const idFn = vi.fn(typeof id === 'function' ? id : () => id);
      const want = typeof id === 'function' ? 'job-1' : 'mine';
      const p = q.add({ n: 1 }, { id: typeof id === 'function' ? idFn : id }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: true, jobIds: [want] });
      expect(calls.filter((c) => c.op === 'add')).toHaveLength(1);
      expect(calls.filter((c) => c.op === 'get')).toEqual([]);
      expect(merge).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(raw.dump().jobs.map((j) => j.id)).toEqual([want]);
      if (typeof id === 'function') expect(idFn).toHaveBeenCalledTimes(1);
      await q.close();
    }
  });

  it('reconnect: a buffered atomic addBulk calls its id and merge functions once per input across the resend', async () => {
    const { store, ctl } = outageStore();
    steady(store);
    const merge = vi.fn((existing: Readonly<{ data: { n: number } }>, incoming: Readonly<{ n: number }>) => ({ n: existing.data.n + incoming.n }));
    const q = new Queue<{ n: number }>('r', { store, logger: silent, onDisconnected: 'wait', onDuplicate: merge });
    await q.add({ n: 1 }, { id: 'a' });
    const idFn = vi.fn(() => 'a');
    let failGet = 1;
    // the dry merge's read of the stored job fails before anything is written
    ctl.failing = (op) => ctl.down || (op === 'get' && failGet-- > 0);
    const p = q.addBulk([{ data: { n: 2 }, opts: { id: idFn } }], { atomic: true });
    await vi.advanceTimersByTimeAsync(100);
    const [out] = await p;
    expect(out).toMatchObject({ ok: true, added: false, duplicate: { action: 'merged' }, job: { id: 'a', data: { n: 3 } } });
    expect(idFn).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledTimes(1);
    expect((await q.getJob('a'))?.data).toEqual({ n: 3 });
    await q.close();
  });

  it('reconnect: a resend that meets another job holding the singletonKey is a normal duplicate result', async () => {
    for (const onDuplicate of ['ignore', 'reject'] as const) {
      const raw = new MemoryStore();
      const scope: Scope = { namespace: 'default', queue: 'r' };
      let lose = 1;
      const { store } = spyStore(raw, {
        add: async (s: Scope, jobs: NewJob[], o?: { atomic?: boolean }) => {
          if (lose-- > 0) {
            // ours never landed; meanwhile another producer took the key
            await raw.add(scope, [{ id: 'other', data: '1', formatVersion: 1, maxAttempts: 3, singletonKey: 'k' }]);
            throw lost('add');
          }
          return raw.add(s, jobs, o);
        },
      });
      steady(store);
      const q = new Queue('r', { store, logger: silent, onDuplicate });
      const p = q.add(2, { singletonKey: 'k' }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      const r = await p;
      if (onDuplicate === 'ignore') {
        expect(r).toMatchObject({ added: false, job: { id: 'other' }, duplicate: { action: 'ignored', by: 'singletonKey', existingState: 'waiting' } });
      } else {
        expect(r).toMatchObject({ code: 'DUPLICATE_JOB', jobId: 'other', by: 'singletonKey' });
      }
      expect(raw.dump().jobs.map((j) => j.id)).toEqual(['other']);
      await q.close();
    }
  });

  it('reconnect: an ambiguous add rejects with the original error and its job id when the store stays away past maxWait', async () => {
    const { store, ctl } = outageStore();
    steady(store);
    const q = new Queue('r', { store, logger: silent, maxWait: 1000 });
    await q.ready();
    ctl.failing = (op) => ctl.down || op === 'add';
    ctl.down = false;
    const p = q.add(1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    ctl.down = true;
    await vi.advanceTimersByTimeAsync(1000);
    const e = (await p) as StoreUnavailableError;
    expect(e).toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: true, operation: 'add' });
    expect(e.jobIds).toHaveLength(1);
    await q.close();
  });

  it('reconnect: a held add whose drain send has an unknown outcome is settled by id, not sent blindly again', async () => {
    const raw = new MemoryStore();
    let lose = false;
    const wrapped = spyStore(raw, {
      add: async (sc: Scope, jobs: NewJob[], o?: { atomic?: boolean }) => {
        const r = await raw.add(sc, jobs, o);
        if (lose) {
          lose = false;
          throw lost('add');
        }
        return r;
      },
    });
    const { store, ctl } = outageStore(wrapped.store);
    steady(store);
    const q = new Queue('r', { store, logger: silent, onDisconnected: 'wait' });
    await q.ready();
    ctl.down = true;
    await q.getCounts().catch(() => {});
    const a = q.add('a');
    const b = q.add('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(q.internals.addGate.buffered).toBe(2);
    lose = true;
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(await a).toMatchObject({ added: true, job: { data: 'a' } });
    expect(await b).toMatchObject({ added: true, job: { data: 'b' } });
    expect(raw.dump().jobs.map((j) => JSON.parse(j.data as string) as unknown)).toEqual(['a', 'b']);
    // a: one write (its outcome lost), then a read by id instead of a second write
    expect(wrapped.calls.filter((c) => c.op === 'add')).toHaveLength(2);
    expect(wrapped.calls.filter((c) => c.op === 'get')).toHaveLength(1);
    await q.close();
  });

  it('reconnect: addBulk during an outage is buffered or rejected as a whole', async () => {
    const { q, ctl } = await downQueue({ onDisconnected: 'wait', maxBufferedAdds: 1 });
    const items = [1, 2, 3, 4, 5].map((data) => ({ data }));
    const bulk = q.addBulk(items);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.internals.addGate.buffered).toBe(1);
    await expect(q.addBulk(items)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: false });
    ctl.down = false;
    await vi.advanceTimersByTimeAsync(100);
    const out = await bulk;
    expect(out.map((o) => o.ok)).toEqual([true, true, true, true, true]);
    expect((await q.getCounts()).waiting).toBe(5);
    await q.close();

    const rejecting = await downQueue();
    await expect(rejecting.q.addBulk(items)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', outcomeUnknown: false });
    expect((await rejecting.inner.counts({ namespace: 'default', queue: 'r' })).waiting).toBe(0);
    await rejecting.q.close();
  });

  it('reconnect: close aborts pending waiting adds with QueueClosedError', async () => {
    const { q } = await downQueue({ onDisconnected: 'wait' });
    const a = q.add('a').catch((e: unknown) => e);
    const b = q.add('b').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.internals.addGate.buffered).toBe(2);
    await q.close();
    expect(await a).toMatchObject({ code: 'QUEUE_CLOSED' });
    expect(await b).toMatchObject({ code: 'QUEUE_CLOSED' });
    expect(q.internals.addGate.buffered).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconnect: close during the drain lets the add already sent settle from the store, and refuses only the unsent ones', async () => {
    const inner = new MemoryStore();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let holdNext = false;
    // the first add sent after the store is back waits on `held`
    const gated = new Proxy(inner, {
      get(target, prop) {
        const v: unknown = Reflect.get(target, prop, target);
        if (typeof v !== 'function') return v;
        if (prop !== 'add') return v.bind(target);
        return async (...args: unknown[]) => {
          if (holdNext) {
            holdNext = false;
            await held;
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const { store, ctl } = outageStore(gated);
    steady(store);
    const q = new Queue('r', { store, logger: silent, onDisconnected: 'wait' });
    await q.ready();
    ctl.down = true;
    await q.getCounts().catch(() => {});
    const sent = q.add('a').then((r) => r.job.id, (e: unknown) => e);
    const unsent = q.add('b').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    holdNext = true;
    ctl.down = false;
    // the probe at 100 ms reconnects and the drain sends 'a', which is held
    await vi.advanceTimersByTimeAsync(150);
    const closing = q.close();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(10);
    await closing;
    expect(await unsent).toMatchObject({ code: 'QUEUE_CLOSED' });
    const id = await sent;
    expect(typeof id).toBe('string');
    expect(inner.dump().jobs.map((j) => j.id)).toEqual([id]);
  });
});
