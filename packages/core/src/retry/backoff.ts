import { BackoffStrategyError, InvalidOptionError, type ConfigIssue } from '../errors/catalog.js';
import type { Job } from '../job/job.js';
import { MAX_DELAY_MS, tryParseDuration, type Duration } from '../util/duration.js';
import { validate, type Schema } from '../util/validate.js';

/** Random spread applied to a computed backoff delay. */
export type Jitter = 'none' | 'full' | 'equal';

/**
 * How long to wait before each retry: a Duration is a fixed wait; an object picks a
 * built-in strategy or the name of one registered on the worker.
 */
export type BackoffSpec =
  | Duration
  | {
      type: 'fixed' | 'exponential' | (string & {});
      delay?: Duration;
      factor?: number;
      maxDelay?: Duration;
      jitter?: Jitter;
    };

/** A named strategy registered on a worker (`backoffStrategies`). Returns ms, finite, >= 0. */
export type BackoffFn = (attempt: number, error: Error, job: Job, spec: StoredBackoff) => number;

/** The spec as stored on the job: numbers only, every default filled in. */
export type StoredBackoff = { type: string; delay: number; factor?: number; maxDelay?: number; jitter: Jitter };

export const DEFAULT_BACKOFF: Readonly<StoredBackoff> = Object.freeze({ type: 'exponential', delay: 1000, factor: 2, maxDelay: 3_600_000, jitter: 'full' });

const BUILT_IN = new Set(['fixed', 'exponential']);
const MAX_TYPE_LENGTH = 64;
const DELAY_RULE = `non-negative whole milliseconds or a Duration string, at most ${MAX_DELAY_MS} ms (100 years)`;

type ObjectSpec = { type: string; delay?: number; factor?: number; maxDelay?: number; jitter?: Jitter };
const specSchema: Schema<ObjectSpec> = {
  fields: {
    type: { kind: 'string', required: true },
    delay: { kind: 'duration' },
    factor: { kind: 'number' },
    maxDelay: { kind: 'duration' },
    jitter: { kind: 'enum', values: ['none', 'full', 'equal'] },
  },
  check: (v, add) => {
    if (typeof v.type === 'string' && (v.type.length === 0 || v.type.length > MAX_TYPE_LENGTH)) {
      add({ path: 'type', code: 'invalid_value', message: `expected 1-${MAX_TYPE_LENGTH} characters` });
    }
    for (const k of ['delay', 'maxDelay'] as const) {
      const ms = v[k];
      if (ms !== undefined && ms > MAX_DELAY_MS) add({ path: k, code: 'out_of_range', message: `expected ${DELAY_RULE}`, expected: DELAY_RULE });
    }
    if (v.factor !== undefined && !(v.factor > 1)) add({ path: 'factor', code: 'out_of_range', message: 'expected a finite number > 1' });
    if (v.type === 'fixed' && v.maxDelay !== undefined) {
      add({ path: 'maxDelay', code: 'conflict', message: 'fixed backoff is never capped; remove maxDelay or use exponential' });
    }
  },
};

/** Validate a backoff spec and resolve it to the stored form. Throws InvalidOptionError with issues under `path`. */
export function normalizeBackoff(spec: BackoffSpec | undefined, path: string): StoredBackoff {
  if (spec === undefined) return { ...DEFAULT_BACKOFF };
  if (typeof spec === 'number' || typeof spec === 'string') {
    const r = tryParseDuration(spec);
    if (r.ok && r.ms <= MAX_DELAY_MS) return { type: 'fixed', delay: r.ms, jitter: 'none' };
    throw new InvalidOptionError('backoff', [{ path, code: r.ok ? 'out_of_range' : r.code, message: `expected ${DELAY_RULE}`, expected: DELAY_RULE }]);
  }
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new InvalidOptionError('backoff', [{ path, code: 'invalid_type', message: 'expected a Duration or { type, delay?, factor?, maxDelay?, jitter? }' }]);
  }
  let v: ObjectSpec;
  try {
    v = validate('backoff', spec, specSchema);
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    throw new InvalidOptionError('backoff', e.issues.map((i: ConfigIssue) => ({ ...i, path: `${path}.${i.path}` })));
  }
  const delay = v.delay ?? 1000;
  if (v.type === 'exponential') return { type: v.type, delay, factor: v.factor ?? 2, maxDelay: v.maxDelay ?? 3_600_000, jitter: v.jitter ?? 'full' };
  if (v.type === 'fixed') return { type: v.type, delay, jitter: v.jitter ?? 'none' };
  // A custom strategy's value is used as returned unless the user asks for jitter or a cap.
  return { type: v.type, delay, ...(v.factor !== undefined && { factor: v.factor }), ...(v.maxDelay !== undefined && { maxDelay: v.maxDelay }), jitter: v.jitter ?? 'none' };
}

/**
 * The wait before the next attempt after `attempt` failed: raw delay → cap → jitter → floor.
 * `random` returns [0, 1). Custom strategies (by `spec.type`) get `ctx`; a bad one falls back to the default.
 */
export function computeBackoff(
  spec: StoredBackoff,
  attempt: number,
  strategies: Readonly<Record<string, BackoffFn>>,
  random: () => number,
  ctx?: { error: Error; job: Job },
): { delayMs: number; error?: BackoffStrategyError } {
  let raw: number;
  if (spec.type === 'fixed') raw = spec.delay;
  else if (spec.type === 'exponential') {
    const product = spec.delay === 0 ? 0 : spec.delay * (spec.factor ?? 2) ** (attempt - 1);
    raw = Number.isFinite(product) ? product : (spec.maxDelay ?? MAX_DELAY_MS);
  } else {
    // A bad strategy must not strand the job: retry on the built-in default and report why.
    const fn = Object.hasOwn(strategies, spec.type) ? strategies[spec.type] : undefined;
    const fallback = (reason: 'unknown' | 'threw' | 'invalid-result', cause?: unknown) => ({
      delayMs: computeBackoff(DEFAULT_BACKOFF, attempt, {}, random).delayMs,
      error: new BackoffStrategyError(cause === undefined ? { reason } : { reason, cause }),
    });
    if (typeof fn !== 'function' || !ctx) return fallback('unknown');
    let v: unknown;
    try {
      v = fn(attempt, ctx.error, ctx.job, spec);
    } catch (e) {
      return fallback('threw', e);
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_DELAY_MS) return fallback('invalid-result');
    raw = v;
  }
  // `fixed` is never capped; exponential always has maxDelay; custom only when given.
  const capped = spec.type !== 'fixed' && spec.maxDelay !== undefined ? Math.min(raw, spec.maxDelay) : raw;
  return { delayMs: Math.floor(applyJitter(capped, spec.jitter, random)) };
}

function applyJitter(c: number, jitter: Jitter, random: () => number): number {
  if (jitter === 'full') return random() * c;
  if (jitter === 'equal') return c / 2 + random() * (c / 2);
  return c;
}

/** The issues with a worker's `backoffStrategies`: functions only, and not the built-in names. */
export function backoffStrategyIssues(strategies: unknown): ConfigIssue[] {
  if (strategies === undefined) return [];
  if (typeof strategies !== 'object' || strategies === null || Array.isArray(strategies)) {
    return [{ path: 'backoffStrategies', code: 'invalid_type', message: 'expected an object of { name: function }' }];
  }
  const issues: ConfigIssue[] = [];
  for (const [name, fn] of Object.entries(strategies)) {
    if (BUILT_IN.has(name)) issues.push({ path: `backoffStrategies.${name}`, code: 'conflict', message: `"${name}" is a built-in strategy; choose another name` });
    else if (typeof fn !== 'function') issues.push({ path: `backoffStrategies.${name}`, code: 'invalid_type', message: 'expected a function' });
  }
  return issues;
}

/** Throw InvalidOptionError when `backoffStrategies` is invalid. */
export function validateBackoffStrategies(strategies: Record<string, BackoffFn> | undefined): void {
  const issues = backoffStrategyIssues(strategies);
  if (issues.length > 0) throw new InvalidOptionError('process', issues);
}
