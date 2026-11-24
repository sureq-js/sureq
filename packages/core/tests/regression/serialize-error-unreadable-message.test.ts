import { describe, expect, it } from 'vitest';
import { serializeError } from '../../src/serialize/error.js';

const unreadable = <E extends Error>(e: E): E => {
  Object.defineProperty(e, 'message', { get() { throw new Error('nope'); } });
  return e;
};

// A real Error whose `message` getter throws keeps its name: it is still an Error, not a NonErrorThrown.
describe('serializeError on an Error with an unreadable message (regression)', () => {
  it('regression: the documented two-argument form keeps name Error', () => {
    const s = serializeError(unreadable(new Error('x')), { maxErrorBytes: 16_384, storeStacks: false });
    expect(s).toMatchObject({ v: 1, name: 'Error', message: '[unserializable error]' });
  });

  it('regression: a subclass keeps its own name', () => {
    expect(serializeError(unreadable(new TypeError('x')), { maxErrorBytes: 16_384, storeStacks: false })).toMatchObject({ name: 'TypeError' });
  });

  it('regression: an Error with a readable message that is not a string keeps that message as text', () => {
    const opts = { maxErrorBytes: 16_384, storeStacks: false };
    const num = Object.assign(new Error('x'), { message: 42 });
    expect(serializeError(num, opts)).toMatchObject({ name: 'Error', message: '42' });
    const obj = Object.assign(new Error('x'), { message: { reason: 'smtp down' } });
    expect(serializeError(obj, opts)).toMatchObject({ name: 'Error', message: '{"reason":"smtp down"}' });
  });

  it('regression: called from plain JS without options, it gives the same answer', () => {
    const s = (serializeError as (e: unknown) => unknown)(unreadable(new Error('x')));
    expect(s).toMatchObject({ v: 1, name: 'Error', message: '[unserializable error]' });
    expect((serializeError as (e: unknown) => unknown)(new Error('plain'))).toMatchObject({ name: 'Error', message: 'plain' });
  });
});
