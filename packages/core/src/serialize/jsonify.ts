import type { JsonValue } from './error.js';

/**
 * What `T` becomes after a JSON round trip. Job data and results are stored as JSON, so handlers, `getJob`, events,
 * the filter, `onDuplicate` and schedules read them back as this type, not as the type that was added:
 *
 * - a `Date`, and any object with `toJSON()`, becomes what `toJSON()` returns (a `Date` becomes its ISO string);
 * - a `Map`, `Set`, `WeakMap`, `WeakSet` or `RegExp` becomes `{}`;
 * - function, symbol and `undefined` properties are dropped, so a property that may hold one of them becomes optional
 *   (`unknown` and `any` properties stay required), and a class instance keeps its fields and loses its methods;
 * - `undefined` at the root becomes `null`;
 * - a typed array becomes an object of its indexes (`Record<string, number>`), an `ArrayBuffer` or `DataView` `{}`;
 * - an `undefined`, function or symbol array item becomes `null`;
 * - `unknown` and `any` stay as they are, and JSON types (string, number, boolean, null, plain objects, arrays) keep
 *   their shape. `NaN` and `Infinity` are numbers to TypeScript but come back as `null`.
 *
 * @example
 * ```ts
 * const queue = new Queue<{ sendAt: Date }>('reminders');
 * queue.process(async (job) => {
 *   job.data.sendAt;              // string: read it with new Date(job.data.sendAt)
 * });
 * ```
 * @public
 */
export type Jsonify<T> =
  // Every conditional below tests `T` against a fixed type, never a type built from `T` (no `unknown extends T` or
  // `0 extends 1 & T` any-check). TypeScript relates two conditional types only when their `extends` types are
  // identical, so this keeps `Jsonify` covariant and `Job<MyData>` assignable to `Job`. `unknown` falls through to the
  // last branch, and `any` resolves to `any` because it takes every branch. A type that is already JSON (such as a
  // recursive JSON type) is returned as is first, so it never recurses.
  T extends JsonValue ? T :
  T extends string | number | boolean | null ? T :
  // only at the root: inside an object an undefined property is dropped, in an array it becomes null (below)
  T extends undefined ? null :
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  T extends symbol | bigint | Function ? never :
  T extends { toJSON(): infer J } ? Jsonify<J> :
  // {} (not Record<string, never>): reading a property of it, like tags.size, is a compile error
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  T extends DataView ? {} :
  // a typed array is written as an object of its indexes: { "0": 1, "1": 2 }; tested before ArrayBuffer, which a typed
  // array matches structurally in older TypeScript libs
  T extends ArrayBufferView ? Record<string, number> :
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  T extends ArrayBuffer ? {} :
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | WeakMap<object, unknown> | WeakSet<object> | RegExp ? {} :
  T extends readonly unknown[] ? {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    [K in keyof T]: T[K] extends infer V ? (V extends undefined | symbol | Function ? null : Jsonify<V>) : never;
  } :
  // A property is dropped when it can only hold undefined, a function or a symbol; optional when it may hold one of
  // them besides a JSON value (JSON leaves it out then); required otherwise, and always when it is unknown or any.
  T extends object ? ({
    [K in keyof T as K extends symbol ? never : unknown extends T[K] ? K :
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      [Exclude<T[K], undefined | symbol | Function>] extends [never] ? never : undefined extends T[K] ? never :
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      [Extract<T[K], symbol | Function>] extends [never] ? K : never]: Jsonify<T[K]>;
  } & {
    [K in keyof T as K extends symbol ? never : unknown extends T[K] ? never :
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      [Exclude<T[K], undefined | symbol | Function>] extends [never] ? never : undefined extends T[K] ? K :
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      [Extract<T[K], symbol | Function>] extends [never] ? never : K]?:
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      Jsonify<Exclude<T[K], undefined | symbol | Function>>;
  }) extends infer O ? { [K in keyof O]: O[K] } : never :
  T;
