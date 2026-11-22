import { FilterError, JobRejectedError } from '../errors/catalog.js';
import type { Jsonify } from '../serialize/jsonify.js';
import type { QueueEvents } from '../events/types.js';
import type { Logger } from '../logger/logger.js';
import { deepFreeze } from '../util/freeze.js';
import { serializeValue } from '../serialize/value.js';
import type { AddOptions } from './options.js';
import { platform, type Timer } from '../platform/index.js';

/** `true` accepts; `false`, a string or `{ reject }` rejects. Anything else is a FilterError. */
export type FilterVerdict = true | false | string | { reject: string; code?: string; details?: unknown };

/** What the filter is told about the add it judges. */
export interface FilterContext<D = unknown> {
  /** The queue name. */
  readonly queue: string;
  /** The job name, or null for an unnamed job. */
  readonly name: string | null;
  /** The caller's id (or the id its function computed); `null` when core generates it. */
  readonly id: string | null;
  /** The add's options over the queue's `defaultJobOptions`. */
  readonly opts: Readonly<AddOptions<D>>;
  /** What is being checked: an `'add'`, a `'replace'`, a `'merge'`, or a `'schedule'` firing. */
  readonly operation: 'add' | 'replace' | 'merge' | 'schedule';
}

/** Judges a job before it is stored; sees a frozen copy of the data as it will be stored (see {@link Jsonify}). */
export type FilterFn<D = unknown> = (data: Jsonify<D>, ctx: FilterContext<D>) => FilterVerdict | Promise<FilterVerdict>;

export const MAX_REASON_CHARS = 1000;
/** Filter calls in flight at once for one `addBulk`. */
export const BULK_FILTER_CONCURRENCY = 16;

type Rejection = { reason: string; code?: string | undefined; details?: unknown };

/** The rejection a verdict stands for, `null` for an accept, `undefined` for a value that is no verdict. */
function rejection(v: unknown): Rejection | null | undefined {
  if (v === true) return null;
  if (v === false) return { reason: '' };
  if (typeof v === 'string') return { reason: v };
  if (typeof v !== 'object' || v === null) return undefined;
  const { reject, code, details } = v as { reject?: unknown; code?: unknown; details?: unknown };
  if (typeof reject !== 'string' || (code !== undefined && typeof code !== 'string')) return undefined;
  return { reason: reject, code, details };
}

const TIMED_OUT = Symbol('timed out');

/** Job data serialized once, by the filter, and reused when the job is built so `toJSON` runs once per add. */
export type Serialized = { json: string; bytes: number };

/**
 * Resolves when accepted (or no filter), with the data serialized as the filter saw it (`undefined` when there is no
 * filter or the data is not serializable); else emits `rejected`, logs, and throws JobRejectedError or FilterError.
 */
export function makeFilter(setup: {
  fn: FilterFn | undefined;
  timeoutMs: number;
  queue: string;
  logger: Logger;
  /** `name` is the rejected add's job name. */
  emit(e: QueueEvents['rejected'], name: string | null): void;
}): (data: unknown, ctx: Omit<FilterContext, 'queue'>) => Promise<Serialized | undefined> {
  const { fn, timeoutMs, queue, logger, emit } = setup;
  if (!fn) return () => Promise.resolve(undefined);
  return async (data, ctx) => {
    let view = data;
    let stored: Serialized | undefined;
    try {
      // the data as stored, so the filter sees what the merge and the handler see (a Date as its ISO string)
      stored = serializeValue(data);
      view = deepFreeze(JSON.parse(stored.json) as unknown);
    } catch {
      // not serializable (a cycle, a bigint): a frozen copy where structuredClone can make one, else as is;
      // serialization rejects it right after unless the filter does
      try {
        view = deepFreeze(structuredClone(data));
      } catch {
        // ponytail: not cloneable either (a function): passed as is
      }
    }
    let timer: Timer | undefined;
    let verdict: unknown;
    try {
      verdict = await Promise.race([
        Promise.resolve().then(() => fn(view as Readonly<unknown>, Object.freeze({ queue, ...ctx }))),
        new Promise<never>((_, reject) => (timer = platform.setTimer(() => reject(TIMED_OUT), timeoutMs, { ref: true }))),
      ]);
    } catch (e) {
      throw e === TIMED_OUT ? new FilterError({ timedOut: true }) : new FilterError({ timedOut: false, cause: e });
    } finally {
      timer?.cancel();
    }
    const r = rejection(verdict);
    if (r === null) return stored;
    if (r === undefined) {
      const got = verdict === null ? 'null' : typeof verdict;
      throw new FilterError({ timedOut: false, cause: new TypeError(`the filter returned ${got}, not a verdict`) });
    }
    const reason = (r.reason || 'filtered').slice(0, MAX_REASON_CHARS);
    const error = new JobRejectedError({
      reason,
      ...(r.code !== undefined && { reasonCode: r.code }),
      ...(r.details !== undefined && { details: r.details }),
      operation: ctx.operation,
      jobId: ctx.id,
    });
    emit({ id: ctx.id, reason, ...(r.code !== undefined && { reasonCode: r.code }), operation: ctx.operation }, ctx.name);
    logger.debug('add rejected by the filter', { queue, jobId: ctx.id, reason, ...(r.code !== undefined && { reasonCode: r.code }) });
    throw error;
  };
}

/** `fn` over every item, at most `limit` at once; results by input order. */
export async function mapLimit<T, U>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}
