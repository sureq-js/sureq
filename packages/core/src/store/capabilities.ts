import { InvalidOptionError, type ConfigIssue } from '../errors/catalog.js';

/** What a store can do; core reads these flags before using a feature. */
export interface StoreCapabilities {
  /** An `add` with `atomic: true` is all or nothing; without it, `atomic` throws `CapabilityError`. */
  readonly transactions: boolean;
  /** Many claimers do not block each other; without it, workers claim fewer jobs per call and spread their polls. */
  readonly skipLocked: boolean;
  /** The store has `subscribe`, and a wake arrives within about two seconds of an add. */
  readonly notify: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly ttl: boolean;
  /** An acknowledged write survives a restart; without it, the first `process()` logs a warning. */
  readonly durable: boolean;
  /** Several store objects, even in several processes, can use one backend. */
  readonly shared: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly claimConstraints: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly boundedAdd: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly flows: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly logs: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly archive: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly audit: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly metricsHistory: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly changeFeed: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly externalTransaction: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly migrations: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly singleNode: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly patch: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly deadlines: boolean;
  /** Reserved for a later release; leave it `false`. */
  readonly queueRecords: boolean;
  /** `maxIdBytes`: longest job id in UTF-8 bytes (default 255, at least 36). `maxClaimLimit`: most jobs one `claim` returns (default 1000). */
  readonly limits: { readonly maxIdBytes: number; readonly maxClaimLimit: number };
}

/** What `defineCapabilities` accepts: any flag may be left out, and so may either limit. */
export type CapabilitiesInput = Partial<Omit<StoreCapabilities, 'limits'>> & { limits?: Partial<StoreCapabilities['limits']> };

const FLAGS = [
  'transactions', 'skipLocked', 'notify', 'ttl', 'durable', 'shared', 'claimConstraints', 'boundedAdd', 'flows', 'logs',
  'archive', 'audit', 'metricsHistory', 'changeFeed', 'externalTransaction', 'migrations', 'singleNode', 'patch', 'deadlines',
  'queueRecords',
] as const;
const DEFAULT_MAX_ID_BYTES = 255;
const DEFAULT_MAX_CLAIM_LIMIT = 1000;
const MIN_MAX_ID_BYTES = 36;
const LIMITS = [
  { key: 'maxIdBytes', min: MIN_MAX_ID_BYTES, fallback: DEFAULT_MAX_ID_BYTES },
  { key: 'maxClaimLimit', min: 1, fallback: DEFAULT_MAX_CLAIM_LIMIT },
] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function issuesOf(value: unknown, mustBeFrozen: boolean): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: string, code: ConfigIssue['code'], message: string): void => void issues.push({ path, code, message });
  if (!isObject(value)) {
    add('capabilities', 'invalid_type', 'capabilities must be an object');
  } else {
    for (const flag of FLAGS) {
      if (value[flag] === undefined) add(flag, 'missing_option', `${flag} is required`);
      else if (typeof value[flag] !== 'boolean') add(flag, 'invalid_type', `${flag} must be a boolean`);
    }
    const limits = value['limits'];
    if (!isObject(limits)) {
      add('limits', limits === undefined ? 'missing_option' : 'invalid_type', 'limits must be an object');
    } else {
      for (const { key, min } of LIMITS) {
        const v = limits[key];
        const path = `limits.${key}`;
        if (v === undefined) add(path, 'missing_option', `${path} is required`);
        else if (typeof v !== 'number' || !Number.isInteger(v)) add(path, 'invalid_type', `${path} must be an integer`);
        else if (v < min) add(path, 'out_of_range', `${path} must be at least ${min}`);
      }
      if (mustBeFrozen && !Object.isFrozen(limits)) add('limits', 'invalid_value', 'limits must be frozen');
    }
    if (mustBeFrozen && !Object.isFrozen(value)) add('capabilities', 'invalid_value', 'capabilities must be frozen (use defineCapabilities)');
  }
  return issues;
}

function check(value: unknown, scope: string, mustBeFrozen: boolean): void {
  const issues = issuesOf(value, mustBeFrozen);
  if (issues.length > 0) throw new InvalidOptionError(scope, issues);
}

/** What `validateCapabilities` would reject, as option issues under `store.capabilities`. */
export function storeCapabilityIssues(value: unknown): ConfigIssue[] {
  return issuesOf(value, true).map((i) => ({
    ...i,
    path: i.path === 'capabilities' ? 'store.capabilities' : `store.capabilities.${i.path}`,
  }));
}

/** Check a store's `capabilities` as core reads it: complete, well typed and frozen. Returns the same object. */
export function validateCapabilities(value: unknown, scope: string): StoreCapabilities {
  check(value, scope, true);
  return value as StoreCapabilities;
}

/** Build a store's capabilities: missing flags are false, limits default, and the result is deeply frozen. */
export function defineCapabilities(c: CapabilitiesInput): StoreCapabilities {
  const src: Record<string, unknown> = isObject(c) ? c : {};
  // Only a left-out value is defaulted; anything given, `null` included, goes to `check` as it is.
  const orDefault = (v: unknown, fallback: unknown): unknown => (v === undefined ? fallback : v);
  const draft: Record<string, unknown> = {};
  for (const flag of FLAGS) draft[flag] = orDefault(src[flag], false);
  const given = src['limits'];
  if (given === undefined || isObject(given)) {
    const limits: Record<string, unknown> = {};
    for (const { key, fallback } of LIMITS) limits[key] = orDefault(given?.[key], fallback);
    draft['limits'] = Object.freeze(limits);
  } else {
    draft['limits'] = given; // not an object: `check` reports it
  }
  check(isObject(c) ? draft : c, 'defineCapabilities', false);
  return Object.freeze(draft) as unknown as StoreCapabilities;
}
