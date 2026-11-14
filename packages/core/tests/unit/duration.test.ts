import { describe, expect, it } from 'vitest';
import { parseDuration, tryParseDuration } from '../../src/util/duration.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';

describe('duration', () => {
  it('duration: parses numbers and unit strings to integer ms', () => {
    expect(parseDuration(250, 'x')).toBe(250);
    for (const [s, ms] of [['250ms', 250], ['30s', 30_000], ['5m', 300_000], ['2h', 7_200_000], ['1d', 86_400_000], ['1.5s', 1500], ['0s', 0]] as const) {
      expect(parseDuration(s, 'x')).toBe(ms);
    }
  });

  it('duration: rejects fractional ms, negatives, NaN and malformed strings', () => {
    for (const bad of ['1.5ms', 0.5, '-5s', -1, NaN, Infinity, '5 s', '5w', '', 'abc', '0.0005s'] as const) {
      expect(() => parseDuration(bad as never, 'delay'), String(bad)).toThrow(InvalidOptionError);
    }
    expect(tryParseDuration('1.5ms')).toEqual({ ok: false, code: 'invalid_value' });
    expect(tryParseDuration(-1)).toEqual({ ok: false, code: 'out_of_range' });
    expect(tryParseDuration({})).toEqual({ ok: false, code: 'invalid_type' });
  });

  it('duration: error names the path', () => {
    expect.assertions(2);
    try {
      parseDuration('x' as never, 'backoff.delay');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidOptionError);
      expect((e as InvalidOptionError).issues[0]?.path).toBe('backoff.delay');
    }
  });
});
