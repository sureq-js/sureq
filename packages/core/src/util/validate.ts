import { InvalidOptionError, type ConfigIssue } from '../errors/catalog.js';
import { tryParseDuration } from './duration.js';

export { formatIssues } from '../errors/format-issues.js';

/** How one option is checked. */
export type Rule = {
  kind: 'integer' | 'number' | 'string' | 'boolean' | 'duration' | 'function' | 'object' | 'array' | 'enum' | 'unknown';
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  values?: readonly string[];
  schema?: Schema<Record<string, unknown>>;
  secret?: boolean;
  item?: Rule;
};

/** The options one scope accepts. `renamed` maps legacy names to current ones. */
export type Schema<T> = {
  fields: { [K in keyof T & string]-?: Rule };
  renamed?: Readonly<Record<string, string>>;
  check?: (value: T, add: (issue: ConfigIssue) => void) => void;
};

const SECRET_KEY = /password|secret|token|key/i;

/** Closest candidate within edit distance 2 (ties: alphabetically first), for did-you-mean hints. */
export function closest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of [...candidates].sort()) {
    const d = levenshtein(name, c);
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a bad value may safely show in an error: small primitives only, otherwise its type. */
function describe(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v.length <= 64 ? v : 'string';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function expectedText(rule: Rule): string {
  if (rule.kind === 'enum') return `one of ${(rule.values ?? []).map((v) => `"${v}"`).join(' | ')}`;
  if (rule.kind === 'duration') return 'duration';
  const bounds = [rule.min !== undefined && `>= ${rule.min}`, rule.max !== undefined && `<= ${rule.max}`].filter(Boolean);
  return [rule.kind, ...bounds].join(' ');
}

class Walker {
  readonly issues: ConfigIssue[] = [];
  /** Objects this walker built; only these are frozen (user-supplied objects are left alone). */
  readonly owned = new WeakSet<object>();

  #own<T extends object>(v: T): T {
    this.owned.add(v);
    return v;
  }

  bad(path: string, code: ConfigIssue['code'], rule: Rule, value: unknown, key: string): void {
    const expected = expectedText(rule);
    const issue: ConfigIssue = { path, code, message: `expected ${expected}`, expected };
    if (!rule.secret && !SECRET_KEY.test(key)) {
      issue.received = describe(value);
      issue.message += `, received ${issue.received}`;
    }
    this.issues.push(issue);
  }

  object(input: unknown, schema: Schema<Record<string, unknown>>, prefix: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.owned.add(out);
    if (!isPlainObject(input)) {
      this.issues.push({ path: prefix.slice(0, -1), code: 'invalid_type', message: `expected object, received ${describe(input)}`, expected: 'object', received: describe(input) });
      return out;
    }
    const names = Object.keys(schema.fields);
    for (const key of Object.keys(input)) {
      if (key in schema.fields) continue;
      const path = prefix + key;
      const renamed = schema.renamed?.[key];
      const suggestion = renamed ?? closest(key, names);
      const hint = renamed ? ` (use "${renamed}")` : suggestion ? ` (did you mean "${suggestion}"?)` : '';
      this.issues.push({ path, code: 'unknown_option', message: `unknown option${hint}`, ...(suggestion && { suggestion }) });
    }
    for (const [key, rule] of Object.entries(schema.fields)) {
      const value = this.field(input[key], rule, prefix + key, key);
      if (value !== undefined) out[key] = value;
    }
    schema.check?.(out, (issue) => this.issues.push(issue));
    return out;
  }

  field(value: unknown, rule: Rule, path: string, key: string): unknown {
    if (value === undefined) {
      if (rule.default !== undefined) return rule.default;
      if (rule.required) {
        this.issues.push({ path, code: 'missing_option', message: 'required option is missing' });
        return undefined;
      }
      return rule.kind === 'object' && rule.schema ? this.object({}, rule.schema, `${path}.`) : undefined;
    }
    switch (rule.kind) {
      case 'integer':
      case 'number': {
        const ok = typeof value === 'number' && (rule.kind === 'integer' ? Number.isInteger(value) : Number.isFinite(value));
        if (!ok) return this.bad(path, 'invalid_type', rule, value, key);
        if ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) {
          return this.bad(path, 'out_of_range', rule, value, key);
        }
        return value;
      }
      case 'string':
      case 'boolean':
      case 'function':
        return typeof value === rule.kind ? value : this.bad(path, 'invalid_type', rule, value, key);
      case 'enum':
        if (typeof value !== 'string') return this.bad(path, 'invalid_type', rule, value, key);
        return rule.values?.includes(value) ? value : this.bad(path, 'invalid_value', rule, value, key);
      case 'duration': {
        const r = tryParseDuration(value);
        return r.ok ? r.ms : this.bad(path, r.code, rule, value, key);
      }
      case 'array':
        if (!Array.isArray(value)) return this.bad(path, 'invalid_type', rule, value, key);
        if (!rule.item) return value;
        return this.#own(value.map((v, i) => this.field(v, rule.item!, `${path}[${i}]`, key)));
      case 'object':
        if (!isPlainObject(value)) return this.bad(path, 'invalid_type', rule, value, key);
        return rule.schema ? this.object(value, rule.schema, `${path}.`) : value;
      case 'unknown':
        return value;
    }
  }
}

function freezeOwned<T>(v: T, owned: WeakSet<object>): T {
  if (typeof v === 'object' && v !== null && owned.has(v) && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) freezeOwned(child, owned);
  }
  return v;
}

/**
 * Validate user options against a schema: unknown keys, types, ranges, durations and defaults.
 * Returns a deeply frozen copy with defaults applied, or throws one InvalidOptionError with every issue.
 */
export function validate<T>(scope: string, input: unknown, schema: Schema<T>): T {
  const walker = new Walker();
  const out = walker.object(input ?? {}, schema as Schema<Record<string, unknown>>, '');
  if (walker.issues.length > 0) throw new InvalidOptionError(scope, walker.issues);
  return freezeOwned(out, walker.owned) as T;
}
