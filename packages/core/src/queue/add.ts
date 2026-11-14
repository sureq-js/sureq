import { InvalidMergeResultError, InvalidOptionError, MergeConflictError, PayloadTooLargeError, type ConfigIssue } from '../errors/catalog.js';
import type { Job } from '../job/job.js';
import { serializeValue } from '../serialize/value.js';
import type { StoreClient } from '../store/client.js';
import type { JobRecord, JobState, NewJob, Scope } from '../store/contract.js';
import { deepFreeze } from '../util/freeze.js';
import type { ResolvedJobOptions } from './options.js';

/** A user id may not look like the key a reused id's old record moves to (`id#7`, `id#-3`). */
export const RESERVED_ID_SUFFIX = /#-?\d+$/;
/** Ids and keys are capped at this many UTF-8 bytes (or the store's own smaller limit). */
export const MAX_KEY_BYTES = 255;

const encoder = new TextEncoder();
const utf8Bytes = (s: string): number => encoder.encode(s).length;

function keyIssue(value: unknown, path: string, maxBytes: number): ConfigIssue | undefined {
  if (typeof value !== 'string') return { path, code: 'invalid_type', message: 'expected a string' };
  if (value === '') return { path, code: 'invalid_value', message: 'expected a non-empty string' };
  if (utf8Bytes(value) > maxBytes) return { path, code: 'out_of_range', message: `expected at most ${maxBytes} UTF-8 bytes` };
  return undefined;
}

/** A non-empty string of at most `maxBytes` UTF-8 bytes, else InvalidOptionError at `path`. */
export function validateKey(value: unknown, path: 'singletonKey' | 'idempotencyKey', maxBytes: number): string {
  const issue = keyIssue(value, path, maxBytes);
  if (issue) throw new InvalidOptionError('add', [issue]);
  return value as string;
}

/**
 * The job id from a string or a synchronous function of the data (called once, with the data as given);
 * `undefined` when there is no spec. Any bad result, or a throw (kept as `cause`), is InvalidOptionError.
 */
export function resolveId(spec: string | ((data: unknown) => string) | undefined, data: unknown, maxIdBytes: number): string | undefined {
  if (spec === undefined) return undefined;
  let id: unknown = spec;
  if (typeof spec === 'function') {
    try {
      id = spec(data);
    } catch (cause) {
      throw new InvalidOptionError('add', [{ path: 'id', code: 'invalid_value', message: 'the id function threw' }], { cause });
    }
  }
  const issue = keyIssue(id, 'id', maxIdBytes) ??
    (RESERVED_ID_SUFFIX.test(id as string) ? { path: 'id', code: 'invalid_value' as const, message: 'must not end in "#" and digits' } : undefined);
  if (issue) throw new InvalidOptionError('add', [issue]);
  return id as string;
}

const DEFAULTABLE = ['priority', 'maxAttempts', 'backoff'] as const;

/**
 * The job sent to the store. A field the caller did not set is left out (or listed in `defaulted` when the
 * insert needs it), so `replace` keeps the stored value; no key is ever `undefined`. A merge function is
 * core's, so the store sees `'ignore'`.
 */
export function buildNewJob(id: string, data: string, policy: ResolvedJobOptions, fifo: boolean, formatVersion: number): NewJob {
  const set = policy.callerSet;
  const defaulted = DEFAULTABLE.filter((k) => !set.has(k));
  return {
    id,
    data,
    formatVersion,
    priority: policy.priority,
    maxAttempts: policy.maxAttempts,
    backoff: JSON.stringify(policy.backoff),
    ...(defaulted.length > 0 && { defaulted }),
    ...(set.has('name') && { name: policy.name }),
    ...(set.has('delay') && { delayMs: policy.delayMs }),
    // front of its level only means something under fifo; the claim order is sent with each claim
    ...(policy.first && fifo && { first: true }),
    ...(policy.singletonKey !== undefined && { singletonKey: policy.singletonKey }),
    ...(policy.idempotencyKey !== undefined && { idempotencyKey: policy.idempotencyKey }),
    ...(policy.timeout !== null && { timeout: policy.timeout }),
    ...(policy.keep !== null && { keep: policy.keep }),
    onDuplicate: typeof policy.onDuplicate === 'function' ? 'ignore' : policy.onDuplicate,
    uniqueWhile: policy.uniqueWhile,
  };
}

/** Merge attempts before an add gives up with MergeConflictError. */
export const MERGE_TRIES = 10;

export type MergeFn = (existing: Readonly<Job>, incoming: unknown) => unknown;

export interface MergeContext {
  client: StoreClient;
  scope: Scope;
  queue: string;
  id: string;
  mergeFn: MergeFn;
  /** The add's data as stored (serialized, then parsed back), frozen. */
  incoming: unknown;
  toJob(rec: JobRecord): Job;
  maxPayloadBytes: number;
  /** Tries left, shared by every round of one add. */
  budget: { left: number };
  /** A result computed earlier for the job at this `rev` holding `base`; reused instead of calling the function again. */
  computed?: ComputedMerge | undefined;
  /** The queue's filter on the merged value; throws to refuse it. */
  check?: (merged: unknown) => Promise<void>;
}

export interface ComputedMerge {
  rev: number;
  base: JobRecord['data'];
  json: string;
}

export type MergeResult =
  | { kind: 'merged'; job: JobRecord; existingState: 'waiting' | 'delayed' }
  | { kind: 'ignored'; job: JobRecord; existingState: JobState }
  | { kind: 'readd' };

const isFinished = (s: JobState): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';

/** Run the merge function on `rec`, then the filter on its result; the serialized result, or an error before anything is written. */
export async function computeMerge(ctx: Omit<MergeContext, 'client' | 'scope' | 'budget'>, rec: JobRecord): Promise<string> {
  const c = ctx.computed;
  if (c && c.rev === rec.rev && c.base === rec.data) return c.json;
  const merged = ctx.mergeFn(deepFreeze(ctx.toJob(rec)), ctx.incoming);
  if (merged === undefined || typeof (merged as { then?: unknown } | null)?.then === 'function') throw new InvalidMergeResultError({ jobId: ctx.id });
  await ctx.check?.(merged);
  let out: { json: string; bytes: number };
  try {
    out = serializeValue(merged);
  } catch {
    throw new InvalidMergeResultError({ jobId: ctx.id });
  }
  if (out.bytes > ctx.maxPayloadBytes) throw new PayloadTooLargeError({ size: out.bytes, limit: ctx.maxPayloadBytes, queue: ctx.queue });
  return out.json;
}

/**
 * Merge into the job holding the id: read, compute, write guarded by `rev`, and again on a conflict.
 * A job that turned active (or finished but keeps its id) is left alone (`ignored`); one that is gone or
 * finished under `'pending'` frees the id (`readd`). Out of tries: MergeConflictError.
 */
export async function mergeInto(ctx: MergeContext, start: JobRecord): Promise<MergeResult> {
  let rec: JobRecord | null = start;
  for (;;) {
    if (rec === null || (isFinished(rec.state) && rec.uniqueWhile === 'pending')) return { kind: 'readd' };
    if (rec.state !== 'waiting' && rec.state !== 'delayed') return { kind: 'ignored', job: rec, existingState: rec.state };
    if (ctx.budget.left-- <= 0) throw new MergeConflictError({ jobId: ctx.id });
    const data = await computeMerge(ctx, rec);
    const res = await ctx.client.call('update', ctx.scope, { id: rec.id, expectedRev: rec.rev, patch: { data } });
    if (res.ok) return { kind: 'merged', job: res.job, existingState: rec.state };
    rec = await ctx.client.call('get', ctx.scope, ctx.id);
  }
}

/** The record an input of an atomic `addBulk` would get, for merging later inputs into it before anything is written. */
export function draftRecord(job: NewJob, scope: Scope, now: number): JobRecord {
  return {
    formatVersion: job.formatVersion, namespace: scope.namespace, queue: scope.queue, id: job.id, name: job.name ?? null, data: job.data,
    dataVersion: job.dataVersion ?? null, state: 'waiting', priority: job.priority ?? 0, seq: 0, runAt: now, attempt: 0,
    maxAttempts: job.maxAttempts, crashCount: 0, lease: null, token: 0, lastFinal: null, result: null, error: null,
    backoff: job.backoff ?? null, timeout: job.timeout ?? null, idempotencyKey: job.idempotencyKey ?? null, workerId: null, uniqueWhile: job.uniqueWhile ?? 'pending',
    singletonKey: job.singletonKey ?? null, singletonHeld: false, rev: 1, createdAt: now, startedAt: null, finishedAt: null,
    deadLetter: null, retainUntil: null, keep: job.keep ?? null, progress: null, batchProgress: null, redriveCount: 0, lastError: null,
    attemptsTruncated: 0, scheduleKey: null, scheduledFor: null, cancelReason: null,
  };
}
