import { InvalidOptionError, type ConfigIssueCode } from '../errors/catalog.js';

/** A length of time: whole milliseconds, or a string such as `'250ms'`, `'30s'`, `'5m'`, `'2h'`, `'1d'`. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

/** Longest allowed delay or backoff wait: 100 years. */
export const MAX_DELAY_MS = 3_153_600_000_000;

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const GRAMMAR = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

type DurationResult = { ok: true; ms: number } | { ok: false; code: Extract<ConfigIssueCode, 'invalid_type' | 'invalid_value' | 'out_of_range'> };

/** Parse without throwing; used by the option validator. */
export function tryParseDuration(v: unknown): DurationResult {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { ok: false, code: 'invalid_value' };
    if (v < 0 || !Number.isFinite(v)) return { ok: false, code: 'out_of_range' };
    return Number.isSafeInteger(v) ? { ok: true, ms: v } : { ok: false, code: 'invalid_value' };
  }
  if (typeof v !== 'string') return { ok: false, code: 'invalid_type' };
  const m = GRAMMAR.exec(v);
  if (!m) return { ok: false, code: 'invalid_value' };
  // Round away float noise (1.5 * 1000) before the integer test, so 0.0005s is still rejected.
  const ms = Number((Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]).toFixed(6));
  return Number.isSafeInteger(ms) ? { ok: true, ms } : { ok: false, code: 'invalid_value' };
}

const EXPECTED = 'non-negative whole milliseconds or a string like "30s"';

/** Parse a Duration to integer milliseconds, throwing InvalidOptionError at `path` when it is not one. */
export function parseDuration(v: Duration, path: string): number {
  const r = tryParseDuration(v);
  if (r.ok) return r.ms;
  throw new InvalidOptionError('Duration', [{ path, code: r.code, message: `expected ${EXPECTED}`, expected: EXPECTED }]);
}
