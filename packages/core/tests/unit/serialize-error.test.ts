import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeError, deserializeError, errorOptionsSchema } from '../../src/serialize/error.js';
import { validate } from '../../src/util/validate.js';
import { InvalidOptionError, PayloadTooLargeError } from '../../src/errors/catalog.js';
import { isSureQError } from '../../src/errors/base.js';

const o = { maxErrorBytes: 16_384, storeStacks: true };

describe('errser', () => {
  it('errser: keeps name, message, stack and code', () => {
    const s = serializeError(Object.assign(new TypeError('bad'), { code: 'E_X' }), o);
    expect(s).toMatchObject({ v: 1, name: 'TypeError', message: 'bad', code: 'E_X' });
    expect(typeof s.stack).toBe('string');
    expect(serializeError(Object.assign(new Error('x'), { code: 503 }), o).code).toBe(503);
  });

  it('errser: storeStacks false stores no stack, including in the cause chain', () => {
    const s = serializeError(new Error('a', { cause: new Error('b') }), { ...o, storeStacks: false });
    expect(JSON.stringify(s)).not.toContain('"stack"');
  });

  it('errser: keeps cause recursively', () => {
    expect(serializeError(new Error('a', { cause: new Error('b') }), o).cause?.message).toBe('b');
    expect(serializeError(new Error('a', { cause: 'text' }), o).cause?.name).toBe('NonErrorThrown');
  });

  it('errser: keeps custom own properties in props', () => {
    expect(serializeError(Object.assign(new Error('x'), { status: 429, retryAfter: 5 }), o).props).toEqual({ status: 429, retryAfter: 5 });
  });

  it('errser: ignores prototype and non-enumerable properties', () => {
    class MyErr extends Error {
      get computed(): number {
        return 1;
      }
    }
    const e = new MyErr('x');
    Object.defineProperty(e, 'hidden', { value: 1, enumerable: false });
    expect(serializeError(e, o).props).toBeUndefined();
  });

  it('errser: AggregateError keeps errors', () => {
    const s = serializeError(new AggregateError([new Error('one'), new Error('two')], 'many'), o);
    expect(s.errors?.map((e) => e.message)).toEqual(['one', 'two']);
  });

  it('errser: non-Error throws are normalised (string, number, object, null, undefined)', () => {
    expect(serializeError('text', o)).toMatchObject({ name: 'NonErrorThrown', message: 'text' });
    expect(serializeError(42, o)).toMatchObject({ name: 'NonErrorThrown', message: '42', props: { value: 42 } });
    const obj = serializeError({ code: 1 }, o);
    expect(obj.name).toBe('NonErrorThrown');
    expect(obj.message.length).toBeLessThanOrEqual(200);
    expect(obj.props).toEqual({ value: { code: 1 } });
    expect(serializeError(null, o)).toMatchObject({ name: 'NonErrorThrown', message: 'null' });
    expect(serializeError(undefined, o)).toMatchObject({ name: 'NonErrorThrown', message: 'undefined' });
  });

  it('errser: bigint, Date, Buffer, NaN, functions and symbols convert per table', () => {
    const e = Object.assign(new Error('x'), {
      a: 10n, d: new Date(0), b: Buffer.alloc(3), n: NaN, i: -Infinity,
      f() {}, s: Symbol('x'), u: undefined, bad: new Date(NaN),
    });
    expect(serializeError(e, o).props).toEqual({
      a: '10', d: '1970-01-01T00:00:00.000Z', b: '[Buffer 3 bytes]', n: 'NaN', i: '-Infinity', bad: 'Invalid Date',
    });
  });

  it('errser: circular props become [Circular]', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;
    expect(serializeError(Object.assign(new Error('x'), { loop }), o).props).toEqual({ loop: { name: 'loop', self: '[Circular]' } });
  });

  it('errser: circular cause terminates', () => {
    const e = new Error('me');
    (e as { cause?: unknown }).cause = e;
    expect(serializeError(e, o).cause).toEqual({ v: 1, name: 'Circular', message: '[Circular cause]' });
  });

  it('errser: depth 3 for props, depth 5 for cause', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: {} } } } } };
    expect(serializeError(Object.assign(new Error('x'), { deep }), o).props).toEqual({ deep: { l1: { l2: { l3: '[Object]' } } } });
    let chain: Error = new Error('e50');
    for (let i = 49; i >= 1; i--) chain = new Error(`e${i}`, { cause: chain });
    const s = serializeError(chain, o);
    let node = s;
    for (let d = 1; d <= 5; d++) node = node.cause!;
    expect(node.name).toBe('Truncated');
    expect(s.truncated).toBe(true);
  });

  it('errser: throwing getter and hostile proxy never throw', () => {
    const e = new Error('g');
    Object.defineProperty(e, 'x', { enumerable: true, get() { throw 1; } });
    expect(serializeError(e, o).props?.['x']).toBeUndefined();
    const hostile = new Proxy(new Error('p'), {
      get() { throw new TypeError('no'); },
      ownKeys() { throw new TypeError('no'); },
    });
    const s = serializeError(hostile, o);
    expect(typeof s.name).toBe('string');
    expect(typeof s.message).toBe('string');
  });

  it('errser: output is JSON round-trippable', () => {
    const s = serializeError(Object.assign(new Error('a', { cause: new Error('b') }), { status: 1 }), o);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('errser: deserialize restores name, message, stack, cause, props', () => {
    const s = serializeError(Object.assign(new RangeError('a', { cause: new Error('b') }), { status: 418 }), o);
    const r = deserializeError(s);
    expect(r).toBeInstanceOf(Error);
    expect([r.name, r.message, r.stack]).toEqual(['RangeError', 'a', s.stack]);
    expect((r.cause as Error).message).toBe('b');
    expect((r as unknown as { status: number }).status).toBe(418);
    expect(Object.getPrototypeOf(r)).toBe(Error.prototype); // a plain Error, not a TypeError
    const agg = deserializeError(serializeError(new AggregateError([new Error('x')], 'm'), o));
    expect(agg).toBeInstanceOf(AggregateError);
    expect(deserializeError({ v: 2, name: 'Future', message: 'later' } as never).message).toBe('later');
  });

  it('errser: deserialize does not revive SureQ catalogue classes', () => {
    const r = deserializeError(serializeError(new PayloadTooLargeError({ size: 2, limit: 1, queue: 'q' }), o));
    expect(isSureQError(r)).toBe(false);
    expect((r as unknown as { code: string }).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('errser: serialization is deterministic', () => {
    const e = Object.assign(new Error('a', { cause: new Error('b') }), { z: 1, a: 2 });
    expect(serializeError(e, o)).toEqual(serializeError(e, o));
    expect(JSON.stringify(serializeError(e, o))).toBe(JSON.stringify(serializeError(e, o)));
  });

  it('errser: maxErrorBytes below 512 throws InvalidOptionError', () => {
    expect(() => validate('Queue "q"', { maxErrorBytes: 511 }, errorOptionsSchema)).toThrow(InvalidOptionError);
    try {
      validate('Queue "q"', { maxErrorBytes: 511 }, errorOptionsSchema);
    } catch (e) {
      expect((e as InvalidOptionError).issues[0]?.path).toBe('maxErrorBytes');
    }
    expect(validate('Queue "q"', {}, errorOptionsSchema)).toEqual({ maxErrorBytes: 16_384, storeStacks: true });
  });

  const bytes = (s: unknown): number => Buffer.byteLength(JSON.stringify(s));

  it('errser: output never exceeds maxErrorBytes and sets truncated', () => {
    const bigProp = Object.assign(new Error('x'), { body: 'b'.repeat(5_000_000) });
    // 1000 props of ~30 bytes each (> 16 KiB in total, so every budget below forces truncation)
    const manyProps = Object.assign(new Error('x'), Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`p${i}`, 'v'.repeat(20)])));
    const bigMessage = new Error('m'.repeat(100_000));
    let chain: Error = new Error('x'.repeat(20_000));
    for (let i = 0; i < 49; i++) chain = new Error('y'.repeat(20_000), { cause: chain });
    for (const max of [512, 2048, 16_384]) {
      for (const e of [bigProp, manyProps, bigMessage, chain]) {
        const s = serializeError(e, { maxErrorBytes: max, storeStacks: true });
        expect(bytes(s), `${max}`).toBeLessThanOrEqual(max);
        expect(s.truncated).toBe(true);
      }
    }
    expect(serializeError(new Error('small'), o).truncated).toBeUndefined();
  });

  it('errser: a 1 MB name or code is capped at 128 chars and the output still fits maxErrorBytes', () => {
    const e = Object.assign(new Error('m'), { name: 'N'.repeat(1e6), code: 'C'.repeat(1e6) });
    Object.assign(e, { ['k'.repeat(100)]: 1 });
    const s = serializeError(e, { maxErrorBytes: 512, storeStacks: true });
    expect(s.name.length).toBeLessThanOrEqual(128);
    expect(String(s.code).length).toBeLessThanOrEqual(128);
    expect(bytes(s)).toBeLessThanOrEqual(512);
    const s2 = serializeError(Object.assign(new Error('m'), { ['k'.repeat(100)]: 1 }), o);
    expect(Object.keys(s2.props!)[0]).toBe('k'.repeat(63) + '…');
  });

  it('errser: truncation order matches 6.4', () => {
    // (a) 40 props: only 32 remain, strings capped at 1024, stack untouched
    const a = Object.assign(new Error('a'), Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, 's'.repeat(2000)])));
    a.stack = 'S'.repeat(100);
    const sa = serializeError(a, { maxErrorBytes: 40_000, storeStacks: true });
    expect(Object.keys(sa.props!).length).toBe(32);
    expect(Object.values(sa.props!).every((v) => typeof v === 'string' && v.length <= 1024)).toBe(true);
    expect(sa.stack).toBe('S'.repeat(100));
    // (b) 20 KB stack: cut to 8192, props intact
    const b = Object.assign(new Error('b'), { status: 1 });
    b.stack = 'S'.repeat(20_000);
    const sb = serializeError(b, { maxErrorBytes: 16_384, storeStacks: true });
    expect(sb.stack?.length).toBe(8192);
    expect(sb.props).toEqual({ status: 1 });
    // (c) props are removed before the message is cut
    const c = Object.assign(new Error('m'.repeat(3000)), { p: 'v'.repeat(500) });
    c.stack = undefined as never;
    const sc = serializeError(c, { maxErrorBytes: 2_400, storeStacks: true });
    expect(sc.props).toBeUndefined();
    expect(sc.message.length).toBe(2048);
    // (d) at 512: name kept, no stack, no cause, cut message
    const d = new Error('m'.repeat(3000), { cause: new Error('c'.repeat(3000)) });
    const sd = serializeError(d, { maxErrorBytes: 512, storeStacks: true });
    expect(sd.name).toBe('Error');
    expect(sd.stack).toBeUndefined();
    expect(sd.cause).toBeUndefined();
    expect(sd.message.length).toBeLessThan(512);
    expect(bytes(sd)).toBeLessThanOrEqual(512);
  });

  it('errser: cause chain stacks count against the single maxErrorBytes budget', () => {
    let e: Error = new Error('e4');
    e.stack = 's'.repeat(8000);
    for (let i = 3; i >= 0; i--) {
      e = new Error(`e${i}`, { cause: e });
      e.stack = 's'.repeat(8000);
    }
    const s = serializeError(e, { maxErrorBytes: 16_384, storeStacks: true });
    expect(bytes(s)).toBeLessThanOrEqual(16_384);
    expect(s.message).toBe('e0');
    expect(s.cause?.cause?.cause?.stack).toBeUndefined();
  });

  it('errser: v1 shape matches the stored-format fixture', () => {
    const e = Object.assign(new Error('fx', { cause: 'why' }), { status: 500 });
    e.stack = 'Error: fx\n    at fixture';
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/serialized-error-v1.json'), 'utf8'));
    expect(serializeError(e, o)).toEqual(fixture);
  });

  it('errser: a message of multi-byte characters is shortened to fit maxErrorBytes, not emptied', () => {
    const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    const e = new Error('é'.repeat(3000));
    const out = serializeError(e, { maxErrorBytes: 512, storeStacks: false });
    expect(bytesOf(out)).toBeLessThanOrEqual(512);
    expect(out.truncated).toBe(true);
    // 'é' is 2 bytes: well over 150 of them fit beside the other fields
    expect([...out.message].length).toBeGreaterThan(150);
    expect(out.message).toMatch(/^é+$/);
  });

  it('errser: a long non-ASCII name and code are shortened so the result stays within maxErrorBytes', () => {
    const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    const e = Object.assign(new Error('x'), { name: '😀'.repeat(128), code: '"\u0000'.repeat(64) });
    const out = serializeError(e, { maxErrorBytes: 512, storeStacks: false });
    expect(bytesOf(out)).toBeLessThanOrEqual(512);
    expect(out.truncated).toBe(true);
    expect(out.name.length).toBeGreaterThan(0);
  });
});
