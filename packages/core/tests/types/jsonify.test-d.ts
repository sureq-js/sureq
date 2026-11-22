/* eslint-disable @typescript-eslint/no-empty-object-type -- Jsonify maps Map and Set to {} */
import { expectTypeOf, test } from 'vitest';
import type { Jsonify } from '../../src/index.js';

test('jsonify: JSON primitives, unknown and any are unchanged', () => {
  expectTypeOf<Jsonify<string>>().toEqualTypeOf<string>();
  expectTypeOf<Jsonify<number>>().toEqualTypeOf<number>();
  expectTypeOf<Jsonify<boolean>>().toEqualTypeOf<boolean>();
  expectTypeOf<Jsonify<null>>().toEqualTypeOf<null>();
  expectTypeOf<Jsonify<'a' | 1>>().toEqualTypeOf<'a' | 1>();
  expectTypeOf<Jsonify<unknown>>().toEqualTypeOf<unknown>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expectTypeOf<Jsonify<any>>().toEqualTypeOf<any>();
});

test('jsonify: plain objects and interfaces keep their shape', () => {
  interface I { a: number; nested: { b: string } }
  expectTypeOf<Jsonify<{ ok: boolean }>>().toEqualTypeOf<{ ok: boolean }>();
  expectTypeOf<Jsonify<I>>().toEqualTypeOf<{ a: number; nested: { b: string } }>();
  expectTypeOf<Jsonify<Record<string, number>>>().toEqualTypeOf<Record<string, number>>();
  expectTypeOf<Jsonify<{ readonly r: string }>>().toEqualTypeOf<{ readonly r: string }>();
});

test('jsonify: a Date and other toJSON objects become what toJSON returns', () => {
  expectTypeOf<Jsonify<Date>>().toEqualTypeOf<string>();
  expectTypeOf<Jsonify<{ at: Date }>>().toEqualTypeOf<{ at: string }>();
  expectTypeOf<Jsonify<{ toJSON(): { v: number } }>>().toEqualTypeOf<{ v: number }>();
  expectTypeOf<Jsonify<{ dt: { toJSON(): string; plus(n: number): unknown } }>>().toEqualTypeOf<{ dt: string }>();
});

test('jsonify: Map, Set and RegExp become {}', () => {
  expectTypeOf<Jsonify<Set<string>>>().toEqualTypeOf<{}>();
  expectTypeOf<Jsonify<Map<string, number>>>().toEqualTypeOf<{}>();
  expectTypeOf<Jsonify<RegExp>>().toEqualTypeOf<{}>();
  expectTypeOf<Jsonify<{ tags: Set<string> }>>().toEqualTypeOf<{ tags: {} }>();
});

test('jsonify: function and symbol properties are dropped; methods of a class instance too', () => {
  expectTypeOf<Jsonify<{ a: number; f: () => void; s: symbol }>>().toEqualTypeOf<{ a: number }>();
  class Money {
    constructor(readonly cents: number) {}
    format(): string { return String(this.cents); }
  }
  expectTypeOf<Jsonify<Money>>().toEqualTypeOf<{ readonly cents: number }>();
});

test('jsonify: undefined makes a property optional; optional stays optional', () => {
  expectTypeOf<Jsonify<{ a?: string }>>().toEqualTypeOf<{ a?: string }>();
  expectTypeOf<Jsonify<{ a: string | undefined; b: number }>>().toEqualTypeOf<{ a?: string; b: number }>();
  expectTypeOf<Jsonify<{ a?: Date }>>().toEqualTypeOf<{ a?: string }>();
});

test('jsonify: arrays and tuples', () => {
  expectTypeOf<Jsonify<(number | undefined)[]>>().toEqualTypeOf<(number | null)[]>();
  expectTypeOf<Jsonify<Date[]>>().toEqualTypeOf<string[]>();
  expectTypeOf<Jsonify<readonly Date[]>>().toEqualTypeOf<readonly string[]>();
  expectTypeOf<Jsonify<[Date, number]>>().toEqualTypeOf<[string, number]>();
});

test('jsonify: nested values and idempotence', () => {
  type In = { o: { d: Date; list: { s: Set<number> }[] } };
  expectTypeOf<Jsonify<In>>().toEqualTypeOf<{ o: { d: string; list: { s: {} }[] } }>();
  expectTypeOf<Jsonify<Jsonify<{ at: Date }>>>().toEqualTypeOf<Jsonify<{ at: Date }>>();
});

test('jsonify: a recursive JSON type is unchanged (no excessive-depth error)', () => {
  type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
  type JsonObject = { [k: string]: Json };
  expectTypeOf<Jsonify<Json>>().toEqualTypeOf<Json>();
  expectTypeOf<Jsonify<{ id: string; payload: JsonObject }>>().toEqualTypeOf<{ id: string; payload: JsonObject }>();
  expectTypeOf<Jsonify<{ at: Date; payload: Json }>>().toEqualTypeOf<{ at: string; payload: Json }>();
});

test('jsonify: unknown and any properties stay required', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expectTypeOf<Jsonify<{ a: unknown; b: any }>>().toEqualTypeOf<{ a: unknown; b: any }>();
});

test('jsonify: undefined at the root is stored as null', () => {
  expectTypeOf<Jsonify<undefined>>().toEqualTypeOf<null>();
  expectTypeOf<Jsonify<string | undefined>>().toEqualTypeOf<string | null>();
  expectTypeOf<Jsonify<{ a: string | undefined }>>().toEqualTypeOf<{ a?: string }>();
});

test('jsonify: a property that may hold a function becomes optional', () => {
  expectTypeOf<Jsonify<{ a: string | (() => void); b: number }>>().toEqualTypeOf<{ a?: string; b: number }>();
  expectTypeOf<Jsonify<{ s: symbol | number }>>().toEqualTypeOf<{ s?: number }>();
});

test('jsonify: typed arrays become index objects; ArrayBuffer and DataView {}', () => {
  expectTypeOf<Jsonify<Uint8Array>>().toEqualTypeOf<Record<string, number>>();
  expectTypeOf<Jsonify<{ f: Float64Array }>>().toEqualTypeOf<{ f: Record<string, number> }>();
  expectTypeOf<Jsonify<ArrayBuffer>>().toEqualTypeOf<{}>();
  expectTypeOf<Jsonify<DataView>>().toEqualTypeOf<{}>();
});
