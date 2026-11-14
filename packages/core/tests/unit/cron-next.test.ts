import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { nextCronOccurrence, parseCron } from '../../src/scheduler/cron.js';
import { formatFor, tzIssue, wallClock } from '../../src/scheduler/zone.js';
import { rng } from '../helpers/pods.js';

const Z = Date.parse;
const MIN = 60_000;
const DAY = 86_400_000;
const next = (cron: string, tz: string | undefined, after: number) => nextCronOccurrence(tz === undefined ? { cron } : { cron, tz }, after);
/** Each occurrence after `from` and before `to`, by chaining calls. */
const chain = (cron: string, tz: string, from: number, to: number): string[] => {
  const out: string[] = [];
  for (let t = next(cron, tz, from); t !== null && t < to; t = next(cron, tz, t)) out.push(new Date(t).toISOString());
  return out;
};
const iso = (...v: string[]) => v.map((s) => new Date(Z(s)).toISOString());

afterEach(() => {
  vi.useRealTimers();
});

describe('next cron occurrence', () => {
  it('cron: five-field expression yields next minute boundary', () => {
    expect(next('* * * * *', 'UTC', Z('2026-11-06T10:00:30.500Z'))).toBe(Z('2026-11-06T10:01Z'));
    expect(next('* * * * *', 'UTC', Z('2026-11-06T10:00Z'))).toBe(Z('2026-11-06T10:01Z'));
  });

  it('cron: day-of-month and day-of-week both set match either', () => {
    const feb = Z('2026-02-01T00:00Z');
    const end = Z('2026-03-01T00:00Z');
    expect(chain('0 0 13 * 5', 'UTC', feb, end)).toEqual(iso('2026-02-06T00:00Z', '2026-02-13T00:00Z', '2026-02-20T00:00Z', '2026-02-27T00:00Z'));
    expect(chain('0 0 30 2 1', 'UTC', Z('2026-01-31T00:00Z'), end)).toEqual(iso('2026-02-02T00:00Z', '2026-02-09T00:00Z', '2026-02-16T00:00Z', '2026-02-23T00:00Z'));
    expect(chain('0 0 13 * *', 'UTC', feb, end)).toEqual(iso('2026-02-13T00:00Z'));
    expect(chain('0 0 * * 5', 'UTC', feb, end)).toEqual(iso('2026-02-06T00:00Z', '2026-02-13T00:00Z', '2026-02-20T00:00Z', '2026-02-27T00:00Z'));
    // a day field starting with * is unrestricted, so the two fields are ANDed (Vixie)
    expect(chain('0 0 */2 * 5', 'UTC', feb, end)).toEqual(iso('2026-02-13T00:00Z', '2026-02-27T00:00Z'));
    expect(next('0 0 13 * */2', 'UTC', feb)).toBe(Z('2026-06-13T00:00Z'));
    // a step on its own still filters days
    expect(chain('0 0 */10 * *', 'UTC', feb, end)).toEqual(iso('2026-02-11T00:00Z', '2026-02-21T00:00Z'));
  });

  it('cron: unknown or offset timezone is rejected with bad-timezone', () => {
    for (const tz of ['Mars/Olympus', '+02:00', '-0500', 'EST', 'CET', 'GMT', '', 42]) {
      expect(tzIssue(tz), String(tz)).toMatchObject({ path: 'tz', reason: 'bad-timezone' });
    }
    for (const tz of ['UTC', 'Europe/Berlin', 'europe/berlin', 'Etc/GMT+5']) expect(tzIssue(tz), tz).toBeUndefined();
    // case variants share one cached formatter
    expect(formatFor('EUROPE/berlin')).toBe(formatFor('Europe/Berlin'));
    expect(() => next('* * * * *', 'EST', 0)).toThrow(InvalidOptionError);
    expect(() => next('* * * * * *', 'UTC', 0)).toThrow(InvalidOptionError);
  });

  it('cron: default timezone is UTC regardless of process TZ', () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ['Asia/Tokyo', 'UTC']) {
        process.env.TZ = tz;
        expect(next('0 9 * * *', undefined, Z('2026-01-15T00:00Z'))).toBe(Z('2026-01-15T09:00Z'));
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('cron: 09:00 America/New_York is 14:00Z in winter and 13:00Z in summer', () => {
    expect(next('0 9 * * *', 'America/New_York', Z('2026-01-15T00:00Z'))).toBe(Z('2026-01-15T14:00Z'));
    expect(next('0 9 * * *', 'America/New_York', Z('2026-07-15T00:00Z'))).toBe(Z('2026-07-15T13:00Z'));
    expect(next('0 9 * * *', 'Asia/Kolkata', Z('2026-01-15T00:00Z'))).toBe(Z('2026-01-15T03:30Z'));
  });

  it('cron: leap-day expression after 2096 finds 2104-02-29', () => {
    expect(next('0 0 29 2 *', 'UTC', Z('2096-02-29T00:00Z'))).toBe(Z('2104-02-29T00:00Z'));
    expect(next('0 0 29 2 *', 'UTC', Z('2024-02-29T00:00Z'))).toBe(Z('2028-02-29T00:00Z'));
    expect(next('0 0 31 * *', 'UTC', Z('2026-01-31T00:00Z'))).toBe(Z('2026-03-31T00:00Z'));
  });

  it('cron: impossible date reports no-occurrence after the 9-year search', () => {
    for (const cron of ['0 0 30 2 *', '0 0 31 2 *', '0 0 31 4 *', '0 0 31 11 *']) {
      const t0 = performance.now();
      expect(next(cron, 'Europe/Berlin', Z('2026-11-06T00:00Z')), cron).toBeNull();
      expect(performance.now() - t0, cron).toBeLessThan(50);
    }
  });

  it('cron: next occurrence is strictly after the given instant', () => {
    for (const cron of ['0 * * * *', '30 2 * * *', '*/7 * * * *']) {
      let t = Z('2026-10-24T00:00Z');
      for (let i = 0; i < 200; i++) {
        const n = next(cron, 'Europe/Berlin', t)!;
        expect(n, cron).toBeGreaterThan(t);
        t = n;
      }
    }
    expect(next('0 * * * *', 'UTC', Z('2026-11-06T10:00Z'))).toBe(Z('2026-11-06T11:00Z'));
    expect(next('30 2 * * *', 'UTC', Z('2026-11-06T02:30Z'))).toBe(Z('2026-11-07T02:30Z'));
    // after the first pass of the repeated hour: periodic takes the second pass, clock-time the next day
    expect(next('0 * * * *', 'Europe/Berlin', Z('2026-10-25T00:00Z'))).toBe(Z('2026-10-25T01:00Z'));
    expect(next('0 2 * * *', 'Europe/Berlin', Z('2026-10-25T00:00Z'))).toBe(Z('2026-10-26T01:00Z'));
  });

  it('cron: result is identical when pod clock is skewed ±1h and TZ differs', () => {
    const exprs = ['* * * * *', '30 2 * * *', '0 * * * *', '*/45 9-17 * * 1-5', '0 0 1 * *'];
    const run = () => exprs.map((cron) => {
      const out: (number | null)[] = [];
      let t: number | null = Z('2026-10-24T20:00Z');
      for (let i = 0; i < 20 && t !== null; i++) out.push((t = next(cron, 'Europe/Berlin', t)));
      return out;
    });
    const base = run();
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      for (const skew of [3_600_000, -3_600_000]) {
        vi.useFakeTimers({ now: Date.now() + skew });
        expect(run()).toEqual(base);
        vi.useRealTimers();
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('cron: periodic expressions match a minute-by-minute scan in many zones', () => {
    const exprs = ['* * * * *', '*/7 * * * *', '15,45 */2 * * *', '0 * 1,15 * *', '*/10 * * * 1-5', '0 */3 * 3,10 0', '0 */3 */2 * 1-5', '0 0 13 * */2', '*/20 * */3 * 0,6'];
    const zones: Record<string, string[]> = {
      'Europe/Berlin': ['2026-03-29T01:00Z', '2026-10-25T01:00Z'],
      'America/New_York': ['2026-03-08T07:00Z', '2026-11-01T06:00Z'],
      'Australia/Sydney': ['2026-04-04T16:00Z', '2026-10-03T16:00Z'],
      'Australia/Lord_Howe': ['2026-04-04T15:00Z', '2026-10-03T15:30Z'],
      'America/Santiago': ['2026-04-05T03:00Z', '2026-09-06T04:00Z'],
      'Asia/Kolkata': ['2026-03-29T01:00Z', '2026-10-25T01:00Z'],
      UTC: ['2026-03-29T01:00Z', '2026-10-25T01:00Z'],
    };
    const names = Object.keys(zones);
    const random = rng(7);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
    for (let i = 0; i < 300; i++) {
      const cron = pick(exprs);
      const tz = pick(names);
      const after = Z(pick(zones[tz]!)) + Math.floor((random() * 2 - 1) * 3 * DAY);
      const spec = parseCron(cron);
      let expected: number | undefined;
      for (let t = Math.floor(after / MIN) * MIN + MIN; t <= after + 4 * DAY; t += MIN) {
        const w = wallClock(tz, t);
        const dow = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
        const dayOk = spec.domRestricted && spec.dowRestricted
          ? spec.dom.has(w.day) || spec.dow.has(dow)
          : spec.dom.has(w.day) && spec.dow.has(dow);
        if (spec.minute.has(w.minute) && spec.hour.has(w.hour) && spec.month.has(w.month) && dayOk) {
          expected = t;
          break;
        }
      }
      const got = next(cron, tz, after);
      const label = `${cron} ${tz} ${new Date(after).toISOString()}`;
      if (expected === undefined) expect(got, label).toBeGreaterThan(after + 4 * DAY);
      else expect(got, label).toBe(expected);
    }
  }, 120_000);

  it('cron: a thousand consecutive minutes across a fall-back day compute in under a second', () => {
    // the best of three runs, so a busy machine does not fail it
    const times = Array.from({ length: 3 }, () => {
      const t0 = performance.now();
      let t = Z('2026-10-24T23:30Z');
      for (let i = 0; i < 1000; i++) {
        const n = next('* * * * *', 'Europe/Berlin', t)!;
        expect(n - t).toBe(MIN);
        t = n;
      }
      return performance.now() - t0;
    });
    expect(Math.min(...times)).toBeLessThan(1000);
  });
});
