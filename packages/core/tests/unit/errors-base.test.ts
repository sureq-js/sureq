import { describe, expect, it } from 'vitest';
import { SureQError, isSureQError, errorCatalogue, registerError } from '../../src/errors/base.js';

describe('errors (base)', () => {
  it('errors: name equals class name and code is a string', () => {
    class Foo extends SureQError {
      override readonly code = 'FOO_X';
    }
    const e = new Foo('m', { cause: 'c' });
    expect(e.name).toBe('Foo');
    expect(typeof e.code).toBe('string');
    expect(e.cause).toBe('c');
  });

  it('errors: toJSON has name, code, message and no stack or cause payload', () => {
    const j = new SureQError('boom', { cause: new Error('secret'), details: { size: 3 } }).toJSON();
    expect(j).toEqual({ name: 'SureQError', code: 'SUREQ_ERROR', message: 'boom', details: { size: 3 } });
    expect(JSON.stringify(new SureQError('x'))).toBe('{"name":"SureQError","code":"SUREQ_ERROR","message":"x"}');
  });

  it('errors: isSureQError works across ESM and CJS copies', () => {
    const foreign = Object.assign(new Error('x'), { code: 'STORE_ERROR' });
    Object.setPrototypeOf(foreign, { [Symbol.for('sureq.error')]: true, __proto__: Error.prototype });
    expect(isSureQError(foreign)).toBe(true);
    expect(SureQError.isSureQError(foreign)).toBe(true);
    expect(isSureQError(new Error('x'))).toBe(false);
    expect(isSureQError({ code: 'X' })).toBe(false);
    expect(isSureQError(Object.assign(Object.create({ [Symbol.for('sureq.error')]: true }), { code: 5 }))).toBe(false);
  });

  it('errors: registerError adds a class to errorCatalogue and rejects a duplicate code', () => {
    class BarError extends SureQError {
      override readonly code = 'BAR_TEST';
    }
    registerError(BarError, 'BAR_TEST');
    expect(errorCatalogue['BAR_TEST']).toBe(BarError);
    class BazError extends SureQError {}
    expect(() => registerError(BazError, 'BAR_TEST')).toThrow(TypeError);
  });
});
