import { describe, expect, it } from 'vitest';
import { cronIssue, parseCron } from '../../src/scheduler/cron.js';

const set = (...v: number[]) => new Set(v);
const range = (a: number, b: number) => set(...Array.from({ length: b - a + 1 }, (_, i) => a + i));

describe('cron parser', () => {
  it('cron: ranges, lists, steps, names and aliases parse', () => {
    expect(cronIssue('5-10/2 */6 1,15 JAN-mar mon-FRI')).toBeUndefined();
    expect(parseCron('5-10/2 */6 1,15 JAN-mar mon-FRI')).toEqual({
      minute: set(5, 7, 9), hour: set(0, 6, 12, 18), dom: set(1, 15), month: set(1, 2, 3), dow: range(1, 5),
      domRestricted: true, dowRestricted: true, periodic: true,
    });
    expect(parseCron('0 0 */2 * 1')).toMatchObject({ domRestricted: false, dowRestricted: true });
    expect(parseCron('0 0 1-31/2 * *')).toMatchObject({ domRestricted: true, dowRestricted: false });
    expect(parseCron('* * * * *')).toMatchObject({ minute: range(0, 59), hour: range(0, 23), dom: range(1, 31), month: range(1, 12), dow: range(0, 6) });
    expect(parseCron('@weekly')).toEqual(parseCron('0 0 * * 0'));
    expect(parseCron('@HOURLY')).toEqual(parseCron('0 * * * *'));
    expect(parseCron('@yearly')).toEqual(parseCron('0 0 1 1 *'));
    expect(parseCron('@monthly')).toEqual(parseCron('0 0 1 * *'));
    expect(parseCron('@daily')).toEqual(parseCron('0 0 * * *'));
    expect(parseCron('  0   0 * * *  ')).toEqual(parseCron('0 0 * * *'));
    for (const e of ['0 0-5 * * *', '0 2,3 * * *', '*/30 2 * * *']) expect(parseCron(e).periodic).toBe(false);
    for (const e of ['0 */2 * * *', '0 1,*/5 * * *', '0 * * * *', '0 0-10/5 * * *']) expect(parseCron(e).periodic).toBe(true);
  });

  it('cron: weekday 0 and 7 are both Sunday', () => {
    expect(parseCron('0 0 * * 7').dow).toEqual(set(0));
    expect(parseCron('0 0 * * 0').dow).toEqual(set(0));
    expect(parseCron('0 0 * * 5-7').dow).toEqual(set(5, 6, 0));
    expect(parseCron('0 0 * * SUN').dow).toEqual(set(0));
  });

  it('cron: invalid expressions are rejected with bad-cron', () => {
    const bad: unknown[] = [
      '', '   ', '0 0 * * * *', '* * * *', '0 0 L * *', '0 0 15W * *', '0 0 * * 5#3', '0 0 ? * *', '60 * * * *',
      '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', '*/61 * * * *',
      '5/10 * * * *', '1,,2 * * * *', '1- * * * *', '-1 * * * *', '1.5 * * * *', '@annually', '@reboot', 'FOO * * * *',
      '* * * JANUARY *', '* * * * JAN', '* * * MON *', 42,
    ];
    for (const expr of bad) {
      const issue = cronIssue(expr);
      expect(issue, String(expr)).toMatchObject({ path: 'cron', reason: 'bad-cron' });
    }
    expect(cronIssue(42)).toMatchObject({ code: 'invalid_type' });
    expect(cronIssue('60 * * * *')).toMatchObject({ code: 'invalid_value', message: 'minute: 60 is out of range 0-59' });
    expect(cronIssue('* * * 13 *')?.message).toBe('month: 13 is out of range 1-12');
    expect(() => parseCron('60 * * * *')).toThrow('minute: 60 is out of range 0-59');
  });
});
