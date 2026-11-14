import { describe, expect, it } from 'vitest';
import { serializeValue } from '../../src/serialize/value.js';
import { SerializationError } from '../../src/errors/catalog.js';

describe('serializeValue', () => {
  it('payload: size is measured in utf-8 bytes of the serialized form', () => {
    expect(serializeValue('é').bytes).toBe(4); // "é" = 2 quotes + 2 bytes
    expect(serializeValue('日本').bytes).toBe(8); // 2 quotes + 6 bytes
    expect(serializeValue({ a: 1 }).bytes).toBe(7); // {"a":1}
    expect(serializeValue(undefined)).toEqual({ json: 'null', bytes: 4 });
  });

  it('add: unserializable data throws SerializationError (serializer half)', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    for (const bad of [cyc, 1n, () => 1, Symbol('x')]) {
      expect.soft(() => serializeValue(bad), String(typeof bad)).toThrow(SerializationError);
    }
  });

  it('add: SerializationError message never contains the value', () => {
    const secret = { token: 'hunter2-secret', n: 1n };
    try {
      serializeValue(secret);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
      expect((e as Error).cause).toBeInstanceOf(TypeError);
    }
  });
});
