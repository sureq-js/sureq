import { describe, expect, it } from 'vitest';
import { SerializationError } from '../../src/errors/catalog.js';
import { serializeValue } from '../../src/serialize/value.js';

describe('serialization cause', () => {
  it('serialize: a circular value error cause does not contain property names', () => {
    const secretHolder: Record<string, unknown> = { accountNumberSecret: 1 };
    secretHolder['selfRefSecret'] = { backToParentSecret: secretHolder };
    let thrown: unknown;
    try {
      serializeValue(secretHolder);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SerializationError);
    const cause = (thrown as Error).cause;
    expect(cause).toBeInstanceOf(TypeError);
    expect(String((cause as Error).message)).not.toMatch(/Secret/);
    expect(String((cause as Error).stack)).not.toMatch(/Secret/);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toMatch(/Secret/);
  });
});
