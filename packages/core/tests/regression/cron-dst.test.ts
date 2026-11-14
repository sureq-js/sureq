import { describe, expect, it } from 'vitest';
import { nextCronOccurrence } from '../../src/scheduler/cron.js';
import { wallClock } from '../../src/scheduler/zone.js';

const Z = Date.parse;
const tz = 'Europe/Berlin';

/** The runs of `cron` from `from` to `to`, grouped by Berlin local date. */
function runsByDate(cron: string, from: string, to: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let t = nextCronOccurrence({ cron, tz }, Z(from)); t !== null && t < Z(to); t = nextCronOccurrence({ cron, tz }, t)) {
    const w = wallClock(tz, t);
    const date = `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
    (out[date] ??= []).push(new Date(t).toISOString().slice(11, 16));
  }
  return out;
}

describe('daylight saving (regression)', () => {
  it('regression: a daylight-saving change neither skips nor doubles a cron run', () => {
    const spring = ['2026-03-27T22:59Z', '2026-03-30T22:00Z'] as const;
    const fall = ['2026-10-23T21:59Z', '2026-10-26T23:00Z'] as const;

    expect(runsByDate('30 2 * * *', ...spring)).toEqual({ '2026-03-28': ['01:30'], '2026-03-29': ['01:00'], '2026-03-30': ['00:30'] });
    expect(runsByDate('30 2 * * *', ...fall)).toEqual({ '2026-10-24': ['00:30'], '2026-10-25': ['00:30'], '2026-10-26': ['01:30'] });

    expect(runsByDate('*/30 2 * * *', ...spring)).toEqual({ '2026-03-28': ['01:00', '01:30'], '2026-03-29': ['01:00'], '2026-03-30': ['00:00', '00:30'] });
    expect(runsByDate('*/30 2 * * *', ...fall)).toEqual({ '2026-10-24': ['00:00', '00:30'], '2026-10-25': ['00:00', '00:30'], '2026-10-26': ['01:00', '01:30'] });

    const hourly = (range: readonly [string, string]) => Object.fromEntries(Object.entries(runsByDate('0 * * * *', ...range)).map(([d, r]) => [d, r.length]));
    expect(hourly(spring)).toEqual({ '2026-03-28': 24, '2026-03-29': 23, '2026-03-30': 24 });
    expect(hourly(fall)).toEqual({ '2026-10-24': 24, '2026-10-25': 25, '2026-10-26': 24 });
  });
});
