import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs, stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { serializeError } from '../../src/serialize/error.js';
import { addVia } from '../helpers/add-via.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const setup = (order?: 'fifo' | 'lifo') => {
  const c = { t: 1_000_000 };
  const store = new MemoryStore({ clock: () => c.t });
  const queue = new Queue('orders', { store, logger: silent, ...(order ? { order } : {}) });
  const label: Record<string, string> = {};
  const add = async (name: string, opts: Record<string, unknown> = {}) => {
    const id = await addVia(queue, name, opts);
    label[id] = name;
    return id;
  };
  const claim = (q: Queue, limit: number) =>
    claimJobs(store, q.internals.scope, { workerId: 'w', limit, order: q.internals.order });
  const claimIds = async (limit = 100, q: Queue = queue) => (await claim(q, limit)).map((r) => label[r.id]);
  return { c, store, queue, label, add, claim, claimIds };
};

/** A claimed, then failed with a retry, while B and C are added; then the retry comes due. */
async function retryScenario(order: 'fifo' | 'lifo') {
  const s = setup(order);
  await s.add('A');
  const [a] = await s.claim(s.queue, 1);
  await s.add('B');
  await s.add('C');
  const error = JSON.stringify(serializeError(new TypeError('boom'), { maxErrorBytes: 16_384, storeStacks: false }));
  expect(await s.store.fail(s.queue.internals.scope, { id: a!.id, token: a!.lease!.token, error, retryInMs: 1000 })).toMatchObject({ ok: true });
  s.c.t += 1000;
  return s.claimIds();
}

describe('order (through the queue)', () => {
  it('order: default is fifo', () => {
    expect(new Queue('q', { logger: silent }).internals.order).toBe('fifo');
  });

  it('order: fifo runs equal-priority jobs oldest first', async () => {
    const s = setup('fifo');
    for (const n of ['A', 'B', 'C']) await s.add(n);
    expect(await s.claimIds()).toEqual(['A', 'B', 'C']);
  });

  it('order: lifo runs equal-priority jobs newest first', async () => {
    const s = setup('lifo');
    for (const n of ['A', 'B', 'C']) await s.add(n);
    expect(await s.claimIds()).toEqual(['C', 'B', 'A']);
  });

  it('order: priority beats order under lifo', async () => {
    const s = setup('lifo');
    await s.add('X', { priority: 0 });
    await s.add('Y', { priority: 0 });
    await s.add('Z', { priority: 5 });
    expect(await s.claimIds()).toEqual(['Z', 'Y', 'X']);
  });

  it('order: first true under lifo is a normal add', async () => {
    const s = setup('lifo');
    const a = await s.add('A');
    const b = await s.add('B', { first: true });
    await s.add('C');
    const scope = s.queue.internals.scope;
    expect((await stored(s.store, scope, b))!.seq).toBeGreaterThan((await stored(s.store, scope, a))!.seq);
    expect(await s.claimIds()).toEqual(['C', 'B', 'A']);
  });

  it('order: retried job rejoins by original seq under fifo', async () => {
    expect(await retryScenario('fifo')).toEqual(['A', 'B', 'C']);
  });

  it('order: retried job keeps its seq under lifo and runs after newer same-priority jobs', async () => {
    expect(await retryScenario('lifo')).toEqual(['C', 'B', 'A']);
  });

  it('order: invalid order value throws InvalidOptionError', () => {
    for (const order of ['FIFO', 'lifo ', 1, null]) {
      try {
        new Queue('q', { order: order as never, logger: silent });
        expect.unreachable(String(order));
      } catch (e) {
        expect(e, String(order)).toBeInstanceOf(InvalidOptionError);
        expect((e as InvalidOptionError).issues[0]!.path).toBe('order');
      }
    }
    expect(new Queue('q', { order: undefined as never, logger: silent }).internals.order).toBe('fifo');
  });

  it('order: first job added by a fifo pod is claimed last by a lifo pod', async () => {
    const s = setup('fifo');
    const lifoPod = new Queue('orders', { store: s.store, order: 'lifo', logger: silent });
    await s.add('A');
    await s.add('B', { first: true });
    expect(await s.claimIds(100, lifoPod)).toEqual(['A', 'B']);
  });
});
