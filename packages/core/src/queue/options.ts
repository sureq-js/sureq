import { InvalidOptionError, type ConfigIssue } from '../errors/catalog.js';
import type { Logger } from '../logger/logger.js';
import type { Store } from '../store/contract.js';
import { storeCapabilityIssues } from '../store/capabilities.js';
import { backoffStrategyIssues, normalizeBackoff, type BackoffFn, type BackoffSpec, type StoredBackoff } from '../retry/backoff.js';
import type { Job } from '../job/job.js';
import { MAX_DELAY_MS, tryParseDuration, type Duration } from '../util/duration.js';
import { deepFreeze } from '../util/freeze.js';
import { closest, validate, type Schema } from '../util/validate.js';
import type { FilterFn } from './filter.js';
import { DEFAULT_BUCKETS } from '../metrics/catalogue.js';
import type { AlertRules, ResolvedAlerts } from '../metrics/alerts.js';
import { deadLetterKeepMs, parseJobKeep, resolveRetention, type JobKeep, type Keep, type ResolvedRetention, type RetentionOptions } from '../retention/policy.js';
import { MAX_TIMER_MS, platform } from '../platform/index.js';

export const QUEUE_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
export const NAMESPACE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const NAME_RULE = 'expected 1-100 characters from A-Z a-z 0-9 _ . -';
const NAMESPACE_RULE = 'expected 1-64 characters from A-Z a-z 0-9 _ . -';

/**
 * What `add` does when the id is already held: return the holder (`'ignore'`, default), overwrite a waiting
 * or delayed holder (`'replace'`), throw DuplicateJobError (`'reject'`), or merge with a pure function.
 */
export type DuplicateRule<D = unknown> = 'ignore' | 'replace' | 'reject' | ((existing: Readonly<Job<D>>, incoming: Readonly<D>) => D);
export const DUPLICATE_RULES = ['ignore', 'replace', 'reject'] as const;

/** Every queue option. */
export interface QueueOptions<D = unknown> extends TimeoutOptions, ShutdownOptions {
  /** Job id from the data, for every add without its own `id`; synchronous. Default: a UUIDv7. */
  id?: (data: D) => string;
  /** Default duplicate rule. Default `'ignore'`. */
  onDuplicate?: DuplicateRule<D>;
  /** Judges every add before it is stored: accept, or reject with a reason (JobRejectedError). A throw or a bad verdict is a FilterError. */
  filter?: FilterFn<D>;
  /** Longest the filter may take before the add fails with FilterError (`timedOut`). Integer ms. Default 5000. */
  filterTimeoutMs?: number;
  /** How long a job keeps its id: while `'pending'` (default) or until removed (`'retained'`). */
  uniqueWhile?: 'pending' | 'retained';
  /** Any object implementing the store contract, shareable between queues. Default: a private MemoryStore owned by this queue. */
  store?: Store;
  /** Isolates apps or environments sharing one store. Default `'default'`. */
  namespace?: string;
  /** Defaults applied to every `add`. */
  defaultJobOptions?: JobDefaults;
  /** Claim order among equal priorities. Default `'fifo'`. */
  order?: 'fifo' | 'lifo';
  /** Largest serialized job data, in UTF-8 bytes. Default 1 MiB. */
  maxPayloadBytes?: number;
  /** Largest serialized handler result, in UTF-8 bytes. Default 1 MiB. */
  maxResultBytes?: number;
  /** Most inputs in one `addBulk` call. Default 1000. */
  maxBulkSize?: number;
  /** Cap on a stored serialized error, in bytes. Default 16 384, minimum 512. */
  maxErrorBytes?: number;
  /** Keep stack traces in stored errors. Default true. */
  storeStacks?: boolean;
  /** Default: console at `warn`; `false` disables logging. */
  logger?: Logger | false;
  /** Default polling for this queue's workers; each worker may override. */
  pollMin?: Duration;
  /** Longest wait between claims while idle. Default 5 s. */
  pollMax?: Duration;
  /** Growth of the wait per empty claim; above 1. Default 2. */
  pollFactor?: number;
  /** Random spread of each wait, 0 to 1. Default 0.2. */
  pollJitter?: number;
  /** Wake on the store's change notifications when it has them. Default true. */
  notify?: boolean;
  /** Default lease length for this queue's workers. Default 30 s; 1 s to 1 d. */
  leaseDuration?: Duration;
  /** Lease length per job name; same range. */
  leaseDurationByName?: Record<string, Duration>;
  /** Lease expiries (crashed or stalled workers) after which a job is failed with PoisonPillError. Default 3. */
  maxCrashes?: number;
  /**
   * How the store is probed while it is unreachable: `min(maxDelay, initialDelay * factor^n)` ± `jitter`.
   * One schedule per store object; the first queue on it sets it. Default `{ initialDelay: 100, maxDelay: 30_000, factor: 2, jitter: 0.2 }`.
   */
  reconnect?: ReconnectOptions;
  /** `add` while the store is unreachable: `'reject'` at once (default) or `'wait'` in a bounded buffer. */
  onDisconnected?: 'reject' | 'wait';
  /** Longest an add waits for the store to come back. Default 10 s. */
  maxWait?: Duration;
  /**
   * Longest one store call may take before it fails with a retryable StoreUnavailableError (outcome unknown for a write)
   * and the store counts as unreachable; a late answer is ignored. At least 1 ms; to effectively disable it, give a large value.
   * One deadline per store object: the first queue or producer on it sets it, until the last one closes. Default 30 s.
   */
  storeCallTimeout?: Duration;
  /** Most adds (an `addBulk` counts as one) waiting for the store in `'wait'` mode. Default 1000. */
  maxBufferedAdds?: number;
  /**
   * Process signals that close this queue: the first calls `close()`, a second exits the process with
   * code 1 without releasing. Installed at the first `process()`, removed on close. Default none.
   */
  signals?: readonly ProcessSignal[];
  /**
   * Attempt history: one record per attempt, read with `job.getAttempts()` and `queue.getAttempts(id)`. Default on,
   * keeping the last 50 records per job (`maxRecordsPerJob`, at least 1); `false` writes none.
   */
  history?: boolean | { maxRecordsPerJob?: number };
  /**
   * Dead letters: a job that fails for good is kept as a dead letter with a reason, listed by `getDeadLetters` and
   * moved back by `redrive`. Default on; `false` leaves plain failed jobs. `warnAbove` (default 10 000, `false` for
   * never) is the dead-letter count above which `health()` warns. `keep` (an age) bounds how long dead letters are kept.
   */
  deadLetter?: boolean | { warnAbove?: number | false; keep?: Keep };
  /**
   * How long finished jobs are kept, per outcome, per job name (`byName`) and per job (`add`'s `keep`). Default: the newest
   * 1000 completed jobs, failed and cancelled jobs for 14 days; dead letters until redriven or removed (`deadLetter.keep`).
   * A cleanup pass runs every `interval` on pods that run workers.
   */
  retention?: RetentionOptions;
  /** The schedule loop this queue runs on a pod with a worker (or after `startScheduler()`). */
  scheduler?: SchedulerOptions;
  /**
   * `queue.metrics()`: `window` (default `'5m'`, 1 minute to 1 day) for the success ratio, throughput and peak;
   * histogram `buckets` in seconds; at most `maxNameLabels` (default 100) distinct `name` labels, the rest `__other__`.
   */
  metrics?: MetricsOptions;
  /** Threshold alerts this pod evaluates every `interval` (default `'15s'`, 1 s to 1 day), emitted as `alert` events. */
  alerts?: AlertRules & { interval?: Duration };
  /** @internal Test seam for reconnect and scheduler jitter; default Math.random. */
  random?: (() => number) | undefined;
}

/** Options for `queue.metrics()`. */
export interface MetricsOptions {
  /** Window of the peak, success ratio and throughput, in 1-minute buckets; 1 minute to 1 day. Default `'5m'`. */
  window?: Duration | undefined;
  /** Histogram bucket bounds in seconds: non-empty, above 0, strictly ascending. */
  buckets?: number[] | undefined;
  /** Most distinct `name` label values; more are reported as `__other__`. Default 100. */
  maxNameLabels?: number | undefined;
}
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const metricsSchema: Schema<{ window: number; buckets: unknown; maxNameLabels: number }> = {
  fields: {
    window: { kind: 'duration', default: 300_000 },
    buckets: { kind: 'unknown', default: DEFAULT_BUCKETS },
    maxNameLabels: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 100 },
  },
  check: (v, add) => {
    if (v.window < MINUTE_MS || v.window > DAY_MS) add({ path: 'metrics.window', code: 'out_of_range', message: 'expected a duration from 1 minute to 1 day' });
    const b = v.buckets;
    const ok = Array.isArray(b) && b.length > 0 &&
      b.every((x: unknown, i) => typeof x === 'number' && Number.isFinite(x) && x > 0 && (i === 0 || x > (b[i - 1] as number)));
    if (!ok) add({ path: 'metrics.buckets', code: 'invalid_value', message: 'expected a non-empty array of finite numbers > 0, strictly ascending' });
  },
};

const ALERT_RULES = ['depth', 'age', 'failureRate'] as const;
const alertsSchema: Schema<Record<string, unknown>> = {
  fields: {
    interval: { kind: 'duration', default: 15_000 },
    depth: {
      kind: 'object',
      schema: {
        fields: { above: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER }, resolveBelow: { kind: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER } },
        check: (v, add) => {
          if ((v['resolveBelow'] as number) > (v['above'] as number)) add({ path: 'alerts.depth.resolveBelow', code: 'out_of_range', message: 'expected at most alerts.depth.above' });
        },
      },
    },
    age: {
      kind: 'object',
      schema: {
        fields: { aboveMs: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER }, resolveBelowMs: { kind: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER } },
        check: (v, add) => {
          if ((v['resolveBelowMs'] as number) > (v['aboveMs'] as number)) add({ path: 'alerts.age.resolveBelowMs', code: 'out_of_range', message: 'expected at most alerts.age.aboveMs' });
        },
      },
    },
    failureRate: {
      kind: 'object',
      schema: {
        fields: {
          above: { kind: 'number', min: 0, max: 1 },
          resolveBelow: { kind: 'number', min: 0, max: 1 },
          minJobs: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 10 },
        },
        check: (v, add) => {
          if (v['above'] === 0) add({ path: 'alerts.failureRate.above', code: 'out_of_range', message: 'expected a ratio above 0, at most 1' });
          if ((v['resolveBelow'] as number) > (v['above'] as number)) {
            add({ path: 'alerts.failureRate.resolveBelow', code: 'out_of_range', message: 'expected at most alerts.failureRate.above' });
          }
        },
      },
    },
  },
  check: (v, add) => {
    const ms = v['interval'] as number;
    if (ms < 1000 || ms > DAY_MS) add({ path: 'alerts.interval', code: 'out_of_range', message: 'expected a duration from 1 s to 1 day' });
  },
};

/** `alerts` absent is no alerts; a rule given without its fire level is missing it. Issues carry the `alerts.` path. */
function resolveAlerts(v: unknown, add?: (issue: ConfigIssue) => void): ResolvedAlerts | undefined {
  if (v === undefined) return undefined;
  const issues: ConfigIssue[] = [];
  let out: Record<string, Record<string, number> | number> = {};
  try {
    out = validate('alerts', { alerts: v }, { fields: { alerts: { kind: 'object', schema: alertsSchema } } }).alerts as typeof out;
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    issues.push(...e.issues);
  }
  const raw = (typeof v === 'object' && v !== null ? v : {}) as Record<string, Record<string, unknown> | undefined>;
  const level = { depth: 'above', age: 'aboveMs', failureRate: 'above' } as const;
  for (const rule of ALERT_RULES) {
    const given = raw[rule];
    if (typeof given === 'object' && given !== null && given[level[rule]] === undefined) {
      issues.push({ path: `alerts.${rule}.${level[rule]}`, code: 'missing_option', message: 'required option is missing' });
    }
  }
  if (issues.length > 0) {
    if (!add) throw new InvalidOptionError('alerts', issues);
    for (const issue of issues) add(issue);
    return undefined;
  }
  const resolved: ResolvedAlerts = { intervalMs: out['interval'] as number };
  const pick = (rule: (typeof ALERT_RULES)[number]) => (raw[rule] === undefined ? undefined : (out[rule] as Record<string, number>));
  const depth = pick('depth');
  if (depth) resolved.depth = { above: depth['above']!, resolveBelow: depth['resolveBelow'] ?? depth['above']! };
  const age = pick('age');
  if (age) resolved.age = { aboveMs: age['aboveMs']!, resolveBelowMs: age['resolveBelowMs'] ?? age['aboveMs']! };
  const rate = pick('failureRate');
  if (rate) resolved.failureRate = { above: rate['above']!, resolveBelow: rate['resolveBelow'] ?? rate['above']!, minJobs: rate['minJobs']! };
  return Object.freeze(resolved);
}

/** Options for the schedule loop a queue runs on a pod with a worker. */
export interface SchedulerOptions {
  /** Start with the first worker of this queue object. Default true; `startScheduler()` starts it either way. */
  enabled?: boolean | undefined;
  /** Longest sleep between loop turns, ±10 %; 100 ms to 2^31 - 1 ms. Default 1000. */
  tickMs?: number | undefined;
  /** Due schedules read per loop turn, 1-1000. Default 50. */
  batchSize?: number | undefined;
}
type ResolvedScheduler = { enabled: boolean; tickMs: number; batchSize: number };
const schedulerSchema: Schema<ResolvedScheduler> = {
  fields: {
    enabled: { kind: 'boolean', default: true },
    tickMs: { kind: 'integer', min: 100, max: 2_147_483_647, default: 1000 },
    batchSize: { kind: 'integer', min: 1, max: 1000, default: 50 },
  },
};

/** A process signal name such as `'SIGTERM'`; checked against the signals Node knows. */
export type ProcessSignal = `SIG${string}`;

/** How the store is probed while it is unreachable. */
export interface ReconnectOptions {
  /** First probe delay; at least 1 ms. Default 100 ms. */
  initialDelay?: Duration | undefined;
  /** Longest probe delay; at least `initialDelay`, at most 2^31 - 1 ms (about 24.8 days). Default 30 s. */
  maxDelay?: Duration | undefined;
  /** Growth per failed probe; at least 1. Default 2. */
  factor?: number | undefined;
  /** Random spread of each delay, 0 to 1. Default 0.2. */
  jitter?: number | undefined;
}
type ResolvedReconnect = { initialDelay: number; maxDelay: number; factor: number; jitter: number };
const reconnectSchema: Schema<ResolvedReconnect> = {
  fields: {
    initialDelay: { kind: 'duration', default: 100 },
    maxDelay: { kind: 'duration', default: 30_000 },
    factor: { kind: 'number', min: 1, default: 2 },
    jitter: { kind: 'number', min: 0, max: 1, default: 0.2 },
  },
  check: (v, add) => {
    if (v.initialDelay < 1) add({ path: 'reconnect.initialDelay', code: 'out_of_range', message: 'expected at least 1 ms' });
    if (v.maxDelay < v.initialDelay) add({ path: 'reconnect.maxDelay', code: 'out_of_range', message: 'expected at least reconnect.initialDelay' });
    if (v.maxDelay > MAX_TIMER_MS) add({ path: 'reconnect.maxDelay', code: 'out_of_range', message: `expected at most ${MAX_TIMER_MS} ms` });
  },
};

/** How long a claim holds a job before another worker may take it; renewed by the heartbeat. */
export interface LeaseOptions {
  /** Lease length. Default 30 s, from 1 s to 1 d; the heartbeat renews it every third of it. */
  leaseDuration?: Duration | undefined;
  /** Lease length per job name, over `leaseDuration`. */
  leaseDurationByName?: Record<string, Duration> | undefined;
}
type ResolvedLeaseInput = { leaseDuration?: number; leaseDurationByName?: Readonly<Record<string, Duration>> };
export const DEFAULT_LEASE_MS = 30_000;
const MIN_LEASE_MS = 1000;
const MAX_LEASE_MS = 86_400_000;
const LEASE_RULE = `expected a duration from ${MIN_LEASE_MS} ms to ${MAX_LEASE_MS} ms (1 d)`;
const leaseFields = { leaseDuration: { kind: 'duration' }, leaseDurationByName: { kind: 'unknown' } } as const;

/** The lease range and the byName shape: valid job names, each a duration in range. */
function leaseIssues(v: ResolvedLeaseInput, add: (issue: ConfigIssue) => void): void {
  const range = (ms: number, path: string) => {
    if (ms < MIN_LEASE_MS || ms > MAX_LEASE_MS) add({ path, code: 'out_of_range', message: LEASE_RULE, expected: LEASE_RULE });
  };
  if (v.leaseDuration !== undefined) range(v.leaseDuration, 'leaseDuration');
  const byName: unknown = v.leaseDurationByName;
  if (byName === undefined) return;
  if (typeof byName !== 'object' || byName === null || Array.isArray(byName)) {
    add({ path: 'leaseDurationByName', code: 'invalid_type', message: 'expected an object of { jobName: duration }' });
    return;
  }
  for (const [name, d] of Object.entries(byName)) {
    const path = `leaseDurationByName.${name}`;
    const nameIssue = jobNameIssue(name, path);
    if (nameIssue) add(nameIssue);
    const r = tryParseDuration(d);
    if (r.ok) range(r.ms, path);
    else add({ path, code: r.code, message: LEASE_RULE, expected: LEASE_RULE });
  }
}

/** A worker's lease lengths: for one job name, and what its claims send. */
export interface Leases {
  leaseMsFor(name: string | null): number;
  /** The byName entries for the names this worker handles; undefined when none. */
  leaseMsByName: Record<string, number> | undefined;
  /** The shortest lease a claim of this worker can take. */
  minLeaseMs: number;
}

/** Precedence for a job name: worker byName, queue byName, worker leaseDuration, queue leaseDuration, 30 s. */
export function resolveLeases(queue: ResolvedLeaseInput, worker: ResolvedLeaseInput, names: Iterable<string | null>): Leases {
  const base = worker.leaseDuration ?? queue.leaseDuration ?? DEFAULT_LEASE_MS;
  // Validated already; converted once so later changes to the caller's object have no effect.
  const toMs = (m: Readonly<Record<string, Duration>> = {}) =>
    new Map(Object.entries(m).map(([k, d]) => [k, (tryParseDuration(d) as { ms: number }).ms]));
  const own = toMs(worker.leaseDurationByName);
  const shared = toMs(queue.leaseDurationByName);
  const leaseMsFor = (name: string | null): number => (name === null ? base : (own.get(name) ?? shared.get(name) ?? base));
  const byName: Record<string, number> = {};
  for (const name of names) if (name !== null && (own.has(name) || shared.has(name))) byName[name] = leaseMsFor(name);
  const values = Object.values(byName);
  return { leaseMsFor, leaseMsByName: values.length > 0 ? byName : undefined, minLeaseMs: Math.min(base, ...values) };
}

/** How a worker waits between claims. Durations are read as ms once validated. */
export interface PollingOptions {
  /** Shortest wait between claims, and the wait right after a wake-up. Default 100 ms. */
  pollMin?: Duration | undefined;
  /** Longest wait between claims while idle. Default 5 s. */
  pollMax?: Duration | undefined;
  /** Growth of the wait per empty claim; above 1. Default 2. */
  pollFactor?: number | undefined;
  /** Random spread of each wait, 0 to 1. Default 0.2. */
  pollJitter?: number | undefined;
  /** Wake on the store's change notifications when it has them. Default true. */
  notify?: boolean | undefined;
}
type ResolvedPollingInput = { pollMin?: number; pollMax?: number; pollFactor?: number; pollJitter?: number; notify?: boolean };
export type Polling = { pollMin: number; pollMax: number; pollFactor: number; pollJitter: number; notify: boolean };
export const POLL_DEFAULTS: Polling = Object.freeze({ pollMin: 100, pollMax: 5000, pollFactor: 2, pollJitter: 0.2, notify: true });

const pollingFields = {
  pollMin: { kind: 'duration' },
  pollMax: { kind: 'duration' },
  pollFactor: { kind: 'number' },
  pollJitter: { kind: 'number', min: 0, max: 1 },
  notify: { kind: 'boolean' },
} as const;

/** The single-field polling rules (the min/max pair is checked once merged). */
function pollingIssues(v: ResolvedPollingInput, add: (issue: ConfigIssue) => void): void {
  if (v.pollMin !== undefined && v.pollMin < 1) add({ path: 'pollMin', code: 'out_of_range', message: 'expected at least 1 ms' });
  if (v.pollMax !== undefined && v.pollMax < 1) add({ path: 'pollMax', code: 'out_of_range', message: 'expected at least 1 ms' });
  if (v.pollFactor !== undefined && !(v.pollFactor > 1)) add({ path: 'pollFactor', code: 'out_of_range', message: 'expected a number above 1' });
}

/** A worker's polling: its own values, else its queue's, else the defaults. Throws when pollMin exceeds pollMax. */
export function resolvePolling(queue: ResolvedPollingInput, worker: ResolvedPollingInput, scope: string): Polling {
  const pick = <K extends keyof Polling>(k: K): Polling[K] => (worker[k] ?? queue[k] ?? POLL_DEFAULTS[k]) as Polling[K];
  const p: Polling = { pollMin: pick('pollMin'), pollMax: pick('pollMax'), pollFactor: pick('pollFactor'), pollJitter: pick('pollJitter'), notify: pick('notify') };
  if (p.pollMin > p.pollMax) {
    const message = `pollMin (${p.pollMin} ms) must not exceed pollMax (${p.pollMax} ms)`;
    throw new InvalidOptionError(scope, [{ path: 'pollMin', code: 'conflict', message }, { path: 'pollMax', code: 'conflict', message }]);
  }
  return p;
}

export interface ResolvedQueueOptions {
  store: Store | undefined;
  id: ((data: unknown) => string) | undefined;
  onDuplicate: DuplicateRule;
  filter: FilterFn | undefined;
  filterTimeoutMs: number;
  uniqueWhile: 'pending' | 'retained';
  namespace: string;
  defaultJobOptions: Readonly<JobDefaults>;
  order: 'fifo' | 'lifo';
  maxPayloadBytes: number;
  maxResultBytes: number;
  maxBulkSize: number;
  maxErrorBytes: number;
  storeStacks: boolean;
  logger: Logger | false | undefined;
  pollMin?: number;
  pollMax?: number;
  pollFactor?: number;
  pollJitter?: number;
  notify?: boolean;
  leaseDuration?: number;
  leaseDurationByName?: Readonly<Record<string, Duration>>;
  maxCrashes: number;
  timeout?: number;
  timeoutGrace?: number;
  reconnect: Readonly<ResolvedReconnect>;
  scheduler: Readonly<ResolvedScheduler>;
  onDisconnected: 'reject' | 'wait';
  maxWait: number;
  storeCallTimeout: number;
  maxBufferedAdds: number;
  shutdownTimeout: number;
  shutdownAbortGrace: number;
  signals: readonly ProcessSignal[];
  /** What every claim and closer sends as `history`. */
  history: false | { max: number };
  /** Whether a final failure is kept as a dead letter, the count `health()` warns above, and how long one is kept. */
  deadLetter: { enabled: boolean; warnAbove: number | false; keepMs?: number };
  retention: ResolvedRetention;
  metrics: { windowMs: number; buckets: readonly number[]; maxNameLabels: number };
  alerts: ResolvedAlerts | undefined;
  random?: () => number;
}

const historySchema: Schema<{ history: Record<string, unknown> }> = {
  fields: {
    history: { kind: 'object', schema: { fields: { maxRecordsPerJob: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 50 } } } },
  },
};

/** `history: true` (or absent) is on with the default cap; an object's issues carry the `history.` path. */
function resolveHistory(v: unknown, add?: (issue: ConfigIssue) => void): false | { max: number } {
  if (v === false) return false;
  if (v === true) return { max: 50 };
  try {
    return { max: validate('history', { history: v }, historySchema).history['maxRecordsPerJob'] as number };
  } catch (e) {
    if (!(e instanceof InvalidOptionError) || !add) throw e;
    for (const issue of e.issues) add(issue);
    return false;
  }
}

const DEAD_LETTER_WARN_ABOVE = 10_000;
const deadLetterSchema: Schema<{ deadLetter: Record<string, unknown> }> = {
  fields: { deadLetter: { kind: 'object', schema: { fields: { warnAbove: { kind: 'unknown', default: DEAD_LETTER_WARN_ABOVE }, keep: { kind: 'unknown' } } } } },
};

/** `deadLetter: true` (or absent) is on with the default warning; an object's issues carry the `deadLetter.` path. */
function resolveDeadLetter(v: unknown, add?: (issue: ConfigIssue) => void): ResolvedQueueOptions['deadLetter'] {
  if (v === false || v === true) return { enabled: v, warnAbove: v && DEAD_LETTER_WARN_ABOVE };
  const issues: ConfigIssue[] = [];
  let warnAbove: unknown = DEAD_LETTER_WARN_ABOVE;
  let keepMs: number | undefined;
  try {
    const o = validate('deadLetter', { deadLetter: v }, deadLetterSchema).deadLetter;
    warnAbove = o['warnAbove'];
    keepMs = deadLetterKeepMs(o['keep'], (i) => issues.push(i));
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    issues.push(...e.issues);
  }
  if (warnAbove !== false && !(Number.isSafeInteger(warnAbove) && (warnAbove as number) >= 0)) {
    issues.push({ path: 'deadLetter.warnAbove', code: 'invalid_value', message: 'expected an integer >= 0 or false', expected: 'integer >= 0 | false' });
  }
  if (issues.length > 0) {
    if (!add) throw new InvalidOptionError('deadLetter', issues);
    for (const issue of issues) add(issue);
  }
  return { enabled: true, warnAbove: warnAbove as number | false, ...(keepMs !== undefined && { keepMs }) };
}

const MiB = 1_048_576;

/** Priority range: a signed 32-bit integer. Higher runs first. */
export const MIN_PRIORITY = -2_147_483_648;
export const MAX_PRIORITY = 2_147_483_647;

/** Options that may be set once per queue as `defaultJobOptions`. */
export interface JobDefaults {
  /** Attempts allowed per job, the first included. Default 3. */
  maxAttempts?: number;
  /** The wait before each retry. Default: exponential from 1 s, factor 2, full jitter, capped at 1 hour. */
  backoff?: BackoffSpec;
  /** Priority of each job; higher runs first. Default 0. */
  priority?: number;
}
export const DEFAULTABLE_JOB_OPTIONS = ['maxAttempts', 'backoff', 'priority'] as const;
/** Valid on one `add` only; rejected as queue defaults. */
const PER_ADD_ONLY = ['id', 'name', 'delay', 'runAt', 'first', 'singletonKey', 'idempotencyKey', 'onDuplicate', 'uniqueWhile'] as const;
/** Rejected as defaults, but valid as queue options. */
const QUEUE_LEVEL = ['onDuplicate', 'uniqueWhile'];

/** The per-job policy options, shared by `defaultJobOptions` and `add`. */
export const jobPolicySchema: Schema<JobDefaults> = {
  fields: {
    maxAttempts: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    backoff: { kind: 'unknown' },
    priority: { kind: 'integer', min: MIN_PRIORITY, max: MAX_PRIORITY },
  },
  check: (v, add) => {
    if (v.backoff === undefined) return;
    try {
      normalizeBackoff(v.backoff, 'backoff');
    } catch (e) {
      if (!(e instanceof InvalidOptionError)) throw e;
      for (const issue of e.issues) add(issue);
    }
  },
};

const jobDefaultsSchema: Schema<JobDefaults & Record<(typeof PER_ADD_ONLY)[number], unknown>> = {
  fields: {
    ...jobPolicySchema.fields,
    ...(Object.fromEntries(PER_ADD_ONLY.map((k) => [k, { kind: 'unknown' }])) as Record<(typeof PER_ADD_ONLY)[number], { kind: 'unknown' }>),
  },
  renamed: { attempts: 'maxAttempts' },
  check: (v, add) => {
    jobPolicySchema.check!(v, (issue) => add({ ...issue, path: `defaultJobOptions.${issue.path}` }));
    for (const k of PER_ADD_ONLY) {
      if (v[k] === undefined) continue;
      const message = QUEUE_LEVEL.includes(k) ? 'not a job default: set it as a queue option' : 'per-add only, not a queue default';
      add({ path: `defaultJobOptions.${k}`, code: 'conflict', message });
    }
  },
};

/** Job names: 1-128 ASCII characters (so 1-128 bytes); `'*'` is reserved. */
export const JOB_NAME_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const JOB_NAME_RULE = 'expected 1-128 characters from A-Z a-z 0-9 . _ : / - (not "*")';

/** The one job-name check, as an issue at `path`, or undefined when `name` is valid. */
export function jobNameIssue(name: unknown, path: string): ConfigIssue | undefined {
  if (typeof name === 'string' && JOB_NAME_RE.test(name)) return undefined;
  return { path, code: typeof name === 'string' ? 'invalid_value' : 'invalid_type', message: JOB_NAME_RULE, expected: JOB_NAME_RULE };
}

/** Return `name` when it is a valid job name, else throw InvalidOptionError at `path`. */
export function validateJobName(name: unknown, path: string): string {
  const issue = jobNameIssue(name, path);
  if (issue) throw new InvalidOptionError('job name', [issue]);
  return name as string;
}

/** Per-attempt time limits; accepted on the queue, the worker and `add`, the most specific winning per field. */
export interface TimeoutOptions {
  /**
   * Abort `ctx.signal` with JobTimeoutError this long after the handler starts. Default none.
   * A handler that ignores `ctx.signal` cannot be killed: it is abandoned and its result ignored.
   */
  timeout?: Duration | undefined;
  /**
   * How long after the abort to wait for the handler before failing the attempt anyway. Default 5 s.
   * 0 fails at once: the attempt is always recorded `abandoned: true`, with the abandon warning, even when the handler would have stopped.
   */
  timeoutGrace?: Duration | undefined;
}
type ResolvedTimeoutInput = { timeout?: number; timeoutGrace?: number };
export { MAX_TIMER_MS };
/** The least time close leaves the last releases to answer, after the abort grace. */
export const RELEASE_MIN_MS = 1000;
const timeoutFields = { timeout: { kind: 'duration' }, timeoutGrace: { kind: 'duration' } } as const;

/** `timeout` at least 1 ms, both within one timer's range. */
function timeoutIssues(v: ResolvedTimeoutInput, add: (issue: ConfigIssue) => void): void {
  if (v.timeout !== undefined && (v.timeout < 1 || v.timeout > MAX_TIMER_MS)) {
    add({ path: 'timeout', code: 'out_of_range', message: `expected 1 to ${MAX_TIMER_MS} ms` });
  }
  if (v.timeoutGrace !== undefined && v.timeoutGrace > MAX_TIMER_MS) {
    add({ path: 'timeoutGrace', code: 'out_of_range', message: `expected 0 to ${MAX_TIMER_MS} ms` });
  }
}

/** How `close()` stops a worker; accepted on the queue (the default) and on a worker. */
export interface ShutdownOptions {
  /** How long `close()` lets running handlers finish before aborting them with ShutdownError. Default 25 s, so a default close fits Kubernetes' 30 s grace period. */
  shutdownTimeout?: Duration | undefined;
  /** How long after that abort to wait before releasing the jobs anyway. Default 2 s. */
  shutdownAbortGrace?: Duration | undefined;
}
type ResolvedShutdownInput = { shutdownTimeout?: number; shutdownAbortGrace?: number };
const shutdownFields = { shutdownTimeout: { kind: 'duration' }, shutdownAbortGrace: { kind: 'duration' } } as const;

function shutdownIssues(v: ResolvedShutdownInput, add: (issue: ConfigIssue) => void): void {
  for (const path of ['shutdownTimeout', 'shutdownAbortGrace'] as const) {
    const ms = v[path];
    if (ms !== undefined && ms > MAX_TIMER_MS) add({ path, code: 'out_of_range', message: `expected 0 to ${MAX_TIMER_MS} ms` });
  }
}

/** Options one `add` (or one `addBulk` item) accepts. An explicit `undefined` means "not given" and falls back to the queue default. */
export interface AddOptions<D = unknown> extends TimeoutOptions {
  /** The job id, or a synchronous function of the data returning it. Default: the queue's `id` function, else a UUIDv7. */
  id?: string | ((data: D) => string) | undefined;
  /** What to do when the id is already held. Default: the queue's `onDuplicate`. */
  onDuplicate?: DuplicateRule<D> | undefined;
  /** How long this job keeps its id. Default: the queue's `uniqueWhile`. */
  uniqueWhile?: 'pending' | 'retained' | undefined;
  /** At most one waiting or delayed job per key; `null` holds nothing. */
  singletonKey?: string | null | undefined;
  /** Stored and returned as `job.idempotencyKey`. Default: derived from namespace, queue, id and seq. */
  idempotencyKey?: string | undefined;
  /** The job name, which picks the handler in `process({ name: handler })`. */
  name?: string | undefined;
  /** Attempts allowed, the first included. Default: the queue's `defaultJobOptions`, else 3. */
  maxAttempts?: number | undefined;
  /** The wait before each retry. Default: the queue's `defaultJobOptions`, else exponential from 1 s. */
  backoff?: BackoffSpec | undefined;
  /** Higher runs first. Default 0. */
  priority?: number | undefined;
  /** Put the job at the front of its priority level. */
  first?: boolean | undefined;
  /** Wait this long before the job can run. */
  delay?: Duration | undefined;
  /** Run at this time, a `Date` or epoch ms; a past time runs now. */
  runAt?: Date | number | undefined;
  /** How long this job is kept once finished, per outcome; overrides the queue's `retention`. A job with its own `failed` is never dead-lettered. */
  keep?: { completed?: JobKeep; failed?: JobKeep; cancelled?: JobKeep } | undefined;
}

const DUPLICATE_RULE_TEXT = `one of ${DUPLICATE_RULES.map((r) => `"${r}"`).join(' | ')} or a merge function`;

/** `onDuplicate`: a known rule name or a function. */
function duplicateRuleIssue(v: unknown): ConfigIssue | undefined {
  if (typeof v === 'function' || (DUPLICATE_RULES as readonly unknown[]).includes(v)) return undefined;
  const suggestion = typeof v === 'string' ? closest(v, DUPLICATE_RULES) : undefined;
  return {
    path: 'onDuplicate', code: typeof v === 'string' ? 'invalid_value' : 'invalid_type',
    message: `expected ${DUPLICATE_RULE_TEXT}${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`, expected: DUPLICATE_RULE_TEXT,
    ...(suggestion && { suggestion }),
  };
}

/** The single schema for `add` and `addBulk` items; `delay`/`runAt` ranges are checked by resolveDelay, id and key sizes in the queue. */
export const addOptionsSchema: Schema<AddOptions> = {
  fields: {
    ...jobPolicySchema.fields,
    name: { kind: 'unknown' },
    first: { kind: 'boolean' },
    delay: { kind: 'unknown' },
    runAt: { kind: 'unknown' },
    ...timeoutFields,
    id: { kind: 'unknown' },
    onDuplicate: { kind: 'unknown' },
    uniqueWhile: { kind: 'enum', values: ['pending', 'retained'] },
    singletonKey: { kind: 'unknown' },
    idempotencyKey: { kind: 'unknown' },
    keep: { kind: 'unknown' },
  },
  renamed: { attempts: 'maxAttempts' },
  check: (v, add) => {
    jobPolicySchema.check!(v as JobDefaults, add);
    timeoutIssues(v as ResolvedTimeoutInput, add);
    const issue = v.name === undefined ? undefined : jobNameIssue(v.name, 'name');
    if (issue) add(issue);
    if (v.id !== undefined && typeof v.id !== 'string' && typeof v.id !== 'function') {
      add({ path: 'id', code: 'invalid_type', message: 'expected a string or a function returning one' });
    }
    const rule = v.onDuplicate === undefined ? undefined : duplicateRuleIssue(v.onDuplicate);
    if (rule) add(rule);
  },
};

/** Call-level `addBulk` options. `atomic` is not a per-input or queue-default option. */
export interface BulkOptions {
  /** All or nothing: one refused input refuses the whole call with `BulkAddError`. Needs the store's `transactions`. Default false. */
  atomic?: boolean | undefined;
}
export const bulkOptionsSchema: Schema<{ atomic: boolean }> = { fields: { atomic: { kind: 'boolean', default: false } } };

/** Options for `queue.process`. `retryIf`, `backoffStrategies` and `unwrapCause` shape retries. */
export interface WorkerOptions extends PollingOptions, LeaseOptions, TimeoutOptions, ShutdownOptions {
  /** Start claiming at once. With `false`, call `worker.run()`. Default true. */
  autorun?: boolean | undefined;
  /** Most jobs this worker runs at once; at least 1. Default 1. */
  concurrency?: number | undefined;
  /** This worker's id, shown in events, attempt records and the worker list. Default: a UUIDv7. */
  workerId?: string | undefined;
  /** Return `false` to fail the job for good with reason `'not-retryable'`. Default: retry every error. */
  retryIf?: ((err: Error, job: Job) => boolean | Promise<boolean>) | undefined;
  /** Custom backoff functions by name, for `backoff: { type: name }`. */
  backoffStrategies?: Record<string, BackoffFn> | undefined;
  /** Also look for an `UnrecoverableError` in the error's `cause` chain. Default true. */
  unwrapCause?: boolean | undefined;
  /**
   * How often this pod looks for jobs whose lease expired, ±20 % jitter. Default 5 s, from 500 ms to 1 d.
   * One sweeper runs per queue object; the first worker to run sets its interval and batch.
   */
  sweepInterval?: Duration | undefined;
  /** Most expired jobs one sweep call recovers. Default 100, from 1 to 1000; capped to the store's `maxClaimLimit`, with one warning. */
  sweepBatch?: number | undefined;
  /** @internal Test seam for backoff jitter; default Math.random. */
  random?: (() => number) | undefined;
  /** Silence the one startup warning for a store that is not durable. Default false. */
  acknowledgeVolatileStore?: boolean | undefined;
  /** Least time between two progress writes of one job; calls in between are merged, the latest wins. Default 250 ms. */
  progressInterval?: Duration | undefined;
  /** Most bytes of the serialized object form of `ctx.progress`. Default 4096. */
  maxProgressBytes?: number | undefined;
  /** The host name this worker's registry record shows. Default: the platform's host name. */
  host?: string | undefined;
  /** Free-form tags on this worker's registry record: at most 10, each key and value 1 to 64 characters. */
  labels?: Record<string, string> | undefined;
  /** How often this worker refreshes its registry record. Default 10 s, from 1 s to 1 d. */
  heartbeatInterval?: Duration | undefined;
}
export interface ResolvedWorkerOptions extends ResolvedPollingInput, ResolvedLeaseInput, ResolvedTimeoutInput, ResolvedShutdownInput {
  autorun: boolean;
  concurrency: number;
  unwrapCause: boolean;
  workerId?: string;
  retryIf?: NonNullable<WorkerOptions['retryIf']>;
  backoffStrategies?: NonNullable<WorkerOptions['backoffStrategies']>;
  sweepInterval: number;
  sweepBatch: number;
  random?: () => number;
  acknowledgeVolatileStore: boolean;
  progressInterval: number;
  maxProgressBytes: number;
  host: string;
  labels: Readonly<Record<string, string>>;
  heartbeatInterval: number;
}

const MAX_LABELS = 10;
const MAX_LABEL_CHARS = 64;

function labelIssues(labels: unknown, add: (issue: ConfigIssue) => void): void {
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    add({ path: 'labels', code: 'invalid_type', message: 'expected an object of strings' });
    return;
  }
  const entries = Object.entries(labels);
  if (entries.length > MAX_LABELS) add({ path: 'labels', code: 'out_of_range', message: `expected at most ${MAX_LABELS} labels, received ${entries.length}` });
  const fits = (v: unknown) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_LABEL_CHARS;
  for (const [key, value] of entries) {
    if (!fits(key) || !fits(value)) {
      add({ path: `labels.${key.slice(0, MAX_LABEL_CHARS)}`, code: 'invalid_value', message: `expected a key and a string value of 1 to ${MAX_LABEL_CHARS} characters` });
    }
  }
}

let hostDefault: string | undefined;
export const workerOptionsSchema: Schema<ResolvedWorkerOptions> = {
  fields: {
    autorun: { kind: 'boolean', default: true },
    concurrency: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 1 },
    workerId: { kind: 'string' },
    ...pollingFields,
    ...leaseFields,
    ...timeoutFields,
    ...shutdownFields,
    retryIf: { kind: 'function' },
    backoffStrategies: { kind: 'unknown' },
    unwrapCause: { kind: 'boolean', default: true },
    sweepInterval: { kind: 'duration', default: 5000 },
    sweepBatch: { kind: 'integer', min: 1, max: 1000, default: 100 },
    acknowledgeVolatileStore: { kind: 'boolean', default: false },
    random: { kind: 'function' },
    progressInterval: { kind: 'duration', default: 250 },
    maxProgressBytes: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 4096 },
    // read on first use, not at import, so importing on an unsupported runtime does not throw
    host: {
      kind: 'string',
      get default() {
        return (hostDefault ??= platform.hostname());
      },
    },
    labels: { kind: 'unknown', default: Object.freeze({}) },
    heartbeatInterval: { kind: 'duration', default: 10_000 },
  },
  renamed: { pollIntervalMs: 'pollMin' },
  check: (v, add) => {
    pollingIssues(v, add);
    leaseIssues(v, add);
    timeoutIssues(v, add);
    shutdownIssues(v, add);
    if (v.sweepInterval < 500 || v.sweepInterval > 86_400_000) add({ path: 'sweepInterval', code: 'out_of_range', message: 'expected 500 ms to 1 d' });
    if (v.progressInterval > MAX_TIMER_MS) add({ path: 'progressInterval', code: 'out_of_range', message: `expected 0 to ${MAX_TIMER_MS} ms` });
    if (v.workerId === '') add({ path: 'workerId', code: 'invalid_value', message: 'expected a non-empty string' });
    if (v.host === '') add({ path: 'host', code: 'invalid_value', message: 'expected a non-empty string' });
    labelIssues(v.labels, add);
    if (v.heartbeatInterval < 1000 || v.heartbeatInterval > 86_400_000) add({ path: 'heartbeatInterval', code: 'out_of_range', message: 'expected 1 s to 1 d' });
    for (const issue of backoffStrategyIssues(v.backoffStrategies)) add(issue);
  },
};

/** Options for `queue.processBatch`; `concurrency` counts batches. */
export interface BatchWorkerOptions extends WorkerOptions {
  /** Most jobs per handler call, 2 to 1000. Required. */
  batchSize: number;
  /** Close a partial batch after this long with no claim adding jobs. Default 0: close right after the claim. */
  batchDelay?: Duration | undefined;
  /** Close a batch this long after its first job was held. Default twenty times `batchDelay`; at least `batchDelay`. */
  batchMaxWait?: Duration | undefined;
  /** At shutdown, run the forming batch (`'flush'`, default) or give its jobs back unrun (`'release'`). */
  onShutdown?: 'flush' | 'release' | undefined;
}
export interface ResolvedBatchWorkerOptions extends ResolvedWorkerOptions {
  batchSize: number;
  batchDelay: number;
  batchMaxWait?: number;
  onShutdown: 'flush' | 'release';
}
export const batchWorkerOptionsSchema: Schema<ResolvedBatchWorkerOptions> = {
  fields: {
    ...workerOptionsSchema.fields,
    batchSize: { kind: 'integer', min: 2, max: 1000, required: true },
    batchDelay: { kind: 'duration', default: 0 },
    batchMaxWait: { kind: 'duration' },
    onShutdown: { kind: 'enum', values: ['flush', 'release'], default: 'flush' },
  },
  ...(workerOptionsSchema.renamed && { renamed: workerOptionsSchema.renamed }),
  check: (v, add) => {
    workerOptionsSchema.check!(v, add);
    for (const path of ['batchDelay', 'batchMaxWait'] as const) {
      const ms = v[path];
      if (ms !== undefined && ms > MAX_TIMER_MS) add({ path, code: 'out_of_range', message: `expected 0 to ${MAX_TIMER_MS} ms` });
    }
    if (v.batchMaxWait !== undefined && v.batchMaxWait < v.batchDelay) {
      add({ path: 'batchMaxWait', code: 'out_of_range', message: 'expected at least batchDelay' });
    }
  },
};

export const DEFAULT_MAX_ATTEMPTS = 3;

/** Options a caller may set on one add; the rest of the job comes from defaults. */
export type CallerSettable = 'priority' | 'maxAttempts' | 'backoff' | 'delay' | 'name' | 'singletonKey' | 'idempotencyKey';
const CALLER_SETTABLE: readonly CallerSettable[] = ['priority', 'maxAttempts', 'backoff', 'delay', 'name', 'singletonKey', 'idempotencyKey'];

/** The per-job options after merging queue defaults and library fallbacks; snapshotted on the job. */
export interface ResolvedJobOptions {
  /** The id or id function of this add, else the queue's id function. */
  idSpec: string | ((data: unknown) => string) | undefined;
  onDuplicate: DuplicateRule;
  uniqueWhile: 'pending' | 'retained';
  /** Type and size are checked by the queue (`validateKey`) against the store limit before the job is built. */
  singletonKey: string | null | undefined;
  idempotencyKey: string | undefined;
  /** Options this add set itself (`delay` also stands for `runAt`), before any default was applied. */
  callerSet: ReadonlySet<CallerSettable>;
  /** Job name, `null` when absent. */
  name: string | null;
  maxAttempts: number;
  /** The merged spec, validated and normalised; the built-in default when none was given. */
  backoff: StoredBackoff;
  priority: number;
  /** Relative wait before the job can run, from `delay` or `runAt`. The store adds its own clock. */
  delayMs: number;
  /** Front of its own priority level; per add only. */
  first: boolean;
  /** JSON `{ timeoutMs?, graceMs? }` of the values this add gave; null when it gave neither. */
  timeout: string | null;
  /** The add's `keep` as JSON; null when it gave none. */
  keep: string | null;
}

const MAX_EPOCH_MS = 8.64e15;
const DELAY_FORMS = `non-negative whole milliseconds or a string like "30s" (units ms, s, m, h, d), at most ${MAX_DELAY_MS} ms (100 years)`;

/** `delay` / `runAt` → one relative delay in ms, collecting issues instead of throwing. */
function resolveDelay(addOpts: Record<string, unknown>, now: number, issues: ConfigIssue[]): number {
  const { delay, runAt } = addOpts;
  if (delay !== undefined && runAt !== undefined) {
    for (const path of ['delay', 'runAt']) issues.push({ path, code: 'conflict', message: 'set delay or runAt, not both' });
    return 0;
  }
  if (delay !== undefined) {
    const r = tryParseDuration(delay);
    if (r.ok && r.ms <= MAX_DELAY_MS) return r.ms;
    const code = r.ok || (!r.ok && r.code === 'out_of_range') ? 'out_of_range' : r.code;
    issues.push({ path: 'delay', code, message: `expected ${DELAY_FORMS}`, expected: DELAY_FORMS });
    return 0;
  }
  if (runAt !== undefined) {
    const ms = runAt instanceof Date ? runAt.getTime() : runAt;
    if (typeof ms === 'number' && Number.isInteger(ms) && Math.abs(ms) <= MAX_EPOCH_MS) return Math.max(0, ms - now);
    issues.push({ path: 'runAt', code: runAt instanceof Date || typeof runAt === 'number' ? 'invalid_value' : 'invalid_type', message: 'expected a valid Date or integer epoch milliseconds' });
  }
  return 0;
}

/**
 * Merge one add's options over the queue defaults: shallow, `undefined` ignored, objects
 * replaced whole; then fill library fallbacks and validate the result. `now` is store time.
 */
export function resolveJobOptions(
  queueDefaults: Readonly<JobDefaults>,
  addOpts: Record<string, unknown>,
  now: number,
  queue: Partial<Pick<ResolvedQueueOptions, 'id' | 'onDuplicate' | 'uniqueWhile'>> = {},
): ResolvedJobOptions {
  const given = Object.fromEntries(Object.entries(addOpts).filter(([, v]) => v !== undefined));
  const callerSet = new Set(CALLER_SETTABLE.filter((k) => k in given || (k === 'delay' && 'runAt' in given)));
  const merged: AddOptions = { ...queueDefaults, ...given };
  const issues: ConfigIssue[] = [];
  let opts: AddOptions = {};
  try {
    opts = validate('add', merged, addOptionsSchema);
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    issues.push(...e.issues);
  }
  const delayMs = resolveDelay(given, now, issues);
  const uniqueWhile = opts.uniqueWhile ?? queue.uniqueWhile ?? 'pending';
  issues.push(...parseJobKeep(opts.keep, uniqueWhile).issues);
  if (issues.length > 0) throw new InvalidOptionError('add', issues);
  return {
    idSpec: (opts.id ?? queue.id) as ResolvedJobOptions['idSpec'],
    onDuplicate: (opts.onDuplicate ?? queue.onDuplicate ?? 'ignore') as DuplicateRule,
    uniqueWhile,
    singletonKey: opts.singletonKey,
    idempotencyKey: opts.idempotencyKey,
    callerSet,
    name: opts.name ?? null,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoff: normalizeBackoff(merged.backoff, 'backoff'),
    priority: opts.priority ?? 0,
    delayMs,
    first: opts.first === true,
    timeout: storedTimeout(opts as ResolvedTimeoutInput),
    keep: opts.keep === undefined ? null : JSON.stringify(opts.keep),
  };
}

function storedTimeout({ timeout, timeoutGrace }: ResolvedTimeoutInput): string | null {
  if (timeout === undefined && timeoutGrace === undefined) return null;
  return JSON.stringify({ ...(timeout !== undefined && { timeoutMs: timeout }), ...(timeoutGrace !== undefined && { graceMs: timeoutGrace }) });
}

const STORE_METHODS = [
  'open', 'close', 'now', 'add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'get', 'list',
  'counts', 'setPaused', 'isPaused',
] as const;
const STORE_RULE = 'expected a Store: contractVersion, capabilities and every store method';

/** A structural check: the object has the contract's members (the version is checked on open). */
function isStore(v: unknown): v is Store {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s['contractVersion'] === 'number' && typeof s['capabilities'] === 'object' && s['capabilities'] !== null &&
    STORE_METHODS.every((m) => typeof s[m] === 'function');
}

/** Signals a process can listen for: SIGKILL and SIGSTOP cannot be caught. Read on first use, not at import. */
let signalNames: readonly string[] | undefined;
const catchableSignals = (): readonly string[] => (signalNames ??= platform.signalNames().filter((s) => s !== 'SIGKILL' && s !== 'SIGSTOP'));

export const queueSchema: Schema<Omit<ResolvedQueueOptions, 'store' | 'logger'> & { store: unknown; logger: unknown }> = {
  fields: {
    store: { kind: 'unknown' },
    id: { kind: 'function' },
    onDuplicate: { kind: 'unknown', default: 'ignore' },
    filter: { kind: 'function' },
    filterTimeoutMs: { kind: 'integer', min: 1, max: 2_147_483_647, default: 5000 },
    uniqueWhile: { kind: 'enum', values: ['pending', 'retained'], default: 'pending' },
    namespace: { kind: 'string', default: 'default' },
    defaultJobOptions: { kind: 'object', schema: jobDefaultsSchema as unknown as Schema<Record<string, unknown>> },
    order: { kind: 'enum', values: ['fifo', 'lifo'], default: 'fifo' },
    maxPayloadBytes: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: MiB },
    maxResultBytes: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: MiB },
    maxBulkSize: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 1000 },
    maxErrorBytes: { kind: 'integer', min: 512, default: 16_384 },
    storeStacks: { kind: 'boolean', default: true },
    logger: { kind: 'unknown' },
    ...pollingFields,
    ...leaseFields,
    maxCrashes: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 3 },
    ...timeoutFields,
    reconnect: { kind: 'object', schema: reconnectSchema as unknown as Schema<Record<string, unknown>> },
    scheduler: { kind: 'object', schema: schedulerSchema as unknown as Schema<Record<string, unknown>> },
    onDisconnected: { kind: 'enum', values: ['reject', 'wait'], default: 'reject' },
    maxWait: { kind: 'duration', default: 10_000 },
    storeCallTimeout: { kind: 'duration', default: 30_000 },
    maxBufferedAdds: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 1000 },
    shutdownTimeout: { kind: 'duration', default: 25_000 },
    shutdownAbortGrace: { kind: 'duration', default: 2_000 },
    signals: {
      kind: 'array',
      item: {
        kind: 'enum',
        get values() {
          return catchableSignals();
        },
      },
      default: [],
    },
    history: { kind: 'unknown', default: true },
    deadLetter: { kind: 'unknown', default: true },
    retention: { kind: 'unknown' },
    metrics: { kind: 'object', schema: metricsSchema as unknown as Schema<Record<string, unknown>> },
    alerts: { kind: 'unknown' },
    random: { kind: 'function' },
  },
  check: (v, add) => {
    pollingIssues(v, add);
    leaseIssues(v, add);
    timeoutIssues(v, add);
    shutdownIssues(v, add);
    if (v.maxWait < 1) add({ path: 'maxWait', code: 'out_of_range', message: 'expected at least 1 ms' });
    if (v.storeCallTimeout < 1 || v.storeCallTimeout > MAX_TIMER_MS) {
      add({ path: 'storeCallTimeout', code: 'out_of_range', message: `expected 1 to ${MAX_TIMER_MS} ms` });
    }
    const rule = duplicateRuleIssue(v.onDuplicate);
    if (rule) add(rule);
    if (v.store !== undefined && !isStore(v.store)) add({ path: 'store', code: 'invalid_type', message: STORE_RULE, expected: STORE_RULE });
    // a hand-written capabilities object must be as complete as defineCapabilities builds it, or core fails at its first read
    else if (v.store !== undefined) for (const issue of storeCapabilityIssues(v.store.capabilities)) add(issue);
    if (!NAMESPACE_RE.test(v.namespace)) add({ path: 'namespace', code: 'invalid_value', message: NAMESPACE_RULE, expected: NAMESPACE_RULE });
    resolveHistory(v.history, add);
    resolveDeadLetter(v.deadLetter, add);
    resolveAlerts(v.alerts, add);
  },
};

/**
 * Validate a queue's name and options together and resolve every default.
 * Throws one InvalidOptionError, scope `Queue "<name>"`, listing every problem.
 */
export function resolveQueueOptions(name: string, opts: unknown): ResolvedQueueOptions {
  const scope = `Queue "${name}"`;
  const issues: ConfigIssue[] = [];
  if (typeof name !== 'string' || !QUEUE_NAME_RE.test(name)) {
    issues.push({ path: 'name', code: 'invalid_value', message: NAME_RULE, expected: NAME_RULE });
  }
  let resolved: ResolvedQueueOptions | undefined;
  // resolved once: its issues join the others, its warning goes with the value
  const raw = typeof opts === 'object' && opts !== null ? (opts as { retention?: unknown; deadLetter?: unknown }) : {};
  const retention = resolveRetention(raw.retention, raw.deadLetter !== false);
  issues.push(...retention.issues);
  let input = opts;
  const defaults = (opts as { defaultJobOptions?: unknown } | undefined)?.defaultJobOptions;
  if (defaults !== undefined) {
    // Work on a deep copy, so the caller's object is never frozen and later mutations have no effect.
    try {
      input = { ...(opts as object), defaultJobOptions: structuredClone(defaults) };
    } catch {
      // Not cloneable (a function inside); validation reports it.
    }
  }
  try {
    resolved = validate(scope, input, queueSchema) as unknown as ResolvedQueueOptions;
    const m = resolved.metrics as unknown as { window: number; buckets: readonly number[]; maxNameLabels: number };
    resolved = Object.freeze({
      ...resolved, history: resolveHistory(resolved.history), deadLetter: Object.freeze(resolveDeadLetter(resolved.deadLetter)),
      retention: deepFreeze(retention.value),
      metrics: Object.freeze({ windowMs: m.window, buckets: Object.freeze([...m.buckets]), maxNameLabels: m.maxNameLabels }),
      alerts: resolveAlerts(resolved.alerts),
    });
    deepFreeze(resolved.defaultJobOptions);
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    issues.push(...e.issues);
  }
  if (issues.length > 0 || !resolved) throw new InvalidOptionError(scope, issues);
  return resolved;
}

/** The options a `Producer` takes: the add side of `QueueOptions`, with `store` required. */
export type ProducerOptions<D = unknown> = Pick<
  QueueOptions<D>,
  | 'namespace' | 'id' | 'onDuplicate' | 'uniqueWhile' | 'defaultJobOptions' | 'order' | 'maxPayloadBytes' | 'maxBulkSize' | 'logger'
  | 'reconnect' | 'onDisconnected' | 'maxWait' | 'maxBufferedAdds' | 'filter' | 'filterTimeoutMs'
> & {
  store: Store;
  /** @internal Test seam for reconnect jitter; default Math.random. */
  random?: (() => number) | undefined;
};

export const PRODUCER_KEYS = [
  'store', 'namespace', 'id', 'onDuplicate', 'uniqueWhile', 'defaultJobOptions', 'order', 'maxPayloadBytes', 'maxBulkSize', 'logger',
  'reconnect', 'onDisconnected', 'maxWait', 'maxBufferedAdds', 'filter', 'filterTimeoutMs', 'random',
] as const satisfies ReadonlyArray<keyof ProducerOptions>;

/**
 * Validate a producer's name and options: only the add-side options, `store` required; then resolved as a queue's.
 * Throws one InvalidOptionError, scope `Producer "<name>"`, listing every problem.
 */
export function resolveProducerOptions(name: string, opts: unknown): ResolvedQueueOptions {
  const scope = `Producer "${name}"`;
  const issues: ConfigIssue[] = [];
  const given = (typeof opts === 'object' && opts !== null ? opts : {}) as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  for (const key of Object.keys(given)) {
    if ((PRODUCER_KEYS as readonly string[]).includes(key)) {
      known[key] = given[key];
      continue;
    }
    const suggestion = closest(key, PRODUCER_KEYS);
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : ' (not a producer option)';
    issues.push({ path: key, code: 'unknown_option', message: `unknown option${hint}`, ...(suggestion && { suggestion }) });
  }
  if (given['store'] === undefined) issues.push({ path: 'store', code: 'missing_option', message: 'required option is missing: a producer needs a shared store' });
  try {
    const resolved = resolveQueueOptions(name, known);
    if (issues.length === 0) return resolved;
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    issues.push(...e.issues);
  }
  throw new InvalidOptionError(scope, issues);
}
