const BRAND = Symbol.for('sureq.unrecoverable');
const MAX_LINKS = 32;

/**
 * Whether `err` marks the job as not retryable. Detection is by the shared brand, so an
 * UnrecoverableError from another copy of the package counts; a look-alike `code` does not. With
 * `unwrapCause` (the worker's default), the `cause` chain is searched too (cycles and very long chains stop the walk).
 */
export function isUnrecoverable(err: unknown, unwrapCause = false): boolean {
  const seen = new WeakSet<object>();
  let v = err;
  for (let i = 0; i < MAX_LINKS && typeof v === 'object' && v !== null && !seen.has(v); i++) {
    if ((v as Record<symbol, unknown>)[BRAND] === true) return true;
    if (!unwrapCause) return false;
    seen.add(v);
    v = (v as { cause?: unknown }).cause;
  }
  return false;
}
