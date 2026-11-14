const encoder = new TextEncoder();

/** UTF-8 byte length; a lone surrogate counts as U+FFFD (3 bytes), as `Buffer.byteLength` does. */
export function utf8Length(s: string): number {
  return encoder.encode(s).byteLength;
}
