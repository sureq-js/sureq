import { SerializationError } from '../errors/catalog.js';
import { utf8Length } from '../util/bytes.js';

/** UTF-8 byte length of serialized text: what the size limits measure. */
export function byteLength(json: string): number {
  return utf8Length(json);
}

/**
 * Serialize job data or a result to JSON text and its UTF-8 size. `undefined` is stored as `null`.
 * Throws SerializationError for cycles, `bigint`, or a root function/symbol; the message never
 * contains the value.
 */
export function serializeValue(v: unknown): { json: string; bytes: number } {
  let json: string | undefined;
  try {
    json = v === undefined ? 'null' : JSON.stringify(v);
  } catch {
    // The native message can name the value's properties, so the cause carries a fixed one.
    const cause = new TypeError('JSON.stringify refused the value');
    throw new SerializationError('value is not JSON-serializable (circular reference or bigint)', { cause });
  }
  if (json === undefined) throw new SerializationError(`value is not JSON-serializable (root is a ${typeof v})`);
  return { json, bytes: byteLength(json) };
}
