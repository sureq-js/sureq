import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { NewJob } from '../../src/store/contract.js';
import { SCOPE as scope, added, claimReq, newJob as contractJob } from '../helpers/store.js';

type Spec = Partial<NewJob> & { order?: 'fifo' | 'lifo' };
/** A job as a queue with `order` would send it: `first` only means something under fifo. */
const newJob = ({ order = 'fifo', first, ...over }: Spec = {}): NewJob => contractJob({ ...over, first: first === true && order === 'fifo' });
const seqs = async (store: MemoryStore, jobs: NewJob[]): Promise<number[]> => added(await store.add(scope, jobs)).map((r) => r.seq);

describe('priority / order (seq)', () => {
  it('priority: seq is unique and never reused (across batches and scopes)', async () => {
    const store = new MemoryStore();
    void store.open();
    expect(await seqs(store, [newJob(), newJob()])).toEqual([1, 2]);
    expect(await seqs(store, [newJob()])).toEqual([3]);
    expect(added(await store.add({ namespace: 'n', queue: 'other' }, [newJob()]))[0]!.seq).toBe(1);
  });

  it('priority: first true gets a seq below every existing seq under fifo', async () => {
    const store = new MemoryStore();
    void store.open();
    await seqs(store, [newJob(), newJob()]);
    expect(await seqs(store, [newJob({ first: true })])).toEqual([-1]);
    expect(await seqs(store, [newJob({ first: true })])).toEqual([-2]);
  });

  it('order: first true under lifo is a normal add', async () => {
    const store = new MemoryStore();
    void store.open();
    await seqs(store, [newJob({ order: 'lifo' }), newJob({ order: 'lifo' })]);
    expect(await seqs(store, [newJob({ first: true, order: 'lifo' })])).toEqual([3]);
  });

  it('priority: first in addBulk reverses the bulk order (seq)', async () => {
    const store = new MemoryStore();
    void store.open();
    expect(await seqs(store, [newJob({ first: true }), newJob({ first: true }), newJob({ first: true })])).toEqual([-1, -2, -3]);
  });

  it('priority: concurrent adds from two queue instances get distinct seq', async () => {
    const store = new MemoryStore();
    void store.open();
    const many = (p: number) => Promise.all(Array.from({ length: 500 }, () => seqs(store, [newJob({ priority: p })])));
    const [a, b] = await Promise.all([many(1), many(9)]);
    const all = [...a!.flat(), ...b!.flat()];
    expect(new Set(all).size).toBe(1000);
  });
});

const claimIds = async (store: MemoryStore, order: 'fifo' | 'lifo' = 'fifo', extra: { names?: Set<string | null> } = {}) =>
  (await store.claim(scope, claimReq({ workerId: 'w', limit: 100, order, ...(extra.names && { names: [...extra.names] }) }))).jobs.map((r) => r.id);
const addIds = (store: MemoryStore, specs: Array<[string, Spec?]>) =>
  store.add(scope, specs.map(([id, over]) => newJob({ id, ...over })));

describe('priority / order (claim)', () => {
  it('priority: higher priority is claimed first', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['lo', { priority: 1 }], ['hi', { priority: 9 }], ['mid', { priority: 5 }]]);
    expect(await claimIds(s)).toEqual(['hi', 'mid', 'lo']);
  });

  it('priority: equal priority is claimed in insertion order', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a'], ['b'], ['c']]);
    expect(await claimIds(s)).toEqual(['a', 'b', 'c']);
  });

  it('priority: negative priorities run after zero', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['neg', { priority: -3 }], ['zero']]);
    expect(await claimIds(s)).toEqual(['zero', 'neg']);
  });

  it('priority: first true runs before same-priority jobs but after higher priority', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['five-a', { priority: 5 }], ['nine', { priority: 9 }], ['five-b', { priority: 5 }], ['first-5', { priority: 5, first: true }]]);
    expect(await claimIds(s)).toEqual(['nine', 'first-5', 'five-a', 'five-b']);
  });

  it('priority: two first jobs run latest first', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['x'], ['f1', { first: true }], ['f2', { first: true }]]);
    expect(await claimIds(s)).toEqual(['f2', 'f1', 'x']);
  });

  it('priority: first in addBulk reverses the bulk order', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a', { first: true }], ['b', { first: true }], ['c', { first: true }]]);
    expect(await claimIds(s)).toEqual(['c', 'b', 'a']);
  });

  it('priority: first under lifo is a normal add and a later add is claimed before it', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['old', { order: 'lifo' }], ['first', { order: 'lifo', first: true }], ['newer', { order: 'lifo' }]]);
    expect(await claimIds(s, 'lifo')).toEqual(['newer', 'first', 'old']);
  });

  it('priority: first job added by a fifo pod is claimed last by a lifo pod (documented per-pod order consequence)', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a'], ['b'], ['f', { first: true }]]);
    expect(await claimIds(s, 'lifo')).toEqual(['b', 'a', 'f']);
  });

  it('order: first job added by a fifo pod is claimed last by a lifo pod', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a'], ['f', { first: true }]]);
    expect(await claimIds(s, 'lifo')).toEqual(['a', 'f']);
  });

  it('order: fifo runs equal-priority jobs oldest first', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['1'], ['2'], ['3']]);
    expect(await claimIds(s, 'fifo')).toEqual(['1', '2', '3']);
  });

  it('order: lifo runs equal-priority jobs newest first', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['1'], ['2'], ['3']]);
    expect(await claimIds(s, 'lifo')).toEqual(['3', '2', '1']);
  });

  it('memstore: lifo claim takes the newest seq of the highest priority', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['hi-old', { priority: 2 }], ['lo-new', { priority: 1 }], ['hi-new', { priority: 2 }]]);
    expect(await claimIds(s, 'lifo')).toEqual(['hi-new', 'hi-old', 'lo-new']);
  });

  it('order: priority beats order under lifo', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['hi', { priority: 9 }], ['lo', { priority: 0 }]]);
    expect(await claimIds(s, 'lifo')).toEqual(['hi', 'lo']);
  });

  it('order: lifo addBulk runs last input first', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a', { order: 'lifo' }], ['b', { order: 'lifo' }], ['c', { order: 'lifo' }]]);
    expect(await claimIds(s, 'lifo')).toEqual(['c', 'b', 'a']);
  });

  it('priority: delayed job enters at its priority position when promoted', async () => {
    let t = 1000;
    const s = new MemoryStore({ clock: () => t });
    void s.open();
    await addIds(s, [['delayed', { delayMs: 50 }], ['two'], ['three']]);
    t = 1050;
    expect(await claimIds(s, 'fifo')).toEqual(['delayed', 'two', 'three']);
  });

  it('names: claim with names filter returns only matching jobs', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a1', { name: 'a' }], ['b1', { name: 'b' }], ['a2', { name: 'a' }]]);
    expect(await claimIds(s, 'fifo', { names: new Set(['a']) })).toEqual(['a1', 'a2']);
  });

  it('names: claim with null in filter returns unnamed jobs', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['named', { name: 'a' }], ['plain'], ['plain2']]);
    expect(await claimIds(s, 'fifo', { names: new Set([null]) })).toEqual(['plain', 'plain2']);
  });

  it('names: filter keeps priority and seq order within the matching set', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a-lo', { name: 'a', priority: 1 }], ['b-hi', { name: 'b', priority: 9 }], ['a-hi', { name: 'a', priority: 9 }], ['a-hi2', { name: 'a', priority: 9 }]]);
    expect(await claimIds(s, 'fifo', { names: new Set(['a']) })).toEqual(['a-hi', 'a-hi2', 'a-lo']);
    const s2 = new MemoryStore();
    void s2.open();
    await addIds(s2, [['x1', { name: 'x' }], ['y1', { name: 'y' }], ['x2', { name: 'x' }]]);
    expect(await claimIds(s2, 'lifo', { names: new Set(['x', 'y']) })).toEqual(['x2', 'y1', 'x1']);
  });

  it('names: concurrent claims with different filters never return the same job', async () => {
    const s = new MemoryStore();
    void s.open();
    const names = ['a', 'b', 'c', null];
    await s.add(scope, Array.from({ length: 200 }, (_, i) => newJob({ name: names[i % 4]! })));
    const seen: string[] = [];
    const loop = async (filter: Set<string | null>) => {
      for (;;) {
        const { jobs: got } = await s.claim(scope, claimReq({ workerId: 'w', limit: 3, names: [...filter] }));
        if (!got.length) return;
        seen.push(...got.map((r) => r.id));
      }
    };
    await Promise.all([loop(new Set(['a', 'b'])), loop(new Set(['b', 'c', null]))]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(200);
  });
});

const err = JSON.stringify({ v: 1, name: 'E', message: 'x' });
const claimOne = async (store: MemoryStore, order: 'fifo' | 'lifo') =>
  (await store.claim(scope, claimReq({ workerId: 'w', limit: 1, order }))).jobs[0]!;

describe('priority / order (retries, removal, scale)', () => {
  it('priority: retried job keeps its place among peers', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['1'], ['2'], ['3']]);
    const first = await claimOne(s, 'fifo');
    await s.fail(scope, { id: first.id, token: first.token, error: err, retryInMs: 0 });
    expect(await claimIds(s, 'fifo')).toEqual(['1', '2', '3']);
  });

  it('order: retried job rejoins by original seq under fifo', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a'], ['b'], ['c']]);
    const a = await claimOne(s, 'fifo');
    await s.fail(scope, { id: a.id, token: a.token, error: err, retryInMs: 0 });
    expect((await claimOne(s, 'fifo')).id).toBe('a');
  });

  it('order: retried job keeps its seq under lifo and runs after newer same-priority jobs', async () => {
    let t = 1000;
    const s = new MemoryStore({ clock: () => t });
    void s.open();
    await addIds(s, [['1', { order: 'lifo' }], ['2', { order: 'lifo' }], ['3', { order: 'lifo' }]]);
    const three = await claimOne(s, 'lifo');
    expect(three.id).toBe('3');
    await s.fail(scope, { id: '3', token: three.token, error: err, retryInMs: 1000 });
    await addIds(s, [['4', { order: 'lifo' }]]);
    t = 2000;
    expect(await claimIds(s, 'lifo')).toEqual(['4', '3', '2', '1']);
  });

  it('priority: seq is unique and never reused', async () => {
    const s = new MemoryStore();
    void s.open();
    await addIds(s, [['a'], ['b'], ['c']]);
    await s.remove(scope, { id: 'c' });
    const [o] = added(await addIds(s, [['d']]));
    expect(o!.seq).toBe(4);
  });

  it('priority: regression add and claim never sort the whole queue', async () => {
    const sort = vi.spyOn(Array.prototype, 'sort');
    try {
      const s = new MemoryStore();
      void s.open();
      for (let b = 0; b < 50; b++) await s.add(scope, Array.from({ length: 1000 }, (_, i) => newJob({ priority: i % 7 })));
      for (let i = 0; i < 500; i++) await s.claim(scope, claimReq({ workerId: 'w', limit: 100 }));
      expect(sort.mock.contexts.filter((ctx) => (ctx as unknown[]).length >= 1000)).toEqual([]);
    } finally {
      sort.mockRestore();
    }
  }, 30_000);

  it('priority: regression claim time does not grow linearly with depth', async () => {
    // Counted, not timed: a claim at depth 100 000 never walks a collection of 1 000 or more entries.
    const s = new MemoryStore();
    void s.open();
    for (let b = 0; b < 100; b++) await s.add(scope, Array.from({ length: 1000 }, (_, i) => newJob({ priority: i % 5 })));
    const big = (ctx: unknown) => ((ctx as { size?: number; length?: number }).size ?? (ctx as unknown[]).length ?? 0) >= 1000;
    const spies = [
      ...([Map.prototype, Set.prototype] as const).flatMap((p) => [
        vi.spyOn(p, 'values'),
        vi.spyOn(p, 'keys'),
        vi.spyOn(p, 'entries'),
        vi.spyOn(p, 'forEach'),
        vi.spyOn(p as Map<unknown, unknown>, Symbol.iterator),
      ]),
      ...(['filter', 'map', 'find', 'findIndex', 'some', 'every', 'forEach', 'indexOf', 'includes', 'reduce', 'slice', 'sort'] as const).map((m) =>
        vi.spyOn(Array.prototype, m),
      ),
    ];
    let walked: string[];
    try {
      for (let i = 0; i < 1000; i++) await s.claim(scope, claimReq({ workerId: 'w', limit: 1 }));
    } finally {
      const contexts = spies.map((spy) => [spy.getMockName(), [...spy.mock.contexts]] as const);
      for (const spy of spies) spy.mockRestore();
      walked = contexts.flatMap(([name, ctxs]) => ctxs.filter(big).map(() => name));
    }
    expect(walked).toEqual([]);
    expect((await s.counts(scope)).active).toBe(1000);
  }, 30_000);
});
