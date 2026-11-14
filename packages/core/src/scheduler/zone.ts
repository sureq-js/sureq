import type { ConfigIssue } from '../errors/catalog.js';

const MIN = 60_000;

/** Local calendar fields of an instant in a zone. */
export interface WallClock { year: number; month: number; day: number; hour: number; minute: number }

/** The zone's offsets around a stretch of time: `before` until `at` (the first minute of `after`). */
export interface Offsets { before: number; after: number; at: number }

/** One formatter per zone ICU resolves to, and the lower-cased names seen for it (zone names are case-insensitive). */
const formats = new Map<string, Intl.DateTimeFormat>();
const byName = new Map<string, Intl.DateTimeFormat>();

/** The cached wall-clock formatter of a zone; throws RangeError for a name ICU does not know. */
export function formatFor(tz: string): Intl.DateTimeFormat {
  const key = tz.toLowerCase();
  let f = byName.get(key);
  if (!f) {
    const made = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const zone = made.resolvedOptions().timeZone;
    f = formats.get(zone) ?? made;
    formats.set(zone, f);
    byName.set(key, f);
  }
  return f;
}

/** The problem with a zone name, or undefined: `'UTC'` or an IANA region name such as `'Europe/Berlin'`. */
export function tzIssue(tz: unknown): ConfigIssue | undefined {
  if (typeof tz !== 'string') return { path: 'tz', code: 'invalid_type', reason: 'bad-timezone', message: 'expected an IANA time zone name', expected: 'string' };
  if (tz === 'UTC') return undefined;
  if (tz.includes('/')) {
    try {
      formatFor(tz);
      return undefined;
    } catch {
      // not a zone ICU knows
    }
  }
  return { path: 'tz', code: 'invalid_value', reason: 'bad-timezone', message: `"${tz.slice(0, 64)}" is not an IANA time zone name such as "Europe/Berlin" or "UTC"` };
}

/** The zone's wall clock at `ms`. */
export function wallClock(tz: string, ms: number): WallClock {
  const w = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const p of formatFor(tz).formatToParts(ms)) if (p.type in w) w[p.type as keyof WallClock] = Number(p.value);
  return w;
}

/** Local minus UTC at `ms`, in ms, at minute precision. */
export function offsetAt(tz: string, ms: number): number {
  const w = wallClock(tz, ms);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(ms / MIN) * MIN;
}

/** The offsets between two instants, assuming at most one change; `at` is Infinity when there is none. */
export function offsetsBetween(tz: string, from: number, to: number): Offsets {
  const before = offsetAt(tz, from);
  const after = offsetAt(tz, to);
  if (before === after) return { before, after, at: Infinity };
  let lo = Math.floor(from / MIN) + 1;
  let hi = Math.floor(to / MIN);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(tz, mid * MIN) === after) hi = mid;
    else lo = mid + 1;
  }
  return { before, after, at: lo * MIN };
}

/**
 * The instants whose wall clock reads the naive local time `g` (`Date.UTC` of the local fields): one normally, two in
 * an overlap (ascending), none in a gap, which reports the first instant after it.
 */
export function resolveNaive(g: number, o: Offsets): { instants: number[] } | { gapEnd: number } {
  const instants = [g - o.before, g - o.after].filter((i, k) => (k === 0 ? i < o.at : i >= o.at)).sort((a, b) => a - b);
  return instants.length > 0 ? { instants } : { gapEnd: o.at };
}
