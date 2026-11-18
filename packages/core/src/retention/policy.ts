import { InvalidOptionError, type ConfigIssue } from '../errors/catalog.js';
import type { CompleteRequest, JobRecord } from '../store/contract.js';
import { tryParseDuration, type Duration } from '../util/duration.js';
import { closest, validate, type Schema } from '../util/validate.js';

/**
 * How long finished jobs of one outcome are kept: `true` forever, `false` or `0` none, a number keeps the newest N,
 * `{ count, age }` removes a job when either limit is hit (`count: 0` or `age: 0` is none).
 */
export type Keep = boolean | number | { count?: number; age?: Duration };
/** A job's own keep: `true` forever, `false` or `0` none, else an age (a single job has no "newest N"). */
export type JobKeep = boolean | 0 | Duration | { age: Duration };

/** Per-outcome policies of a queue or of one job name. */
export interface RetentionPolicies {
  /** How long completed jobs are kept. Default: the newest 1000. */
  completed?: Keep;
  /** How long failed jobs that are not dead letters are kept. Default: 14 days. */
  failed?: Keep;
  /** Default: the same as `failed`. */
  cancelled?: Keep;
}
/** The queue's `retention` option. */
export interface RetentionOptions extends RetentionPolicies {
  /** Per job name; counts only that name's jobs. */
  byName?: Record<string, RetentionPolicies>;
  /** How often the cleanup pass runs (on pods that run workers). Default `'60s'`. */
  interval?: Duration;
  /** Jobs deleted per store call, 1 to 5000. Default 500. */
  pageSize?: number;
  /** How long a keep-none record stays readable (with its result or error). `0` deletes it at finish. Default `'30s'`. */
  resultGrace?: Duration;
  /** The age kept for jobs added with `uniqueWhile: 'retained'` when no rule gives one. Default `'7d'`. */
  retainedAge?: Duration;
}

export type Outcome = 'completed' | 'failed' | 'cancelled';
export type Policy = 'none' | 'forever' | { count?: number; ageMs?: number };

export interface ResolvedRetention {
  completed: Policy;
  failed: Policy;
  cancelled: Policy;
  byName: Record<string, Partial<Record<Outcome, Policy>>>;
  intervalMs: number;
  pageSize: number;
  resultGraceMs: number;
  retainedAgeMs: number;
  /** Set when a bounded `failed` is given while dead letters are on: it bounds only failures that are not dead letters. */
  warning?: string;
}

const OUTCOMES: readonly Outcome[] = ['completed', 'failed', 'cancelled'];
const DAY = 86_400_000;
export const DEFAULT_COMPLETED: Policy = Object.freeze({ count: 1000 });
export const DEFAULT_FAILED: Policy = Object.freeze({ ageMs: 14 * DAY });
const KEEP_RULE = 'expected true, false, a count >= 0 or { count?, age? }';
const JOB_KEEP_RULE = 'expected true, false, 0, a duration or { age }';
/** A bare number on a job is milliseconds, but on the queue retention it is a count: refuse it on the job. */
const BARE_NUMBER_JOB_KEEP = 'a bare number is ambiguous on a job: write a duration such as "1000ms" or { age: 1000 }';
const DURATION_RULE = 'expected non-negative whole milliseconds or a string like "30s"';

type Add = (issue: ConfigIssue) => void;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownKeys(v: Record<string, unknown>, allowed: readonly string[], path: string, add: Add): void {
  for (const key of Object.keys(v)) {
    if (allowed.includes(key)) continue;
    const suggestion = closest(key, allowed);
    add({ path: `${path}.${key}`, code: 'unknown_option', message: `unknown option${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`, ...(suggestion && { suggestion }) });
  }
}

function age(v: unknown, path: string, add: Add): number | undefined {
  const r = tryParseDuration(v);
  if (r.ok) return r.ms;
  add({ path, code: r.code, message: DURATION_RULE, expected: DURATION_RULE });
  return undefined;
}

/** A queue or `byName` `Keep`; undefined (with an issue) when it is not one. */
function parseKeep(v: unknown, path: string, add: Add): Policy | undefined {
  if (v === true) return 'forever';
  if (v === false) return 'none';
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v) && v >= 0) return v === 0 ? 'none' : { count: v };
    add({ path, code: Number.isFinite(v) && v >= 0 ? 'invalid_value' : 'out_of_range', message: KEEP_RULE, expected: KEEP_RULE });
    return undefined;
  }
  if (!isPlainObject(v)) {
    add({ path, code: 'invalid_type', message: KEEP_RULE, expected: KEEP_RULE });
    return undefined;
  }
  unknownKeys(v, ['count', 'age'], path, add);
  let count: number | undefined;
  if (v['count'] !== undefined) {
    if (Number.isSafeInteger(v['count']) && (v['count'] as number) >= 0) count = v['count'] as number;
    else add({ path: `${path}.count`, code: 'out_of_range', message: 'expected an integer >= 0' });
  }
  const ageMs = v['age'] === undefined ? undefined : age(v['age'], `${path}.age`, add);
  if (count === 0 || ageMs === 0) return 'none';
  if (count === undefined && ageMs === undefined) {
    // an empty object sets no limit at all: say so instead of reading it as forever
    if (Object.keys(v).length === 0) add({ path, code: 'invalid_value', message: `${KEEP_RULE} (use true to keep forever)`, expected: KEEP_RULE });
    return undefined;
  }
  return { ...(count !== undefined && { count }), ...(ageMs !== undefined && { ageMs }) };
}

/** A job's `JobKeep`; undefined (with an issue) when it is not one. */
function parseOneJobKeep(v: unknown, path: string, add: Add): Policy | undefined {
  if (v === true) return 'forever';
  if (v === false || v === 0) return 'none';
  let ageMs: number | undefined;
  if (isPlainObject(v)) {
    if (v['count'] !== undefined) add({ path: `${path}.count`, code: 'invalid_value', message: 'a single job has no count; use age' });
    unknownKeys(v, ['age', 'count'], path, add);
    if (v['age'] === undefined) {
      if (v['count'] === undefined) add({ path: `${path}.age`, code: 'missing_option', message: 'required option is missing' });
    } else ageMs = age(v['age'], `${path}.age`, add);
  } else if (typeof v === 'string') ageMs = age(v, path, add);
  else if (typeof v === 'number') add({ path, code: 'invalid_type', message: BARE_NUMBER_JOB_KEEP, expected: JOB_KEEP_RULE });
  else add({ path, code: 'invalid_type', message: JOB_KEEP_RULE, expected: JOB_KEEP_RULE });
  if (ageMs === undefined) return undefined;
  return ageMs === 0 ? 'none' : { ageMs };
}

/** One `{ completed?, failed?, cancelled? }` object of `Keep`s (or job `JobKeep`s). */
function parsePolicies(v: unknown, path: string, add: Add, one: typeof parseKeep): Partial<Record<Outcome, Policy>> {
  const out: Partial<Record<Outcome, Policy>> = {};
  if (!isPlainObject(v)) {
    add({ path, code: 'invalid_type', message: 'expected an object of completed, failed and cancelled' });
    return out;
  }
  unknownKeys(v, OUTCOMES, path, add);
  for (const outcome of OUTCOMES) {
    if (v[outcome] === undefined) continue;
    const policy = one(v[outcome], `${path}.${outcome}`, add);
    if (policy !== undefined) out[outcome] = policy;
  }
  return out;
}

const settingsSchema: Schema<{ retention: Record<string, unknown> }> = {
  fields: {
    retention: {
      kind: 'object',
      schema: {
        fields: {
          completed: { kind: 'unknown' }, failed: { kind: 'unknown' }, cancelled: { kind: 'unknown' }, byName: { kind: 'unknown' },
          interval: { kind: 'duration', default: 60_000 },
          pageSize: { kind: 'integer', min: 1, max: 5000, default: 500 },
          resultGrace: { kind: 'duration', default: 30_000 },
          retainedAge: { kind: 'duration', default: 7 * DAY },
        },
      },
    },
  },
};

/**
 * The queue's `retention` option with every default. Issues carry the `retention.` path. A queue `failed` of keep none
 * conflicts with dead letters on; a `failed` set while they are on yields `value.warning`.
 */
export function resolveRetention(input: unknown, deadLetterOn: boolean): { value: ResolvedRetention; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const add: Add = (i) => issues.push(i);
  let raw: Record<string, unknown> = {};
  try {
    raw = validate('retention', { retention: input ?? {} }, settingsSchema).retention;
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    issues.push(...e.issues);
  }
  const own = parsePolicies(isPlainObject(input) ? { completed: input['completed'], failed: input['failed'], cancelled: input['cancelled'] } : {}, 'retention', add, parseKeep);
  const byName: ResolvedRetention['byName'] = {};
  const names = isPlainObject(input) ? input['byName'] : undefined;
  if (names !== undefined) {
    if (!isPlainObject(names)) add({ path: 'retention.byName', code: 'invalid_type', message: 'expected an object of job names' });
    else {
      for (const [name, policies] of Object.entries(names)) {
        if (name === '') add({ path: 'retention.byName', code: 'invalid_value', message: 'expected non-empty job names' });
        else byName[name] = parsePolicies(policies, `retention.byName.${name}`, add, parseKeep);
      }
    }
  }
  if (deadLetterOn && own.failed === 'none') {
    add({ path: 'retention.failed', code: 'conflict', message: 'keep none for failed jobs conflicts with deadLetter on: set deadLetter: false, or deadLetter.keep for dead letters' });
  }
  const failed = own.failed ?? DEFAULT_FAILED;
  const value: ResolvedRetention = {
    completed: own.completed ?? DEFAULT_COMPLETED, failed, cancelled: own.cancelled ?? failed, byName,
    intervalMs: (raw['interval'] as number | undefined) ?? 60_000, pageSize: (raw['pageSize'] as number | undefined) ?? 500,
    resultGraceMs: (raw['resultGrace'] as number | undefined) ?? 30_000, retainedAgeMs: (raw['retainedAge'] as number | undefined) ?? 7 * DAY,
  };
  // failed jobs kept forever are bounded by nothing, so there is nothing for dead letters to escape
  const warn = deadLetterOn && own.failed !== undefined && own.failed !== 'forever'
    ? 'retention.failed bounds only failed jobs that are not dead letters; dead letters are kept until redriven or removed unless deadLetter.keep is set'
    : undefined;
  if (warn !== undefined) value.warning = warn;
  return { value, issues };
}

/** A job's `keep` option; `keep none` on a job added `retained` would free its id at once, so it is an issue there. */
export function parseJobKeep(input: unknown, uniqueWhile: 'pending' | 'retained'): { value?: Partial<Record<Outcome, Policy>>; issues: ConfigIssue[] } {
  if (input === undefined) return { issues: [] };
  const issues: ConfigIssue[] = [];
  const value = parsePolicies(input, 'keep', (i) => issues.push(i), parseOneJobKeep);
  if (uniqueWhile === 'retained') {
    for (const outcome of OUTCOMES) {
      if (value[outcome] === 'none') issues.push({ path: `keep.${outcome}`, code: 'conflict', message: "keep none frees the id of a uniqueWhile 'retained' job at once" });
    }
  }
  return issues.length > 0 ? { issues } : { value, issues };
}

/** The job's stored `keep`, or undefined when it has none or it cannot be read. */
function storedKeep(job: Pick<JobRecord, 'keep' | 'uniqueWhile'>): Partial<Record<Outcome, Policy>> | undefined {
  if (job.keep === null) return undefined;
  try {
    return parseJobKeep(JSON.parse(typeof job.keep === 'string' ? job.keep : new TextDecoder().decode(job.keep)), job.uniqueWhile).value;
  } catch {
    return undefined;
  }
}

/** The `deadLetter: { keep }` option as the store's `keepMs`: dead letters are kept by age only, and keep none is `deadLetter: false`. */
export function deadLetterKeepMs(input: unknown, add: Add): number | undefined {
  if (input === undefined) return undefined;
  const issues: ConfigIssue[] = [];
  const policy = parseKeep(input, 'deadLetter.keep', (i) => issues.push(i));
  if (policy === 'none') issues.push({ path: 'deadLetter.keep', code: 'conflict', message: 'to keep no dead letters set deadLetter: false' });
  else if (typeof policy === 'object' && policy.count !== undefined) issues.push({ path: 'deadLetter.keep.count', code: 'invalid_value', message: 'dead letters are kept by age only; use { age }' });
  for (const i of issues) add(i);
  return issues.length === 0 && typeof policy === 'object' ? policy.ageMs : undefined;
}

/** False when the job set its own `keep.failed`: such a job is never dead-lettered. */
export function deadLetters(job: Pick<JobRecord, 'keep'>, deadLetterOn: boolean): boolean {
  return deadLetterOn && storedKeep({ keep: job.keep, uniqueWhile: 'pending' })?.failed === undefined;
}

const ageOf = (p: Policy | undefined): number | undefined => (typeof p === 'object' ? p.ageMs : undefined);

/** The policy that applies when `job` reaches `outcome`: its own keep, then its name's, then the queue's (defaults included). */
export function policyFor(cfg: ResolvedRetention, job: Pick<JobRecord, 'name' | 'keep' | 'uniqueWhile'>, outcome: Outcome): Policy {
  const chain = [storedKeep(job)?.[outcome], job.name === null ? undefined : cfg.byName[job.name]?.[outcome], cfg[outcome]];
  // A retained job holds its id until deleted, so count rules never apply to it: the first age (or forever) in the chain, else retainedAge.
  if (job.uniqueWhile === 'retained') {
    const kept = chain.find((p) => p === 'forever' || ageOf(p) !== undefined);
    return kept === 'forever' ? kept : { ageMs: ageOf(kept) ?? cfg.retainedAgeMs };
  }
  return chain.find((p) => p !== undefined)!;
}

/** What a write that finishes `job` with `outcome` sends: delete or a grace for keep none, `retainMs` for an age, nothing otherwise. */
export function finishExt(cfg: ResolvedRetention, job: Pick<JobRecord, 'name' | 'keep' | 'uniqueWhile'>, outcome: Outcome): Pick<CompleteRequest, 'retention'> {
  const policy = policyFor(cfg, job, outcome);
  // a grace record keeps its closed attempt, deleted with it by the pass
  if (policy === 'none') return { retention: cfg.resultGraceMs > 0 ? { retainMs: cfg.resultGraceMs } : { discard: true } };
  const ageMs = ageOf(policy);
  return ageMs === undefined ? {} : { retention: { retainMs: ageMs } };
}

/** The sweep's `retention`: the queue's `failed` policy, per batch, never a delete (the sweeper still announces the job). */
export function sweepExt(cfg: ResolvedRetention): Pick<CompleteRequest, 'retention'> {
  if (cfg.failed === 'none') return { retention: { retainMs: cfg.resultGraceMs } };
  const ageMs = ageOf(cfg.failed);
  return ageMs === undefined ? {} : { retention: { retainMs: ageMs } };
}
