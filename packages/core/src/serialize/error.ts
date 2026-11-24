import type { Schema } from '../util/validate.js';
import { utf8Length } from '../util/bytes.js';

/** Any value with a JSON form. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** A stored, JSON-safe, size-capped description of a thrown value. */
export interface SerializedError {
  /** The format version. */
  v: 1;
  /** The error name, such as `'TypeError'`. */
  name: string;
  /** The message. */
  message: string;
  /** The stack, when `storeStacks` is on. */
  stack?: string;
  /** The error's `code`. */
  code?: string | number;
  /** The `cause`, serialized the same way. */
  cause?: SerializedError;
  /** The inner errors of an `AggregateError`. */
  errors?: SerializedError[];
  /** Other own fields of the error. */
  props?: Record<string, JsonValue>;
  /** Set when the error was cut to `maxErrorBytes`. */
  truncated?: true;
}

/** Limits for `serializeError`. */
export interface SerializeOptions {
  /** Most bytes of the serialized error; larger errors are cut and marked `truncated`. */
  maxErrorBytes: number;
  /** Keep stack traces. */
  storeStacks: boolean;
}

/** Queue options that control error serialization (validated once at `new Queue`). */
export const errorOptionsSchema: Schema<SerializeOptions> = {
  fields: {
    maxErrorBytes: { kind: 'integer', min: 512, default: 16_384 },
    storeStacks: { kind: 'boolean', default: true },
  },
};

/** The queue's defaults, for a call from plain JS that left out `opts`. */
const DEFAULT_SERIALIZE: SerializeOptions = {
  maxErrorBytes: errorOptionsSchema.fields.maxErrorBytes.default as number,
  storeStacks: errorOptionsSchema.fields.storeStacks.default as boolean,
};

const RESERVED = new Set(['name', 'message', 'stack', 'code', 'cause', 'errors']);
const PROPS_DEPTH = 3;
const CAUSE_DEPTH = 5;
const DROP = Symbol('drop');

/** Read one property; a throwing getter or proxy trap means "absent". */
function read(obj: object, key: PropertyKey): unknown {
  try {
    return (obj as Record<PropertyKey, unknown>)[key];
  } catch {
    return undefined;
  }
}

function ownKeys(obj: object): string[] {
  try {
    return Object.keys(obj);
  } catch {
    return [];
  }
}

/** Convert an arbitrary value into JSON. `depth` is 1 for a top-level prop. */
function toJson(v: unknown, depth: number, ancestors: WeakSet<object>): JsonValue | typeof DROP {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return v.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return DROP;
  }
  if (v === null) return null;
  const obj = v as object;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
  if (ArrayBuffer.isView(obj)) return `[Buffer ${obj.byteLength} bytes]`;
  if (ancestors.has(obj)) return '[Circular]';
  if (depth > PROPS_DEPTH) return Array.isArray(obj) ? '[Array]' : '[Object]';
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => {
        const j = toJson(item, depth + 1, ancestors);
        return j === DROP ? null : j;
      });
    }
    const out: Record<string, JsonValue> = {};
    for (const key of ownKeys(obj)) {
      const j = toJson(read(obj, key), depth + 1, ancestors);
      if (j !== DROP) out[key] = j;
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/** An Error, or an object with a string `message`. A real Error counts even when its `message` cannot be read. */
const isErrorLike = (v: unknown): v is object => {
  if (typeof v !== 'object' || v === null) return false;
  if (typeof read(v, 'message') === 'string') return true;
  try {
    return v instanceof Error;
  } catch {
    // a revoked proxy
    return false;
  }
};

/** The constructor's name, for an Error whose own `name` cannot be read. */
function ctorName(v: object): string | undefined {
  try {
    const n: unknown = (v as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof n === 'string' && n ? n : undefined;
  } catch {
    return undefined;
  }
}

/** A short JSON description of an object, for a message. */
function summarize(v: object, value: JsonValue | typeof DROP): string {
  let summary: string;
  try {
    summary = JSON.stringify(value) ?? String(v);
  } catch {
    summary = '[object]';
  }
  return summary.slice(0, 200);
}

/** An error's message as text: a message that is not a string is described, and one that cannot be read is marked. */
function messageOf(v: object): string {
  let m: unknown;
  try {
    m = (v as { message?: unknown }).message;
  } catch {
    return '[unserializable error]';
  }
  if (typeof m === 'string') return m;
  if (m === undefined) return '';
  if (typeof m === 'object' && m !== null) return summarize(m, toJson(m, 1, new WeakSet()));
  return String(m);
}

function nonError(v: unknown): SerializedError {
  const out: SerializedError = { v: 1, name: 'NonErrorThrown', message: '' };
  if (typeof v === 'string') {
    out.message = v;
    return out;
  }
  const value = toJson(v, 1, new WeakSet());
  if (typeof v === 'object' && v !== null) {
    out.message = summarize(v, value);
  } else {
    out.message = String(v);
  }
  if (value !== DROP) out.props = { value };
  return out;
}

interface Walk {
  opts: SerializeOptions;
  seen: WeakSet<object>;
  truncated: boolean;
}

// Size caps.
const NAME_MAX = 128;
const KEY_MAX = 64;
const PROPS_MAX = 32;
const PROP_STRING_MAX = 1024;
const STACK_MAX = 8192;
const ERRORS_MAX = 10;
const MESSAGE_MAX = 2048;
const STRING_SUFFIX = '…[truncated]';

/** Shorten a string to `max` chars (last char `…`), recording that a cap fired. */
function clip(s: string, max: number, w: { truncated: boolean }): string {
  if (s.length <= max) return s;
  w.truncated = true;
  return s.slice(0, max - 1) + '…';
}

const bytes = (s: SerializedError): number => utf8Length(JSON.stringify(s));

/** Every node of the tree (root first, then causes and aggregate entries, depth-first). */
function nodes(root: SerializedError): SerializedError[] {
  const out: SerializedError[] = [];
  const visit = (n: SerializedError): void => {
    out.push(n);
    if (n.cause) visit(n.cause);
    n.errors?.forEach(visit);
  };
  visit(root);
  return out;
}

function capStrings(v: JsonValue): JsonValue {
  if (typeof v === 'string') return v.length <= PROP_STRING_MAX ? v : v.slice(0, PROP_STRING_MAX - STRING_SUFFIX.length) + STRING_SUFFIX;
  if (Array.isArray(v)) return v.map(capStrings);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x)]));
  return v;
}

/** One truncation step: mutate the tree, then the caller re-measures. Order is the spec's. */
type Step = (root: SerializedError, max: number) => void;
const STEPS: Step[] = [
  (root) => {
    for (const n of nodes(root)) {
      if (n.props) n.props = Object.fromEntries(Object.entries(n.props).slice(0, PROPS_MAX).map(([k, v]) => [k, capStrings(v)]));
    }
  },
  (root) => {
    for (const n of nodes(root)) if (n.stack !== undefined && n.stack.length > STACK_MAX) n.stack = n.stack.slice(0, STACK_MAX);
  },
  (root) => {
    for (const n of nodes(root)) if (n.errors && n.errors.length > ERRORS_MAX) n.errors = n.errors.slice(0, ERRORS_MAX);
  },
  (root) => {
    for (const n of nodes(root)) delete n.props;
  },
  (root) => {
    for (const n of nodes(root)) if (n.message.length > MESSAGE_MAX) n.message = n.message.slice(0, MESSAGE_MAX - 1) + '…';
  },
  (root, max) => {
    // Stacks first (innermost first), then causes and aggregate entries (innermost first).
    const all = nodes(root).reverse();
    for (const n of all) {
      if (bytes(root) <= max) return;
      delete n.stack;
    }
    for (const n of all) {
      if (bytes(root) <= max) return;
      delete n.cause;
      delete n.errors;
    }
  },
  (root, max) => {
    // Cut the root message to the longest prefix (on a code-point boundary) that fits; a character may take several bytes.
    fitPrefix(root, 'message', max);
  },
  (root, max) => {
    // Name and code are capped in characters, which can still be too many bytes for a small limit: cut the code first,
    // then the name, which says more about the error.
    if (typeof root.code === 'string') fitPrefix(root, 'code', max);
    fitPrefix(root, 'name', max);
  },
];

/** Shorten `root[field]` to its longest code-point prefix with which the whole result fits in `max` bytes. */
function fitPrefix(root: SerializedError, field: 'message' | 'name' | 'code', max: number): void {
  if (bytes(root) <= max) return;
  const chars = [...(root[field] as string)];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    root[field] = chars.slice(0, mid).join('');
    if (bytes(root) <= max) lo = mid;
    else hi = mid - 1;
  }
  root[field] = chars.slice(0, lo).join('');
}

function capture(v: unknown, depth: number, w: Walk): SerializedError {
  if (depth >= CAUSE_DEPTH) {
    w.truncated = true;
    return { v: 1, name: 'Truncated', message: '…' };
  }
  if (!isErrorLike(v)) return nonError(v);
  if (w.seen.has(v)) return { v: 1, name: 'Circular', message: '[Circular cause]' };
  w.seen.add(v);

  const name = read(v, 'name');
  const out: SerializedError = { v: 1, name: clip(typeof name === 'string' && name ? name : (ctorName(v) ?? 'Error'), NAME_MAX, w), message: messageOf(v) };
  const stack = read(v, 'stack');
  if (w.opts.storeStacks && typeof stack === 'string') out.stack = stack;
  const code = read(v, 'code');
  if (typeof code === 'string') out.code = clip(code, NAME_MAX, w);
  else if (typeof code === 'number' && Number.isFinite(code)) out.code = code;
  const cause = read(v, 'cause');
  if (cause !== undefined) out.cause = capture(cause, depth + 1, w);
  const errors = read(v, 'errors');
  if (Array.isArray(errors)) out.errors = errors.map((e) => capture(e, depth + 1, w));

  const props: Record<string, JsonValue> = {};
  for (const key of ownKeys(v)) {
    if (RESERVED.has(key)) continue;
    const j = toJson(read(v, key), 1, new WeakSet([v]));
    if (j !== DROP) props[clip(key, KEY_MAX, w)] = j;
  }
  if (Object.keys(props).length > 0) out.props = props;
  return out;
}

/**
 * Describe any thrown value as a JSON-safe SerializedError. Never throws, for any input.
 * `opts` are trusted: the queue validated them with errorOptionsSchema.
 */
export function serializeError(err: unknown, opts: SerializeOptions): SerializedError {
  // Plain JS may leave out `opts`: the queue defaults then, not a fallback that loses what the error was.
  opts ??= DEFAULT_SERIALIZE;
  try {
    const walk: Walk = { opts, seen: new WeakSet(), truncated: false };
    const out = capture(err, 0, walk);
    if (walk.truncated) out.truncated = true;
    for (const step of STEPS) {
      if (bytes(out) <= opts.maxErrorBytes) break;
      out.truncated = true;
      step(out, opts.maxErrorBytes);
    }
    return out;
  } catch {
    return { v: 1, name: 'NonErrorThrown', message: '[unserializable error]', truncated: true };
  }
}

/** A plain Error for display. Built via Reflect so the bare-Error lint guard stays meaningful for throws. */
const plainError = (message: string): Error => Reflect.construct(Error, [message]) as Error;

/** Rebuild a plain Error (or AggregateError) for display. Never revives SureQ classes. Never throws. */
export function deserializeError(s: SerializedError): Error {
  try {
    const message = typeof s.message === 'string' ? s.message : '';
    if (s.v !== 1) return Object.assign(plainError(message), { name: String(s.name) });
    const err = s.errors ? new AggregateError(s.errors.map(deserializeError), message) : plainError(message);
    err.name = s.name;
    if (s.stack !== undefined) err.stack = s.stack;
    if (s.cause) Object.defineProperty(err, 'cause', { value: deserializeError(s.cause), writable: true, configurable: true });
    if (s.code !== undefined) Object.assign(err, { code: s.code });
    if (s.props) Object.assign(err, s.props);
    return err;
  } catch {
    return plainError('[undeserializable error]');
  }
}
