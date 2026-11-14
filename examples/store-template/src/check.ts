// Request checks (rule 3): every request is checked before anything is read or written; a bad request throws
// `StoreRequestError`. Unknown fields are refused, so a field the store does not handle yet never slips through.
import { StoreRequestError } from '@sureq/core';

export type Pred = (v: unknown) => boolean;

export const bad = (op: string, message: string): never => {
  throw new StoreRequestError(message, { operation: op });
};
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const int = (min: number, max = Number.MAX_SAFE_INTEGER): Pred => (v) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
export const text: Pred = (v) => typeof v === 'string' && v !== '';
export const optText: Pred = (v) => v === null || typeof v === 'string';
export const bool: Pred = (v) => typeof v === 'boolean';
export const payload: Pred = (v) => typeof v === 'string' || v instanceof Uint8Array;
export const optPayload: Pred = (v) => v === null || payload(v);
export const oneOf = (...values: unknown[]): Pred => (v) => values.includes(v);
export const idOf = (maxBytes: number): Pred => (v) => text(v) && new TextEncoder().encode(v as string).length <= maxBytes;

/** The object has only the listed fields, each passing its check, and all of `required`. Unknown fields are refused. */
export function check(op: string, what: string, v: unknown, spec: Record<string, Pred>, required: readonly string[] = []): void {
  if (!isObj(v)) return bad(op, `${what} must be an object`);
  for (const [key, value] of Object.entries(v)) {
    if (value === undefined) continue;
    if (!spec[key]) bad(op, `unknown field ${what}.${key}`);
    else if (!spec[key]!(value)) bad(op, `${what}.${key} is invalid`);
  }
  for (const key of required) if (v[key] === undefined) bad(op, `${what}.${key} is required`);
}

/** Core never sees an instant past the safe integer range. */
export function safeAt(op: string, at: number, what: string): void {
  if (at > Number.MAX_SAFE_INTEGER) bad(op, `${what} beyond the safe integer range`);
}

export const SCOPE = { namespace: text, queue: text };
export const FENCED = { id: text, token: int(0) };

/** A job to insert (`add`, and the job a `fireSchedule` inserts). */
export function checkJob(op: string, job: unknown, maxIdBytes: number): void {
  check(op, 'job', job, {
    id: idOf(maxIdBytes), name: optText, data: payload, dataVersion: (v) => v === null || int(Number.MIN_SAFE_INTEGER)(v), formatVersion: int(1),
    priority: int(Number.MIN_SAFE_INTEGER), first: bool, delayMs: int(0), runAt: int(0), maxAttempts: int(1), backoff: optPayload, timeout: optPayload,
    idempotencyKey: optText, keep: optPayload, uniqueWhile: oneOf('pending', 'retained'), onDuplicate: oneOf('ignore', 'replace', 'reject'),
    singletonKey: (v) => v === null || idOf(maxIdBytes)(v), defaulted: (v) => Array.isArray(v) && v.every((f) => ['priority', 'maxAttempts', 'backoff'].includes(f)),
  }, ['id', 'data', 'formatVersion', 'maxAttempts']);
  // WHY: `id#<seq>` is the key a superseded record moves to (history), so a new job may not take one.
  if (/#-?\d+$/.test((job as { id: string }).id)) bad(op, 'id must not end in "#" and digits');
  const { delayMs, runAt } = job as { delayMs?: unknown; runAt?: unknown };
  if (delayMs !== undefined && runAt !== undefined) bad(op, 'delayMs and runAt cannot both be set');
}
