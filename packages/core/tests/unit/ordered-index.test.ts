import { describe, expect, it } from 'vitest';
import { OrderedIndex, DelayedHeap } from '../../src/store/memory/ordered-index.js';

/** Seeded linear congruential generator, so shuffles are reproducible. */
const lcg = (seed: number) => () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
const shuffle = <T>(xs: T[], rnd: () => number): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

const counted = () => {
  const c = { calls: 0 };
  const index = new OrderedIndex<string>((a, b) => {
    c.calls++;
    return a - b;
  });
  return { c, index };
};

describe('memstore (ordered index)', () => {
  it('memstore: insert and delete stay O(log n)', () => {
    const n = 10_000;
    const bound = 4 * Math.log2(n);
    for (const keys of [
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => n - i),
      shuffle(Array.from({ length: n }, (_, i) => i), lcg(7)),
    ]) {
      const { c, index } = counted();
      let worst = 0;
      for (const k of keys) {
        c.calls = 0;
        index.insert(k, `v${k}`);
        worst = Math.max(worst, c.calls);
      }
      expect(worst).toBeLessThanOrEqual(bound);
      expect(index.size).toBe(n);
      const asc = [...index.iterate('asc')].map((e) => e.key);
      expect(asc).toEqual([...asc].sort((a, b) => a - b));
      expect([...index.iterate('desc')].map((e) => e.key)).toEqual([...asc].reverse());

      const toDelete = shuffle(keys, lcg(11)).slice(0, 5_000);
      worst = 0;
      for (const k of toDelete) {
        c.calls = 0;
        expect(index.delete(k)).toBe(true);
        worst = Math.max(worst, c.calls);
      }
      expect(worst).toBeLessThanOrEqual(bound);
      expect(index.size).toBe(n - 5_000);
      expect(index.delete(-123)).toBe(false);

      c.calls = 0;
      const min = index.min();
      const max = index.max();
      expect(min!.key).toBeLessThan(max!.key);
      expect(index.popMin()!.key).toBe(min!.key);
      expect(index.popMax()!.key).toBe(max!.key);
      expect(c.calls).toBe(0);
    }
  });

  it('memstore: comparator calls per insert stay under 4 * log2(n) at n = 10 000 and n = 100 000, including reinsertion of retried and promoted jobs by original seq', () => {
    for (const n of [10_000, 100_000]) {
      const bound = 4 * Math.log2(n);
      const { c, index } = counted();
      let worst = 0;
      for (let k = 1; k <= n; k++) {
        c.calls = 0;
        index.insert(k, 'x');
        worst = Math.max(worst, c.calls);
      }
      const popped: number[] = [];
      for (let i = 0; i < n / 10; i++) popped.push(index.popMin()!.key);
      for (const k of shuffle(popped, lcg(3))) {
        c.calls = 0;
        index.insert(k, 'x');
        worst = Math.max(worst, c.calls);
      }
      expect(worst).toBeGreaterThan(0); // the counter is wired
      expect(worst).toBeLessThanOrEqual(bound);
      expect(index.size).toBe(n);
    }
  });

  it('memstore: inserting an existing key is a store bug', () => {
    const index = new OrderedIndex<string>();
    index.insert(1, 'a');
    expect(() => index.insert(1, 'b')).toThrow();
  });

  it('memstore: DelayedHeap pops by runAt, removes by id and breaks ties by insertion order', () => {
    const h = new DelayedHeap();
    h.push(30, 'c');
    h.push(10, 'a');
    h.push(20, 'b');
    expect(h.size).toBe(3);
    expect(h.remove('b')).toBe(true);
    expect(h.remove('zzz')).toBe(false);
    expect(h.peek()).toEqual({ runAt: 10, id: 'a' });
    expect([h.pop()?.id, h.pop()?.id, h.pop()]).toEqual(['a', 'c', undefined]);
    for (const id of ['x', 'y', 'z']) h.push(5, id);
    expect([h.pop()?.id, h.pop()?.id, h.pop()?.id]).toEqual(['x', 'y', 'z']);
  });
});
