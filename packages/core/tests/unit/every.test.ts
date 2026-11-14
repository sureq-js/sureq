import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DELAY_MS } from '../../src/util/duration.js';
import { everyIssue, nextEveryOccurrence as next, parseEvery } from '../../src/scheduler/interval.js';
import { rng } from '../helpers/pods.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('fixed intervals', () => {
  it('every: duration strings and numbers parse to ms', () => {
    const inputs = [1000, '1000ms', '30s', '5m', '2h', '1d', 2 ** 31 + 5];
    for (const v of inputs) expect(everyIssue(v), String(v)).toBeUndefined();
    expect(inputs.map(parseEvery)).toEqual([1000, 1000, 30_000, 300_000, 7_200_000, 86_400_000, 2147483653]);
  });

  it('every: invalid values are rejected with bad-interval', () => {
    for (const v of [0, 999, -1000, 1000.5, NaN, Infinity, '0s', '999ms', '1w', '1.5h', 'abc', '10 s', 's', '', null, {}]) {
      expect(everyIssue(v), String(v)).toMatchObject({ path: 'every', reason: 'bad-interval' });
    }
    expect(everyIssue(MAX_DELAY_MS)).toBeUndefined();
    expect(everyIssue(MAX_DELAY_MS + 1)).toMatchObject({ code: 'out_of_range', reason: 'bad-interval' });
    expect(everyIssue('36501d')).toMatchObject({ code: 'out_of_range', reason: 'bad-interval' });
  });

  it('every: first tick is anchor plus period', () => {
    expect(next(30_000, 1_000, 1_000)).toBe(31_000);
  });

  it('every: ticks stay on the grid when fires are late', () => {
    const random = rng(3);
    const A = 1_700_000_000_123;
    let tick = next(5000, A, A);
    for (let k = 1; k <= 10_000; k++) {
      expect(tick).toBe(A + k * 5000);
      tick = next(5000, A, tick + Math.floor(random() * 901));
    }
  });

  it('every: missed periods collapse to the first grid point after now', () => {
    expect(next(1000, 0, 10_500)).toBe(11_000);
  });

  it('every: next occurrence is strictly after the given instant', () => {
    expect(next(1000, 0, 5_000)).toBe(6_000);
    expect(next(1000, 5_000, 4_000)).toBe(5_000);
  });

  it('every: grid is identical when pod clock is skewed ±1h', () => {
    const grid = () => Array.from({ length: 100 }, (_, i) => next(7_000, 1_000, 1_000 + i * 3_333));
    const base = grid();
    for (const skew of [3_600_000, -3_600_000]) {
      vi.useFakeTimers({ now: Date.now() + skew });
      expect(grid()).toEqual(base);
      vi.useRealTimers();
    }
  });
});
