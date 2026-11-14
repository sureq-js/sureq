/** Brand carried by every SureQ error, so checks work across duplicate ESM/CJS copies. */
const BRAND = Symbol.for('sureq.error');

/** The plain-object form of a SureQ error, as `toJSON()` returns it. */
export interface SureQErrorJSON {
  /** The error class name, such as `'JobTimeoutError'`. */
  name: string;
  /** The stable error code, such as `'JOB_TIMEOUT'`. */
  code: string;
  /** The error message. */
  message: string;
  /** The error's structured details; left out when there are none. */
  details?: Record<string, unknown>;
}

/** Base class of every error SureQ throws. Subclasses override `code`. */
export class SureQError extends Error {
  /** A stable code naming the error, such as `'JOB_TIMEOUT'`. Match on this rather than the message. */
  readonly code: string = 'SUREQ_ERROR';
  /** Structured facts about the failure (ids, sizes, reasons); `{}` when there are none. */
  readonly details: Record<string, unknown>;

  constructor(message: string, opts: { cause?: unknown; details?: Record<string, unknown> } = {}) {
    super(message, 'cause' in opts ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.details = opts.details ?? {};
  }

  /** A plain object with `name`, `code`, `message` and, when present, `details`. The `cause` is left out. */
  toJSON(): SureQErrorJSON {
    const json: SureQErrorJSON = { name: this.name, code: this.code, message: this.message };
    if (Object.keys(this.details).length > 0) json.details = this.details;
    return json;
  }

  /** True for any SureQ error, including one from another copy of the package. Same as the `isSureQError` function. */
  static isSureQError(e: unknown): e is SureQError {
    return isSureQError(e);
  }
}
Object.defineProperty(SureQError.prototype, BRAND, { value: true });

/** True for any SureQ error, including one created by another copy of the package. */
export function isSureQError(e: unknown): e is SureQError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Record<PropertyKey, unknown>)[BRAND] === true &&
    typeof (e as { code?: unknown }).code === 'string'
  );
}

/** Any class whose instances are SureQErrors, whatever its constructor arguments. */
export type SureQErrorClass = abstract new (...args: never[]) => SureQError;

const catalogue: Record<string, SureQErrorClass> = {};

/** Code → class for every catalogued error. */
export const errorCatalogue: Readonly<Record<string, SureQErrorClass>> = catalogue;

/** Register a catalogue class. A duplicate code is a programming error and fails at module load. */
export function registerError(cls: SureQErrorClass, code: string): void {
  if (code in catalogue) throw new TypeError(`Duplicate SureQ error code ${code}`);
  catalogue[code] = cls;
}
