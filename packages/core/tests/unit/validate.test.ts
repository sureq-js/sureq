import { describe, expect, it, vi } from 'vitest';
import { validate, closest, formatIssues, type Schema } from '../../src/util/validate.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';

const catchErr = (fn: () => unknown): InvalidOptionError => {
  try {
    fn();
  } catch (e) {
    return e as InvalidOptionError;
  }
  throw new TypeError('expected a throw');
};

const schema: Schema<{ concurrency: number; backoff: { jitter: string } }> = {
  fields: {
    concurrency: { kind: 'integer', min: 1, default: 1 },
    backoff: { kind: 'object', schema: { fields: { jitter: { kind: 'enum', values: ['none', 'full'], default: 'full' } } } },
  },
};

describe('config', () => {
  it('config: unknown option throws InvalidOptionError naming the option and the closest valid one', () => {
    const e = catchErr(() => validate('Queue "emails"', { concurency: 10 }, schema));
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect(e.issues).toEqual([
      { path: 'concurency', code: 'unknown_option', message: 'unknown option (did you mean "concurrency"?)', suggestion: 'concurrency' },
    ]);
  });

  it('config: all problems are reported in one error, sorted by path', () => {
    const e = catchErr(() => validate('Q', { concurrency: 0, backoff: { jiter: 'x' }, zzz: 1 }, schema));
    expect(e.issues.map((i) => i.path)).toEqual(['backoff.jiter', 'concurrency', 'zzz']);
  });

  it('config: message format matches the documented layout', () => {
    const e = catchErr(() => validate('Queue "emails"', { concurrency: 0, backoff: { jiter: 'x' } }, schema));
    expect(e.message).toBe(
      'Invalid SureQ configuration for Queue "emails" (2 problems):\n' +
        '  - backoff.jiter: unknown option (did you mean "jitter"?)\n' +
        '  - concurrency: expected integer >= 1, received 0',
    );
    expect(formatIssues('X', [{ path: 'a', code: 'invalid_value', message: 'bad' }])).toBe(
      'Invalid SureQ configuration for X (1 problem):\n  - a: bad',
    );
  });

  it('config: legacy option names give a specific message', () => {
    const s: Schema<{ maxAttempts: number }> = { fields: { maxAttempts: { kind: 'integer', min: 1 } }, renamed: { attempts: 'maxAttempts' } };
    const e = catchErr(() => validate('Q', { attempts: 3 }, s));
    expect(e.issues).toEqual([{ path: 'attempts', code: 'unknown_option', message: 'unknown option (use "maxAttempts")', suggestion: 'maxAttempts' }]);
  });

  it('config: long strings, objects and secret-looking keys are not echoed', () => {
    const s: Schema<{ password: number; note: number; cfg: number; n: string }> = {
      fields: { password: { kind: 'integer' }, note: { kind: 'integer' }, cfg: { kind: 'integer' }, n: { kind: 'string' } },
    };
    const e = catchErr(() => validate('X', { password: 'hunter2', note: 'a'.repeat(65), cfg: {}, n: 5 }, s));
    const received = Object.fromEntries(e.issues.map((i) => [i.path, i.received]));
    expect(received).toEqual({ password: undefined, note: 'string', cfg: 'object', n: '5' });
    expect(e.message).not.toContain('hunter2');
    expect(e.message).not.toContain('aaaaaaaa');
  });

  it('config: defaults are applied once and the resolved options are frozen', () => {
    const r = validate('Q', {}, schema);
    expect(r).toEqual({ concurrency: 1, backoff: { jitter: 'full' } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.backoff)).toBe(true);
    expect(validate('Q', undefined, schema)).toEqual({ concurrency: 1, backoff: { jitter: 'full' } });
  });

  it('config: user-supplied objects passed through unknown or object rules are never frozen', () => {
    const s: Schema<{ logger: unknown; extra: Record<string, unknown> }> = { fields: { logger: { kind: 'unknown' }, extra: { kind: 'object' } } };
    const logger = { info() {} };
    const extra = { a: { b: 1 } };
    const r = validate('Q', { logger, extra }, s);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(logger)).toBe(false);
    expect(Object.isFrozen(extra)).toBe(false);
    expect(Object.isFrozen(extra.a)).toBe(false);
  });

  it('config: a non-object input is one invalid_type issue at the root', () => {
    expect(catchErr(() => validate('Q', 42, schema)).issues).toEqual([
      expect.objectContaining({ path: '', code: 'invalid_type', received: '42' }),
    ]);
  });

  it('config: validation touches neither store nor clock', () => {
    const now = vi.spyOn(Date, 'now');
    validate('Q', {}, schema);
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('config: duration rule converts strings to integer ms and reports invalid values', () => {
    const s: Schema<{ delay: number }> = { fields: { delay: { kind: 'duration' } } };
    expect(validate('Q', { delay: '5s' }, s)).toEqual({ delay: 5000 });
    expect(catchErr(() => validate('Q', { delay: '1.5ms' }, s)).issues[0]).toMatchObject({ path: 'delay', code: 'invalid_value' });
  });

  it('config: a function where a number is expected is invalid_type with received function', () => {
    expect(catchErr(() => validate('Q', { concurrency: () => 1 }, schema)).issues[0]).toMatchObject({
      path: 'concurrency', code: 'invalid_type', received: 'function',
    });
  });

  it('config: check hook can add conflict issues', () => {
    const s: Schema<{ a?: number; b?: number }> = {
      fields: { a: { kind: 'integer' }, b: { kind: 'integer' } },
      check: (v, add) => {
        if (v.a !== undefined && v.b !== undefined) add({ path: 'a', code: 'conflict', message: 'a and b cannot both be set' });
      },
    };
    expect(catchErr(() => validate('Q', { a: 1, b: 2 }, s)).issues).toEqual([{ path: 'a', code: 'conflict', message: 'a and b cannot both be set' }]);
  });

  it('config: required options report missing_option', () => {
    const s: Schema<{ name: string }> = { fields: { name: { kind: 'string', required: true } } };
    expect(catchErr(() => validate('Q', {}, s)).issues[0]).toMatchObject({ path: 'name', code: 'missing_option' });
  });

  it('config: closest picks the nearest name within distance 2, ties alphabetical', () => {
    expect(closest('concurency', ['concurrency', 'backoff'])).toBe('concurrency');
    expect(closest('xyzzy', ['concurrency'])).toBeUndefined();
    expect(closest('ab', ['ac', 'aa'])).toBe('aa');
  });
});
