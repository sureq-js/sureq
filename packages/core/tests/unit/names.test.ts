import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { validateJobName } from '../../src/queue/options.js';
import { DuplicateHandlerError, InvalidOptionError } from '../../src/errors/catalog.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const queues: Queue[] = [];
const setup = () => {
  const store = new MemoryStore();
  const q = new Queue('names', { store, logger: silent });
  queues.push(q);
  return { store, q, scope: q.internals.scope };
};

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
});

describe('job names', () => {
  it('names: validateJobName accepts the job-name charset and rejects the rest', () => {
    for (const ok of ['email:send', 'a/b.c_d-E', 'a'.repeat(128)]) expect(validateJobName(ok, 'name')).toBe(ok);
    for (const bad of ['', 'a b', '*', 'é', 'a'.repeat(129), 5, null]) {
      try {
        validateJobName(bad, 'handlers.x');
        expect.unreachable(String(bad));
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidOptionError);
        expect((e as InvalidOptionError).issues).toMatchObject([{ path: 'handlers.x' }]);
      }
    }
  });

  it('names: add with name stores it and job.name returns it', async () => {
    const { store, q, scope } = setup();
    const { job } = await q.add({ to: 'a' }, { name: 'send-email' });
    expect(job.name).toBe('send-email');
    expect((await stored(store, scope, job.id))!.name).toBe('send-email');
    expect((await q.add(1)).job.name).toBeNull();
  });

  it('names: invalid name throws InvalidOptionError without a store call', async () => {
    const { store, q } = setup();
    const add = vi.spyOn(store, 'add');
    for (const name of ['', 'a b', '*', 'é', 'a'.repeat(129)]) {
      const e = await q.add(1, { name }).then(() => expect.unreachable(name), (x: unknown) => x);
      expect(e, name).toBeInstanceOf(InvalidOptionError);
      expect((e as InvalidOptionError).issues[0]!.path).toBe('name');
    }
    expect(add).not.toHaveBeenCalled();
    for (const name of ['email:send', 'a/b.c_d-E', 'a'.repeat(128)]) await expect(q.add(1, { name })).resolves.toBeDefined();
  });

  it('names: addBulk keeps per-input names', async () => {
    const { q } = setup();
    const out = await q.addBulk([
      { data: 1, opts: { name: 'a' } },
      { data: 2, opts: { name: 'b' } },
      { data: 3, opts: { name: 'bad name' } },
    ]);
    expect(out.map((o) => (o.ok ? o.job.name : null))).toEqual(['a', 'b', null]);
    expect(!out[2]!.ok && out[2]!.error).toBeInstanceOf(InvalidOptionError);
  });

  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const states = async (s: ReturnType<typeof setup>, ids: Record<string, string>) =>
    Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, (await stored(s.store, s.scope, id))!.state] as const)));
  const addFour = async (q: Queue) => ({
    a: (await q.add('a', { name: 'a' })).job.id,
    b: (await q.add('b', { name: 'b' })).job.id,
    c: (await q.add('c', { name: 'c' })).job.id,
    none: (await q.add('none')).job.id,
  });

  it('names: process(map) only runs jobs of the names in the map', async () => {
    const s = setup();
    const ids = await addFour(s.q);
    const ran: unknown[] = [];
    s.q.process({ a: (j) => void ran.push(j.data), b: (j) => void ran.push(j.data) });
    await vi.waitFor(() => expect(ran).toHaveLength(2));
    await tick(20);
    expect(ran.sort()).toEqual(['a', 'b']);
    expect(await states(s, ids)).toEqual({ a: 'completed', b: 'completed', c: 'waiting', none: 'waiting' });
  });

  it('names: unnamed handler does not claim named jobs', async () => {
    const s = setup();
    const ids = await addFour(s.q);
    const ran: unknown[] = [];
    s.q.process((j) => void ran.push(j.data));
    await vi.waitFor(() => expect(ran).toEqual(['none']));
    await tick(20);
    expect(await states(s, ids)).toEqual({ a: 'waiting', b: 'waiting', c: 'waiting', none: 'completed' });
  });

  it('names: map form runs several names on one worker with shared concurrency', async () => {
    const { q } = setup();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let now = 0;
    let max = 0;
    const h = async () => {
      max = Math.max(max, ++now);
      await gate;
      now--;
    };
    const w = q.process({ a: h, b: h }, { concurrency: 2 });
    await q.addBulk(['a', 'b', 'a', 'b'].map((name) => ({ data: name, opts: { name } })));
    await vi.waitFor(() => expect(w.inFlight).toBe(2));
    await tick(20);
    expect(max).toBe(2);
    open();
  });

  it('names: second open worker of one Queue instance with the same name throws DuplicateHandlerError', async () => {
    const { store, q } = setup();
    const w1 = q.process({ a: () => 1 });
    try {
      q.process({ b: () => 1, a: () => 2 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateHandlerError);
      expect(e).toMatchObject({ code: 'DUPLICATE_HANDLER', jobName: 'a' });
    }
    expect(() => q.process({ b: () => 1 })).not.toThrow();
    expect(() => q.process(() => 1)).not.toThrow();
    expect(() => q.process(() => 1)).not.toThrow();
    const other = new Queue('names', { store, logger: silent });
    queues.push(other);
    expect(() => other.process({ a: () => 1 })).not.toThrow();
    await w1.close();
    expect(() => q.process({ a: () => 3 })).not.toThrow();
  });

  it('names: retry keeps the name', async () => {
    const s = setup();
    const w = s.q.process({ a: () => Promise.reject(new TypeError('no')) });
    const failed = new Promise<void>((r) => w.once('failed', () => r()));
    const { job } = await s.q.add(1, { name: 'a', maxAttempts: 1 });
    await failed;
    expect((await stored(s.store, s.scope, job.id))!).toMatchObject({ state: 'failed', name: 'a' });
  });

  it('names: late handler registration drains already waiting jobs', async () => {
    const s = setup();
    const ids = await Promise.all([1, 2, 3].map(async (i) => (await s.q.add(i, { name: 'x' })).job.id));
    const w = s.q.process({ x: () => 1 });
    let n = 0;
    await new Promise<void>((r) => w.on('completed', () => void (++n === 3 && r())));
    for (const id of ids) expect((await stored(s.store, s.scope, id))!.state).toBe('completed');
  });

  it('process: named map claims only its names; unnamed handler claims only unnamed jobs', async () => {
    const { store, q } = setup();
    const claim = vi.spyOn(store, 'claim');
    q.process({ a: () => 1, b: () => 1 }, { autorun: false }).run();
    q.process(() => 1, { autorun: false }).run();
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    const names = claim.mock.calls.map((c) => [...(c[1].names ?? [])].sort());
    expect(names).toContainEqual(['a', 'b']);
    expect(names).toContainEqual([null]);
  });

  it('process: a second process call on one Queue is allowed; a repeated job name throws DuplicateHandlerError', () => {
    const { q } = setup();
    q.process({ a: () => 1 });
    expect(() => q.process({ b: () => 1 })).not.toThrow();
    expect(() => q.process({ b: () => 1 })).toThrow(DuplicateHandlerError);
  });

  it('names: invalid handler shapes throw InvalidOptionError (string first argument, empty map, non-function value)', () => {
    const { q } = setup();
    const cases: Array<[unknown[], string]> = [
      [['a', () => 1], 'handler'],
      [[{}], 'handlers'],
      [[{ a: 'x' }], 'handlers.a'],
      [[{ 'bad name': () => 1 }], 'handlers.bad name'],
    ];
    for (const [args, path] of cases) {
      try {
        (q.process as (...a: unknown[]) => unknown)(...args);
        expect.unreachable(path);
      } catch (e) {
        expect(e, path).toBeInstanceOf(InvalidOptionError);
        expect((e as InvalidOptionError).issues[0]!.path).toBe(path);
      }
    }
  });
});
