import type { ConfigIssue } from '../errors/catalog.js';
import { MAX_DELAY_MS, tryParseDuration } from '../util/duration.js';

const MIN_EVERY_MS = 1000;
const GRAMMAR = /^\d+(ms|s|m|h|d)$/;
const EXPECTED = 'whole milliseconds from 1000 to 100 years, or a string like "30s" (units ms, s, m, h, d)';

function toMs(every: unknown): number | undefined {
  if (typeof every === 'number') return Number.isSafeInteger(every) ? every : undefined;
  if (typeof every !== 'string' || !GRAMMAR.test(every)) return undefined;
  const r = tryParseDuration(every);
  return r.ok ? r.ms : undefined;
}

/** The problem with an `every` period, or undefined when it is valid. */
export function everyIssue(every: unknown): ConfigIssue | undefined {
  const ms = toMs(every);
  if (ms !== undefined && ms >= MIN_EVERY_MS && ms <= MAX_DELAY_MS) return undefined;
  const code = ms !== undefined && ms > MAX_DELAY_MS ? 'out_of_range' : typeof every === 'number' || typeof every === 'string' ? 'invalid_value' : 'invalid_type';
  return { path: 'every', code, reason: 'bad-interval', message: `expected ${EXPECTED}`, expected: EXPECTED };
}

/** The period in ms of an `every` that `everyIssue` accepted. */
export function parseEvery(every: number | string): number {
  return toMs(every)!;
}

/** The first grid point `anchorAt + k * everyMs` after `afterMs`: late fires never drift the grid. */
export function nextEveryOccurrence(everyMs: number, anchorAt: number, afterMs: number): number {
  return anchorAt + (Math.floor((afterMs - anchorAt) / everyMs) + 1) * everyMs;
}
