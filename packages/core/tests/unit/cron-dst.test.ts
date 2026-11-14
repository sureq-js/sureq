import { describe, expect, it } from 'vitest';
import { nextCronOccurrence } from '../../src/scheduler/cron.js';

const Z = Date.parse;
const HOUR = 3_600_000;
const iso = (s: string) => new Date(Z(s)).toISOString();
/** Each occurrence after `from` and before `to`, by chaining calls. */
const chain = (cron: string, tz: string, from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = nextCronOccurrence({ cron, tz }, Z(from)); t !== null && t < Z(to); t = nextCronOccurrence({ cron, tz }, t)) {
    out.push(new Date(t).toISOString());
  }
  return out;
};
/** `count` whole hours starting at `start`. */
const hours = (start: string, count: number) => Array.from({ length: count }, (_, i) => new Date(Z(start) + i * HOUR).toISOString());

const B = 'Europe/Berlin';
type Row = [cron: string, tz: string, from: string, to: string, expected: string[]];

describe('cron daylight saving', () => {
  it('cron: dst table: every row of the daylight-saving table yields exactly the listed instants', () => {
    const rows: Row[] = [
      ['30 2 * * *', B, '2026-03-28T00:00Z', '2026-03-31T00:00Z', ['2026-03-28T01:30Z', '2026-03-29T01:00Z', '2026-03-30T00:30Z']],
      ['*/30 2 * * *', B, '2026-03-28T12:00Z', '2026-03-29T12:00Z', ['2026-03-29T01:00Z']],
      ['0 0-5 * * *', B, '2026-03-28T22:30Z', '2026-03-29T12:00Z', ['2026-03-28T23:00Z', '2026-03-29T00:00Z', '2026-03-29T01:00Z', '2026-03-29T02:00Z', '2026-03-29T03:00Z']],
      ['0 0-5 * * *', B, '2026-10-24T21:30Z', '2026-10-25T12:00Z', ['2026-10-24T22:00Z', '2026-10-24T23:00Z', '2026-10-25T00:00Z', '2026-10-25T02:00Z', '2026-10-25T03:00Z', '2026-10-25T04:00Z']],
      ['30 2 * * *', B, '2026-10-24T12:00Z', '2026-10-25T12:00Z', ['2026-10-25T00:30Z']],
      ['0 2,3 * * *', B, '2026-03-28T12:00Z', '2026-03-29T12:00Z', ['2026-03-29T01:00Z']],
      // the whole local day of 2026-10-25: 25 hours
      ['0 * * * *', B, '2026-10-24T21:30Z', '2026-10-25T22:30Z', hours('2026-10-24T22:00Z', 25)],
      // the whole local day of 2026-03-29: 23 hours
      ['0 * * * *', B, '2026-03-28T22:30Z', '2026-03-29T21:30Z', hours('2026-03-28T23:00Z', 23)],
      ['*/30 * * * *', B, '2026-03-29T00:00Z', '2026-03-29T02:00Z', ['2026-03-29T00:30Z', '2026-03-29T01:00Z', '2026-03-29T01:30Z']],
      ['0 9 * * *', 'Pacific/Apia', '2011-12-29T12:00Z', '2011-12-31T00:00Z', ['2011-12-29T19:00Z', '2011-12-30T10:00Z', '2011-12-30T19:00Z']],
    ];
    for (const [cron, tz, from, to, expected] of rows) expect(chain(cron, tz, from, to), `${cron} ${tz} ${from}`).toEqual(expected.map(iso));
  });

  it('cron: spring-forward gap time fires once at first valid instant', () => {
    expect(chain('30 2 * * *', B, '2026-03-27T12:00Z', '2026-03-30T12:00Z')).toEqual(['2026-03-28T01:30Z', '2026-03-29T01:00Z', '2026-03-30T00:30Z'].map(iso));
  });

  it('cron: multi-match gap */30 2 * * * fires once at the transition', () => {
    expect(chain('*/30 2 * * *', B, '2026-03-28T12:00Z', '2026-03-29T12:00Z')).toEqual([iso('2026-03-29T01:00Z')]);
  });

  it('cron: range 0 0-5 * * * on spring-forward day fires 5 times, on fall-back day 6 times', () => {
    expect(chain('0 0-5 * * *', B, '2026-03-28T12:00Z', '2026-03-29T12:00Z')).toEqual(
      ['2026-03-28T23:00Z', '2026-03-29T00:00Z', '2026-03-29T01:00Z', '2026-03-29T02:00Z', '2026-03-29T03:00Z'].map(iso),
    );
    expect(chain('0 0-5 * * *', B, '2026-10-24T12:00Z', '2026-10-25T12:00Z')).toEqual(
      ['2026-10-24T22:00Z', '2026-10-24T23:00Z', '2026-10-25T00:00Z', '2026-10-25T02:00Z', '2026-10-25T03:00Z', '2026-10-25T04:00Z'].map(iso),
    );
  });

  it('cron: fall-back repeated time fires once at the first occurrence', () => {
    expect(chain('30 2 * * *', B, '2026-10-24T12:00Z', '2026-10-25T12:00Z')).toEqual([iso('2026-10-25T00:30Z')]);
  });

  it('cron: hourly expression fires in both passes of repeated hour', () => {
    expect(chain('0 * * * *', B, '2026-10-24T22:00Z', '2026-10-25T04:30Z')).toEqual(hours('2026-10-24T23:00Z', 6));
    expect(chain('*/30 * * * *', B, '2026-03-29T00:00Z', '2026-03-29T02:00Z')).toEqual(['2026-03-29T00:30Z', '2026-03-29T01:00Z', '2026-03-29T01:30Z'].map(iso));
  });

  it('cron: dst rules hold in New York, Sydney, Lord Howe and Santiago', () => {
    const NY = 'America/New_York';
    const SY = 'Australia/Sydney';
    const LH = 'Australia/Lord_Howe';
    const SA = 'America/Santiago';
    const rows: Row[] = [
      ['30 2 * * *', NY, '2026-03-07T12:00Z', '2026-03-09T12:00Z', ['2026-03-08T07:00Z', '2026-03-09T06:30Z']],
      ['30 1 * * *', NY, '2026-10-31T12:00Z', '2026-11-01T12:00Z', ['2026-11-01T05:30Z']],
      ['*/30 * * * *', NY, '2026-11-01T04:50Z', '2026-11-01T07:10Z', ['2026-11-01T05:00Z', '2026-11-01T05:30Z', '2026-11-01T06:00Z', '2026-11-01T06:30Z', '2026-11-01T07:00Z']],
      ['30 2 * * *', SY, '2026-04-03T20:00Z', '2026-04-05T12:00Z', ['2026-04-04T15:30Z']],
      ['30 2 * * *', SY, '2026-10-02T20:00Z', '2026-10-04T12:00Z', ['2026-10-03T16:00Z']],
      ['15 2 * * *', LH, '2026-10-02T12:00Z', '2026-10-04T12:00Z', ['2026-10-02T15:45Z', '2026-10-03T15:30Z']],
      ['45 1 * * *', LH, '2026-04-03T20:00Z', '2026-04-05T12:00Z', ['2026-04-04T14:45Z']],
      ['*/15 * * * *', LH, '2026-04-04T14:20Z', '2026-04-04T15:40Z', ['2026-04-04T14:30Z', '2026-04-04T14:45Z', '2026-04-04T15:00Z', '2026-04-04T15:15Z', '2026-04-04T15:30Z']],
      ['0 0 * * *', SA, '2026-09-04T12:00Z', '2026-09-07T12:00Z', ['2026-09-05T04:00Z', '2026-09-06T04:00Z', '2026-09-07T03:00Z']],
      ['30 23 * * *', SA, '2026-04-03T12:00Z', '2026-04-06T12:00Z', ['2026-04-04T02:30Z', '2026-04-05T02:30Z', '2026-04-06T03:30Z']],
    ];
    for (const [cron, tz, from, to, expected] of rows) expect(chain(cron, tz, from, to), `${cron} ${tz} ${from}`).toEqual(expected.map(iso));
  });
});
