import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidOptionError, StoreRequestError } from '../../src/errors/catalog.js';
import type { NewSchedule, Store } from '../../src/store/contract.js';
import type { StoreOp } from '../../src/store/memory/hooks.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';

type Opts = ConstructorParameters<typeof MemoryStore>[0];
const openStore = async (opts?: Opts) => {
  const store = new MemoryStore(opts);
  await store.open();
  return store;
};
const fakeClock = (start = 1000) => {
  const c = { t: start };
  return { c, clock: () => c.t };
};
const source = () =>
  readFileSync(join(import.meta.dirname, '../../src/store/memory/memory-store.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

describe('memstore (shell)', () => {
  it('contract: store exposes integer contractVersion and frozen capabilities', () => {
    const store = new MemoryStore();
    expect(store.contractVersion).toBe(1);
    expect(Number.isInteger(store.contractVersion)).toBe(true);
    expect(Object.isFrozen(store.capabilities)).toBe(true);
    expect(store.capabilities).toMatchObject({
      transactions: true, skipLocked: true, notify: true, ttl: false, durable: false, shared: false,
    });
    expect(store.capabilities.limits).toEqual({ maxIdBytes: 255, maxClaimLimit: 1000 });
  });

  it('contract: open and close are idempotent', async () => {
    const { c, clock } = fakeClock(1000);
    const store = new MemoryStore({ clock });
    await store.open();
    await store.open();
    expect(await store.now()).toBe(1000);
    await store.close();
    await store.close();
    await expect(store.now()).rejects.toBeInstanceOf(StoreRequestError);
    c.t = 2000;
    await store.open();
    expect(await store.now()).toBe(2000);
  });

  it('contract: calls before open or after close throw StoreRequestError', async () => {
    const scope = { namespace: 'n', queue: 'q' };
    const job = { id: 'a', data: '', formatVersion: 1, maxAttempts: 1 };
    const calls: Array<[string, (s: MemoryStore) => Promise<unknown>]> = [
      ['now', (s) => s.now()],
      ['add', (s) => s.add(scope, [job])],
      ['claim', (s) => s.claim(scope, { workerId: 'w', limit: 1, leaseMs: 1000, claimId: 'c' })],
      ['renew', (s) => s.renew(scope, { id: 'a', token: 1, leaseMs: 1000 })],
      ['complete', (s) => s.complete(scope, { id: 'a', token: 1, result: null })],
      ['release', (s) => s.release(scope, { id: 'a', token: 1, refundAttempt: false, handlerStarted: false })],
      ['sweep', (s) => s.sweep(scope, { limit: 1, maxCrashes: 1, failError: 'f', poisonError: 'p' })],
      ['subscribe', (s) => s.subscribe(scope, () => {})],
      ['fail', (s) => s.fail(scope, { id: 'a', token: 1, error: 'e' })],
      ['cancel', (s) => s.cancel(scope, { id: 'a' })],
      ['remove', (s) => s.remove(scope, { id: 'a' })],
      ['update', (s) => s.update(scope, { id: 'a', expectedRev: 1, patch: { priority: 1 } })],
      ['get', (s) => s.get(scope, 'a')],
      ['list', (s) => s.list(scope, { state: 'waiting', offset: 0, limit: 1, order: 'asc' })],
      ['counts', (s) => s.counts(scope)],
      ['setPaused', (s) => s.setPaused(scope, true)],
      ['isPaused', (s) => s.isPaused(scope)],
    ];
    const never = new MemoryStore();
    const closed = await openStore();
    await closed.add(scope, [job]);
    await closed.close();
    const before = closed.dump();
    for (const [op, call] of calls) {
      for (const store of [never, closed]) {
        const err = await call(store).then(() => undefined, (e: unknown) => e);
        expect(err, op).toBeInstanceOf(StoreRequestError);
        expect((err as StoreRequestError).operation, op).toBe(op);
      }
    }
    expect(never.dump()).toEqual({ meta: {}, jobs: [], attempts: [], tombstones: [], schedules: [] });
    expect(closed.dump()).toEqual(before);
  });

  it('memstore: methods are async and resolve after a microtask', async () => {
    const store = await openStore();
    let syncFlag = false;
    let seenAtThen = false;
    const p = store.now();
    expect(p).toBeInstanceOf(Promise);
    const done = p.then(() => {
      seenAtThen = syncFlag;
    });
    syncFlag = true;
    await done;
    expect(seenAtThen).toBe(true);
  });

  it('memstore: backwards clock is clamped to the previous timestamp', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    expect(await store.now()).toBe(1000);
    c.t = 400;
    expect(await store.now()).toBe(1000);
    c.t = 1500;
    expect(await store.now()).toBe(1500);
  });

  it('clock: now returns an integer that never decreases across calls', async () => {
    const times = [1000.7, 1000.2, 1500.9];
    const store = await openStore({ clock: () => times.shift()! });
    expect([await store.now(), await store.now(), await store.now()]).toEqual([1000, 1000, 1500]);
  });

  it('memstore: finalsTtl accepts a duration', () => {
    expect(() => new MemoryStore({ finalsTtl: '10m' })).not.toThrow();
    expect(() => new MemoryStore({ finalsTtl: 1000 })).not.toThrow();
    expect(() => new MemoryStore({ finalsTtl: 'abc' as '1m' })).toThrow(InvalidOptionError);
  });

  it('memstore: fault hooks inject errors without corrupting state', async () => {
    let failBefore = true;
    const closed = new MemoryStore({
      faults: {
        before: (op) => {
          if (op === 'open' && failBefore) throw new TypeError('injected');
        },
      },
    });
    await expect(closed.open()).rejects.toThrow('injected');
    await expect(closed.now()).rejects.toBeInstanceOf(StoreRequestError);
    failBefore = false;
    await closed.open();
    await expect(closed.now()).resolves.toBeTypeOf('number');

    const opened = new MemoryStore({
      faults: {
        after: (op) => {
          if (op === 'open') throw new TypeError('lost reply');
        },
      },
    });
    await expect(opened.open()).rejects.toThrow('lost reply');
    await expect(opened.now()).resolves.toBeTypeOf('number');

    let delayMs = 0;
    const slow = await openStore({
      clock: () => 5000,
      faults: { before: async () => void (delayMs && (await new Promise((r) => setTimeout(r, delayMs)))) },
    });
    delayMs = 20;
    const start = performance.now();
    expect(await slow.now()).toBe(5000);
    expect(performance.now() - start).toBeGreaterThanOrEqual(15);
    expect(slow.dump()).toEqual({ meta: {}, jobs: [], attempts: [], tombstones: [], schedules: [] });
  });

  it('memstore: operations contain no await between read and write', () => {
    const src = source();
    const runStart = src.indexOf('async #run');
    expect(runStart).toBeGreaterThan(-1);
    let depth = 0;
    let runEnd = -1;
    for (let i = src.indexOf('{', runStart); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        runEnd = i;
        break;
      }
    }
    for (const m of src.matchAll(/\bawait\b/g)) {
      const at = m.index ?? -1;
      expect(at > runStart && at < runEnd, `await at ${at} outside #run`).toBe(true);
    }
    // Every other async method is a one-statement wrapper around #run.
    const methods = [...src.matchAll(/async (\w+)\(([\s\S]*?)\)\s*:\s*Promise<[\s\S]*?>\s*\{\s*([^\n]*)/g)];
    expect(methods.length).toBeGreaterThanOrEqual(3);
    for (const m of methods) expect(m[3]!.trim(), m[1]).toMatch(/^return this\.#run\(/);
  });

  it('memstore: exposes exactly the contract methods plus subscribe', () => {
    const own = Object.getOwnPropertyNames(MemoryStore.prototype).filter((n) => !['constructor', 'dump', 'unsafeMutate'].includes(n));
    const contract: Array<keyof Store> = [
      'open', 'close', 'now', 'add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'get',
      'list', 'counts', 'setPaused', 'isPaused', 'stats', 'getAttempts', 'clean', 'obliterate', 'redrive', 'setProgress',
      'registerWorker', 'heartbeatWorker', 'unregisterWorker', 'listWorkers', 'purgeWorkers', 'ensureNamespaceMeta', 'getNamespaceMeta',
      'putSchedule', 'getSchedule', 'listSchedules', 'deleteSchedule', 'listDueSchedules', 'fireSchedule',
    ];
    expect(own.sort()).toEqual([...contract, 'subscribe'].sort());
    expect(new MemoryStore().capabilities.notify).toBe(true);
  });

  it('memstore: fault hooks cover every contract method', async () => {
    const scope = { namespace: 'n', queue: 'q' };
    const schedule = (key: string): NewSchedule => ({
      formatVersion: 1, key, kind: 'every', everyMs: 1000, anchorAt: 0, template: { name: null, data: '{}', opts: {} }, overlap: 'skip', maxQueued: 10,
      paused: false, nextRunAt: 1000, lastFiredFor: null, lastJobId: null, queuedTicks: [], runCount: 0, definitionHash: 'h', definitionVersion: 0,
    });
    type Call = (s: MemoryStore, token: number, c: { t: number }) => Promise<unknown>;
    const calls: Array<[StoreOp, Call, boolean]> = [
      ['open', (s) => s.open(), false],
      ['close', (s) => s.close(), false],
      ['now', (s) => s.now(), false],
      ['add', (s) => s.add(scope, [{ id: 'new', data: '', formatVersion: 1, maxAttempts: 1 }]), true],
      ['claim', (s) => s.claim(scope, { workerId: 'w', limit: 1, leaseMs: 1000, claimId: 'c2' }), true],
      ['renew', (s, t) => s.renew(scope, { id: 'a', token: t, leaseMs: 5000 }), true],
      ['complete', (s, t) => s.complete(scope, { id: 'a', token: t, result: null }), true],
      ['fail', (s, t) => s.fail(scope, { id: 'a', token: t, error: 'e' }), true],
      ['release', (s, t) => s.release(scope, { id: 'a', token: t, refundAttempt: false, handlerStarted: false }), true],
      ['sweep', (s, _t, c) => ((c.t = 5000), s.sweep(scope, { limit: 1, maxCrashes: 3, failError: 'f', poisonError: 'p' })), true],
      ['cancel', (s) => s.cancel(scope, { id: 'w' }), true],
      ['remove', (s) => s.remove(scope, { id: 'w' }), true],
      ['update', (s) => s.update(scope, { id: 'w', expectedRev: 1, patch: { priority: 3 } }), true],
      ['get', (s) => s.get(scope, 'a'), false],
      ['list', (s) => s.list(scope, { state: 'waiting', offset: 0, limit: 5, order: 'asc' }), false],
      ['counts', (s) => s.counts(scope), false],
      ['setPaused', (s) => s.setPaused(scope, true), true],
      ['isPaused', (s) => s.isPaused(scope), false],
      ['stats', (s) => s.stats(scope, {}), false],
      ['subscribe', (s) => s.subscribe(scope, () => {}), false],
      ['putSchedule', (s) => s.putSchedule(scope, { schedule: schedule('s2'), expectedRev: null }), true],
      ['getSchedule', (s) => s.getSchedule(scope, { key: 's1' }), false],
      ['listSchedules', (s) => s.listSchedules(scope, { limit: 5 }), false],
      ['deleteSchedule', (s) => s.deleteSchedule(scope, { key: 's1' }), true],
      ['ensureNamespaceMeta', (s) => s.ensureNamespaceMeta({ namespace: 'n' }, { current: 1, minReadable: 1, maxReadable: 1, sureqVersion: 'x' }), true],
      ['getNamespaceMeta', (s) => s.getNamespaceMeta({ namespace: 'n' }), false],
      ['getAttempts', (s) => s.getAttempts(scope, { id: 'a' }), false],
      ['redrive', (s) => s.redrive(scope, { ids: ['f'], limit: 1 }), true],
      ['listDueSchedules', (s) => s.listDueSchedules(scope, { limit: 5 }), false],
      ['fireSchedule', (s) => s.fireSchedule(scope, {
        key: 's1', expectedRev: 1, mode: 'tick', nextRunAt: 2000, job: { id: 'sched:s1:1000', data: '', formatVersion: 1, maxAttempts: 1, runAt: 1000 },
      }), true],
      ['setProgress', (s, t) => s.setProgress(scope, { id: 'a', token: t, progress: 'p' }), true],
      ['clean', (s) => s.clean(scope, { state: 'waiting', limit: 5 }), true],
      ['obliterate', (s) => s.obliterate(scope, { force: true, limit: 5 }), true],
    ];
    const marker = new TypeError('injected');
    const make = async (phase: 'before' | 'after', target: StoreOp) => {
      const seen: StoreOp[] = [];
      let armed = false;
      const c = { t: 1000 };
      const hook = (op: StoreOp) => {
        if (!armed) return;
        seen.push(op);
        if (op === target) throw marker;
      };
      const store = new MemoryStore({ clock: () => c.t, faults: { [phase]: hook } });
      await store.open();
      await store.add(scope, [{ id: 'a', data: '', formatVersion: 1, maxAttempts: 3 }, { id: 'w', data: '', formatVersion: 1, maxAttempts: 3 }]);
      await store.putSchedule(scope, { schedule: schedule('s1'), expectedRev: null });
      const [job] = (await store.claim(scope, { workerId: 'w', limit: 1, leaseMs: 1000, claimId: 'c1' })).jobs;
      // a failed job for redrive; its higher priority makes this claim take it
      await store.add(scope, [{ id: 'f', data: '', formatVersion: 1, maxAttempts: 1, priority: 1 }]);
      const [f] = (await store.claim(scope, { workerId: 'w', limit: 1, leaseMs: 1000, claimId: 'c0' })).jobs;
      await store.fail(scope, { id: 'f', token: f!.token, error: 'e', deadLetter: {} });
      armed = true;
      return { store, seen, token: job!.token, c };
    };
    for (const [op, call, write] of calls) {
      const b = await make('before', op);
      const before = b.store.dump();
      await expect(call(b.store, b.token, b.c), op).rejects.toBe(marker);
      expect(b.seen, op).toEqual([op]);
      expect(b.store.dump(), op).toEqual(before);
      if (op === 'setPaused') expect(await b.store.isPaused(scope)).toBe(false);
      if (!write) continue;
      const a = await make('after', op);
      const prior = a.store.dump();
      await expect(call(a.store, a.token, a.c), op).rejects.toBe(marker);
      if (op === 'setPaused') expect(await a.store.isPaused(scope)).toBe(true);
      else expect(a.store.dump(), op).not.toEqual(prior);
    }
  });

  it('clock: store follows the injected test clock', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    const scope = { namespace: 'n', queue: 'q' };
    await store.add(scope, [{ id: 'a', data: '', formatVersion: 1, maxAttempts: 3 }, { id: 'd', data: '', formatVersion: 1, maxAttempts: 3, delayMs: 500 }]);
    const [a] = (await store.claim(scope, { workerId: 'w', limit: 1, leaseMs: 500, claimId: 'c' })).jobs;
    expect((await store.get(scope, 'd'))!.state).toBe('delayed');
    c.t = 1500;
    expect(await store.now()).toBe(1500);
    expect((await store.get(scope, 'd'))!.state).toBe('waiting');
    expect(await store.renew(scope, { id: 'a', token: a!.token, leaseMs: 1 })).toEqual({ ok: false, reason: 'expired' });
    expect((await store.sweep(scope, { limit: 5, maxCrashes: 3, failError: 'f', poisonError: 'p' })).swept.map((j) => j.id)).toEqual(['a']);
  });

  it('clock: memory store never reads Date.now outside its default clock', () => {
    const dir = join(import.meta.dirname, '../../src/store/memory');
    let dateNow = 0;
    for (const file of readdirSync(dir)) {
      const src = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/new Date|performance\.now|setTimeout/);
      const n = src.match(/Date\.now/g)?.length ?? 0;
      if (n) expect(file).toBe('memory-store.ts');
      dateNow += n;
    }
    expect(dateNow).toBe(1);
    expect(source()).toMatch(/opts\.clock \?\? Date\.now/);
  });

  it('memstore: the shell reads no wall clock except the default', () => {
    const src = source();
    expect(src).not.toMatch(/new Date|performance\.now|setTimeout/);
    expect(src.match(/Date\.now/g)).toHaveLength(1);
    expect(src).toMatch(/opts\.clock \?\? Date\.now/);
  });
});
