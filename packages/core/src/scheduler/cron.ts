import { InternalError, InvalidOptionError, type ConfigIssue } from '../errors/catalog.js';
import { offsetsBetween, resolveNaive, tzIssue, wallClock } from './zone.js';

/** A parsed 5-field cron expression. `dow` holds 0-6 (Sunday is 0). */
export interface CronSpec {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  /** The field text does not start with `*`. */
  domRestricted: boolean;
  dowRestricted: boolean;
  /** The hour field is `*` or has a step: the expression follows elapsed time across daylight-saving changes. */
  periodic: boolean;
}

const ALIASES: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** name, min, max, and the names that stand for `offset + index`. */
const FIELDS: readonly [string, number, number, readonly string[], number][] = [
  ['minute', 0, 59, [], 0],
  ['hour', 0, 23, [], 0],
  ['day-of-month', 1, 31, [], 0],
  ['month', 1, 12, MONTHS, 1],
  ['day-of-week', 0, 7, DAYS, 0],
];

const ITEM = /^(?:(\*)|([0-9A-Za-z]+)(?:-([0-9A-Za-z]+))?)(?:\/(\d+))?$/;

class CronSyntax extends Error {}

function parseField(text: string, [name, min, max, names, offset]: (typeof FIELDS)[number]): Set<number> {
  const value = (v: string): number => {
    const i = names.indexOf(v.toUpperCase());
    const n = i >= 0 ? i + offset : /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isNaN(n)) throw new CronSyntax(`${name}: "${v}" is not a number or name`);
    if (n < min || n > max) throw new CronSyntax(`${name}: ${n} is out of range ${min}-${max}`);
    return n;
  };
  const out = new Set<number>();
  for (const item of text.split(',')) {
    const m = ITEM.exec(item);
    if (!m) throw new CronSyntax(`${name}: "${item}" is not *, a value, a range or a step`);
    const [, star, a, b, step] = m;
    if (step !== undefined && !star && b === undefined) throw new CronSyntax(`${name}: a step needs * or a range, received "${item}"`);
    const lo = star ? min : value(a!);
    const hi = star ? max : b !== undefined ? value(b) : lo;
    if (lo > hi) throw new CronSyntax(`${name}: range ${a}-${b} is reversed`);
    const n = step === undefined ? 1 : Number(step);
    if (n < 1 || n > max) throw new CronSyntax(`${name}: step ${step} is out of range 1-${max}`);
    for (let v = lo; v <= hi; v += n) out.add(name === 'day-of-week' && v === 7 ? 0 : v);
  }
  return out;
}

function parse(expr: string): CronSpec {
  const text = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  if (text.startsWith('@')) throw new CronSyntax(`unknown alias "${text}"`);
  const parts = text.split(/\s+/);
  if (text === '' || parts.length !== 5) throw new CronSyntax(`expected 5 fields, received ${text === '' ? 0 : parts.length}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return {
    minute, hour, dom, month, dow,
    domRestricted: !parts[2]!.startsWith('*'),
    dowRestricted: !parts[4]!.startsWith('*'),
    periodic: parts[1] === '*' || parts[1]!.includes('/'),
  };
}

/** The problem with a cron expression, or undefined when it is valid. */
export function cronIssue(expr: unknown): ConfigIssue | undefined {
  if (typeof expr !== 'string') {
    return { path: 'cron', code: 'invalid_type', reason: 'bad-cron', message: 'expected a cron expression string', expected: 'string' };
  }
  try {
    parse(expr);
    return undefined;
  } catch (err) {
    if (!(err instanceof CronSyntax)) throw err;
    return { path: 'cron', code: 'invalid_value', reason: 'bad-cron', message: err.message };
  }
}

/** Parse a cron expression that `cronIssue` accepted. */
export function parseCron(expr: string): CronSpec {
  try {
    return parse(expr);
  } catch (err) {
    throw err instanceof CronSyntax ? new InternalError(err.message) : err;
  }
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The widest offset from UTC any zone uses; no instant of local date D is before `Date.UTC(D) - MAX_OFFSET`. */
const MAX_OFFSET = 14 * HOUR;
/** Local years searched after the year of the start instant. */
const SEARCH_YEARS = 9;

function dayMatches(spec: CronSpec, day0: number, day: number): boolean {
  const dom = spec.dom.has(day);
  const dow = spec.dow.has(new Date(day0).getUTCDay());
  // Vixie: OR only when both fields are restricted (do not start with `*`), otherwise AND.
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  return dom && dow;
}

/**
 * The first instant after `afterMs` whose wall clock in `tz` matches, with the daylight-saving rules: a periodic
 * expression fires in both passes of a repeated time and skips a missing one; a clock-time expression fires once, at
 * the earlier pass or, for a missing time, at the end of the gap. Null when no local date through Dec 31 of the
 * start's local year plus 9 matches.
 */
export function nextCronMatch(spec: CronSpec, tz: string, afterMs: number): number | null {
  const start = wallClock(tz, afterMs);
  const lastYear = start.year + SEARCH_YEARS;
  // One day early: a fall-back across midnight repeats times of the previous local date.
  let day0 = Date.UTC(start.year, start.month - 1, start.day) - DAY;
  let best: number | undefined;
  for (;;) {
    if (best !== undefined && day0 - MAX_OFFSET > best) break;
    const date = new Date(day0);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    if (year > lastYear) break;
    if (!spec.month.has(month)) {
      day0 = Date.UTC(year, month, 1);
      continue;
    }
    if (dayMatches(spec, day0, date.getUTCDate())) {
      // Assumes the zone changes its offset at most once in this 3-day window (true of every IANA rule).
      const o = offsetsBetween(tz, day0 - DAY, day0 + 2 * DAY);
      const lo = Math.min(o.before, o.after);
      const hi = Math.max(o.before, o.after);
      hours: for (let h = 0; h < 24; h++) {
        if (!spec.hour.has(h)) continue;
        for (let m = 0; m < 60; m++) {
          if (!spec.minute.has(m)) continue;
          const g = day0 + h * HOUR + m * MIN;
          if (g - lo <= afterMs) continue;
          if (best !== undefined && g - hi > best) break hours;
          const r = resolveNaive(g, o);
          const cands = 'gapEnd' in r ? (spec.periodic ? [] : [r.gapEnd]) : spec.periodic ? r.instants : r.instants.slice(0, 1);
          for (const c of cands) if (c > afterMs && (best === undefined || c < best)) best = c;
        }
      }
    }
    day0 += DAY;
  }
  return best ?? null;
}

/** The first instant after `afterMs` matching the cron rule `t`; throws InvalidOptionError for a bad `cron` or `tz`. */
export function nextCronOccurrence(t: { cron: string; tz?: string }, afterMs: number): number | null {
  const tz = t.tz ?? 'UTC';
  const issues = [cronIssue(t.cron), tzIssue(tz)].filter((i): i is ConfigIssue => i !== undefined);
  if (issues.length > 0) throw new InvalidOptionError('cron', issues);
  return nextCronMatch(parseCron(t.cron), tz, afterMs);
}
