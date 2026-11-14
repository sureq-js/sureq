import { describe, expect, it } from 'vitest';
import { utf8Length } from '../../src/util/bytes.js';

describe('size (utf8 length)', () => {
  it('size: utf8 length matches the old measure for multi-byte and lone-surrogate strings', () => {
    for (const s of ['', 'a', 'é', '€', '😀', '\ud800', 'a\udc00b']) expect(utf8Length(s), JSON.stringify(s)).toBe(Buffer.byteLength(s));
  });
});
