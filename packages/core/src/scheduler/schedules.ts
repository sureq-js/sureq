import {
  InvalidOptionError, PayloadTooLargeError, ScheduleConflictError, ScheduleNotFoundError, SerializationError, type ConfigIssue,
} from '../errors/catalog.js';
import { payloadText } from '../job/job.js';
import type { Logger } from '../logger/logger.js';
import { buildNewJob } from '../queue/add.js';
import type { QueueInternals } from '../queue/queue.js';
import { jobNameIssue, resolveJobOptions, type AddOptions, type ResolvedQueueOptions } from '../queue/options.js';
import { byteLength, serializeValue } from '../serialize/value.js';
import type { StoreClient } from '../store/client.js';
import type { NewJob, NewSchedule, OverlapPolicy, ScheduleRecord, Scope } from '../store/contract.js';
import { FORMAT_VERSION } from '../store/memory/format.js';
import { closest, validate, type Schema } from '../util/validate.js';
import { parseCron } from './cron.js';
import { nextOccurrence, parseTiming, upcoming, type ScheduleTiming, type Timing } from './timing.js';
import { platform } from '../platform/index.js';

/** What a schedule's jobs are made of. `data` is serialized once, at upsert; queue defaults apply when a job is made. */
export interface ScheduleTemplate<D = unknown> {
  /** The job name; absent for unnamed jobs. */
  name?: string;
  /** The job data each tick inserts. */
  data: D;
  /** Any `add` option except those the schedule owns, and `singletonKey` and `idempotencyKey` (one per job, not per schedule). */
  opts?: Omit<AddOptions<D>, 'id' | 'delay' | 'runAt' | 'onDuplicate' | 'uniqueWhile' | 'singletonKey' | 'idempotencyKey'>;
}

/** A schedule as `upsertSchedule` takes it. */
export type ScheduleDefinition<D = unknown> = ScheduleTiming & {
  /** A positive integer; a stored definition with a higher version is never replaced by a lower one. Default: unversioned. */
  version?: number;
  template: ScheduleTemplate<D>;
  /** What a tick does while the previous job has not finished. Default `'skip'`. */
  overlap?: OverlapPolicy;
  /** Ticks kept waiting under `'queue'` (1-1000, default 10); only for `'queue'`. */
  maxQueued?: number;
};

/**
 * A stored schedule as the schedule methods return it, with its template data read back. Standalone: it names only the
 * fields in the docs, so a change to the store record cannot change this type.
 */
export interface Schedule<D = unknown> {
  /** The key. */
  key: string;
  /** The namespace. */
  namespace: string;
  /** The queue name. */
  queue: string;
  /** Which timing it uses. */
  kind: 'cron' | 'every';
  /** The cron rule, when `kind` is `'cron'`. */
  cron?: string;
  /** The IANA time zone of `cron`. */
  tz?: string;
  /** The period, in ms, when `kind` is `'every'`. */
  everyMs?: number;
  /** Start of the `every` grid, in store time. */
  anchorAt?: number;
  /** The template, with its data read back. */
  template: { name: string | null; data: D; opts: Record<string, unknown> };
  /** The overlap policy. */
  overlap: OverlapPolicy;
  /** The backlog cap under `overlap: 'queue'`. */
  maxQueued: number;
  /** `true` while paused. */
  paused: boolean;
  /** The next tick, in store time. */
  nextRunAt: number;
  /** The tick of the last job made. */
  lastFiredFor: number | null;
  /** The id of the last job made. */
  lastJobId: string | null;
  /** Ticks in the `'queue'` backlog. */
  queuedTicks: number[];
  /** Jobs made so far. */
  runCount: number;
  /** A hash of the definition, used to answer `'unchanged'`. */
  definitionHash: string;
  /** The stored `version`. */
  definitionVersion: number;
  /** The record format. */
  formatVersion: number;
  /** When the schedule was first stored, in store time. */
  createdAt: number;
  /** When the schedule was last changed, in store time. */
  updatedAt: number;
}

/** What `upsertSchedule` did; `'stale'`: a higher `version` is stored, and nothing was written. */
export interface UpsertResult<D = unknown> {
  /** The schedule as stored after the call. */
  schedule: Schedule<D>;
  /** `'created'`, `'updated'`, `'unchanged'` (same definition), or `'stale'` (a newer `version` is stored, so nothing was written). */
  action: 'created' | 'updated' | 'unchanged' | 'stale';
}

/** What the schedule methods need from their queue. */
export interface ScheduleHost {
  readonly client: StoreClient;
  readonly scope: Scope;
  readonly queue: string;
  readonly maxPayloadBytes: number;
  readonly logger: Logger;
  /** The longest job id the store takes: min(255, store `maxIdBytes`). */
  keyLimit(): number;
  emit<K extends 'schedulePaused' | 'scheduleResumed' | 'scheduleDeleted'>(event: K, payload: { key: string }): void;
  /** The queue's filter, run once on the template at upsert (never when a tick fires). */
  filter: QueueInternals['filter'];
}

/** Compare-and-set writes per call before ScheduleConflictError. */
export const SCHEDULE_TRIES = 10;
const MAX_SCHEDULE_KEY_BYTES = 200;
const DEFAULT_MAX_QUEUED = 10;
const OVERLAPS: readonly OverlapPolicy[] = ['skip', 'queue', 'allow'];
/** Template options the schedule itself decides. */
const RESERVED = ['id', 'delay', 'runAt', 'onDuplicate', 'uniqueWhile', 'singletonKey', 'idempotencyKey'];

type TemplateInput = { name?: unknown; data: unknown; opts?: Record<string, unknown> };
type DefinitionInput = { cron?: unknown; tz?: unknown; every?: unknown; version?: number; template: TemplateInput; overlap?: unknown; maxQueued?: number };

const templateSchema: Schema<TemplateInput> = {
  fields: { name: { kind: 'unknown' }, data: { kind: 'unknown', required: true }, opts: { kind: 'object' } },
  check: ({ name }, add) => {
    const issue = name === undefined ? undefined : jobNameIssue(name, 'template.name');
    if (issue) add(issue);
  },
};

const definitionSchema: Schema<DefinitionInput> = {
  fields: {
    cron: { kind: 'unknown' },
    tz: { kind: 'unknown' },
    every: { kind: 'unknown' },
    version: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    template: { kind: 'object', required: true, schema: templateSchema as unknown as Schema<Record<string, unknown>> },
    overlap: { kind: 'unknown' },
    maxQueued: { kind: 'integer', min: 1, max: 1000 },
  },
  check: ({ overlap, maxQueued }, add) => {
    if (overlap !== undefined && !OVERLAPS.includes(overlap as OverlapPolicy)) {
      const suggestion = typeof overlap === 'string' ? closest(overlap, OVERLAPS) : undefined;
      add({
        path: 'overlap', code: typeof overlap === 'string' ? 'invalid_value' : 'invalid_type', reason: 'bad-overlap',
        message: `expected one of "skip" | "queue" | "allow"${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`, ...(suggestion && { suggestion }),
      });
    } else if (maxQueued !== undefined && overlap !== 'queue') {
      add({ path: 'maxQueued', code: 'conflict', message: 'maxQueued applies only to overlap "queue"' });
    }
  },
};

/** JSON with object keys sorted at every level, so key order never changes it. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v !== 'object' || v === null) return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
}

/** Hex SHA-256 of the canonical JSON of a definition's parts. */
export function definitionHash(parts: object): string {
  return platform.sha256Hex(JSON.stringify(canonical(parts)));
}

/** A stored schedule with its template data parsed. */
export function toSchedule<D>(rec: ScheduleRecord): Schedule<D> {
  return {
    key: rec.key,
    namespace: rec.namespace,
    queue: rec.queue,
    kind: rec.kind,
    ...(rec.cron !== undefined && { cron: rec.cron }),
    ...(rec.tz !== undefined && { tz: rec.tz }),
    ...(rec.everyMs !== undefined && { everyMs: rec.everyMs }),
    ...(rec.anchorAt !== undefined && { anchorAt: rec.anchorAt }),
    template: { name: rec.template.name, data: JSON.parse(payloadText(rec.template.data)) as D, opts: rec.template.opts },
    overlap: rec.overlap,
    maxQueued: rec.maxQueued,
    paused: rec.paused,
    nextRunAt: rec.nextRunAt,
    lastFiredFor: rec.lastFiredFor,
    lastJobId: rec.lastJobId,
    queuedTicks: rec.queuedTicks,
    runCount: rec.runCount,
    definitionHash: rec.definitionHash,
    definitionVersion: rec.definitionVersion,
    formatVersion: rec.formatVersion,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

/**
 * The job one tick fires: the frozen template under the queue's current defaults, id `sched:<key>:<scheduledFor>`,
 * due at the tick, `ignore` on a duplicate id, stamped with this pod's format like any added job. The filter is not
 * run here: it ran on the template at upsert.
 */
export function buildScheduledJob(
  rec: ScheduleRecord, scheduledFor: number, now: number, q: Pick<ResolvedQueueOptions, 'defaultJobOptions' | 'order' | 'uniqueWhile'>,
  formatVersion: number,
): NewJob {
  const { name, data, opts } = rec.template;
  const policy = resolveJobOptions(q.defaultJobOptions, { ...opts, ...(name !== null && { name }) }, now, q);
  const job = buildNewJob(`sched:${rec.key}:${scheduledFor}`, payloadText(data), policy, q.order === 'fifo', formatVersion);
  return { ...job, runAt: scheduledFor, onDuplicate: 'ignore' };
}

/** A stored schedule's timing (checked when it was upserted). */
function timingOf(s: Pick<ScheduleRecord, 'kind' | 'cron' | 'tz' | 'everyMs'>): Timing {
  return s.kind === 'cron' ? { kind: 'cron', cron: s.cron!, tz: s.tz ?? 'UTC', spec: parseCron(s.cron!) } : { kind: 'every', everyMs: s.everyMs! };
}

/** A stored schedule's first tick after `afterMs`, on its anchor grid for `every`; null when a cron has no match within 9 years. */
export function nextRunAfter(s: Pick<ScheduleRecord, 'kind' | 'cron' | 'tz' | 'everyMs' | 'anchorAt'>, afterMs: number): number | null {
  return nextOccurrence(timingOf(s), s.anchorAt ?? afterMs, afterMs);
}

const listSchema: Schema<{ cursor?: string; limit: number; state?: 'active' | 'paused' }> = {
  fields: {
    cursor: { kind: 'string' },
    limit: { kind: 'integer', min: 1, max: 1000, default: 100 },
    state: { kind: 'enum', values: ['active', 'paused'] },
  },
  check: ({ cursor }, add) => {
    if (cursor === '') add({ path: 'cursor', code: 'invalid_value', message: 'expected a non-empty string' });
  },
};
const nextRunsSchema: Schema<{ n: number }> = { fields: { n: { kind: 'integer', min: 1, max: 100 } } };

/** The writable part of a stored schedule. */
function writable(rec: ScheduleRecord): NewSchedule {
  const { namespace: _n, queue: _q, rev: _r, createdAt: _c, updatedAt: _u, ...rest } = rec;
  return rest;
}

const timingFields = (t: Timing): Pick<NewSchedule, 'kind' | 'cron' | 'tz' | 'everyMs'> =>
  t.kind === 'cron' ? { kind: 'cron', cron: t.cron, tz: t.tz } : { kind: 'every', everyMs: t.everyMs };
const timingId = (s: Pick<NewSchedule, 'kind' | 'cron' | 'tz' | 'everyMs'>): string => JSON.stringify([s.kind, s.cron, s.tz, s.everyMs]);

/** `namespace\0queue\0key` of every schedule whose stale upsert this process has logged. */
const staleLogged = new Set<string>();

/** A checked definition, ready for the store loop. */
interface Prepared {
  timing: Record<string, unknown>;
  version: number;
  template: ScheduleRecord['template'];
  /** The template as hashed: data parsed back from its stored text. */
  hashed: { name: string | null; data: unknown; opts: Record<string, unknown> };
  overlap: OverlapPolicy;
  maxQueued: number;
}

/** Schedule records of one queue: create or change by key, read, pause, resume, delete, preview. */
export class ScheduleManager {
  readonly #host: ScheduleHost;

  constructor(host: ScheduleHost) {
    this.#host = host;
  }

  #scope(method: string): string {
    return `Queue "${this.#host.queue}".${method}`;
  }

  /**
   * Create the schedule or bring it to `def`: unchanged when the definition hash matches, stale when a higher
   * `version` is stored. Every write is a compare-and-set on `rev`; ScheduleConflictError after SCHEDULE_TRIES writes.
   */
  async upsert<D>(key: string, def: ScheduleDefinition<D>): Promise<UpsertResult<D>> {
    const scope = this.#scope('upsertSchedule');
    const p = this.#prepare(scope, key, def);
    await this.#host.filter(p.hashed.data, { name: p.template.name, id: null, opts: p.template.opts, operation: 'schedule' });
    const { client, scope: where } = this.#host;
    let t: Timing | undefined;
    let hash = '';
    for (let writes = 0; writes < SCHEDULE_TRIES; writes++) {
      const now = await client.call('now');
      if (!t) {
        t = parseTiming(scope, p.timing, now);
        hash = definitionHash({ ...timingFields(t), template: p.hashed, overlap: p.overlap, maxQueued: p.maxQueued });
      }
      const stored = await client.call('getSchedule', where, { key });
      const plan = this.#plan(key, stored, t, hash, p, now);
      if ('done' in plan) return { schedule: toSchedule<D>(plan.done), action: plan.action };
      const res = await client.call('putSchedule', where, { schedule: plan.next, expectedRev: stored?.rev ?? null });
      if (res.ok) return { schedule: toSchedule<D>(res.schedule), action: plan.action };
    }
    throw new ScheduleConflictError({ key });
  }

  /** One schedule, or null. */
  async get(key: string): Promise<Schedule | null> {
    this.#checkKey('getSchedule', key);
    const rec = await this.#host.client.call('getSchedule', this.#host.scope, { key });
    return rec ? toSchedule(rec) : null;
  }

  /** One page in key order (one store call); with `state`, a page may hold fewer than `limit` while `nextCursor` is set. */
  async list(opts: { cursor?: string; limit?: number; state?: 'active' | 'paused' } = {}): Promise<{ schedules: Schedule[]; nextCursor: string | null }> {
    const { cursor, limit, state } = validate(this.#scope('listSchedules'), opts, listSchema);
    const page = await this.#host.client.call('listSchedules', this.#host.scope, { limit, ...(cursor !== undefined && { cursor }) });
    const kept = state === undefined ? page.schedules : page.schedules.filter((r) => r.paused === (state === 'paused'));
    return { schedules: kept.map((r) => toSchedule(r)), nextCursor: page.nextCursor };
  }

  /** Stop the schedule firing; a no-op without an event when it is already paused. */
  pause(key: string): Promise<Schedule> {
    return this.#setPaused('pauseSchedule', key, true);
  }

  /** Fire again from the first tick after store now; ticks missed while paused are not fired. A no-op when not paused. */
  resume(key: string): Promise<Schedule> {
    return this.#setPaused('resumeSchedule', key, false);
  }

  async #setPaused(method: string, key: string, paused: boolean): Promise<Schedule> {
    this.#checkKey(method, key);
    const { client, scope } = this.#host;
    for (let writes = 0; writes < SCHEDULE_TRIES; writes++) {
      const rec = await client.call('getSchedule', scope, { key });
      if (!rec) throw new ScheduleNotFoundError({ key });
      if (rec.paused === paused) return toSchedule(rec);
      const next = { ...writable(rec), paused };
      if (!paused) {
        const at = nextRunAfter(rec, await client.call('now'));
        next.nextRunAt = at ?? noOccurrence(this.#scope(method));
      }
      const res = await client.call('putSchedule', scope, { schedule: next, expectedRev: rec.rev });
      if (!res.ok) continue;
      this.#host.emit(paused ? 'schedulePaused' : 'scheduleResumed', { key });
      return toSchedule(res.schedule);
    }
    throw new ScheduleConflictError({ key });
  }

  /** Remove the schedule; jobs it made are left alone. False when there was none. */
  async delete(key: string): Promise<boolean> {
    this.#checkKey('deleteSchedule', key);
    const res = await this.#host.client.call('deleteSchedule', this.#host.scope, { key });
    if (res.deleted) this.#host.emit('scheduleDeleted', { key });
    return res.deleted;
  }

  /** The next `n` (1-100) ticks after store now, in epoch ms; writes nothing, also for a paused schedule. */
  async nextRuns(key: string, n = 5): Promise<number[]> {
    validate(this.#scope('nextRuns'), { n }, nextRunsSchema);
    this.#checkKey('nextRuns', key);
    const { client, scope } = this.#host;
    const rec = await client.call('getSchedule', scope, { key });
    if (!rec) throw new ScheduleNotFoundError({ key });
    const now = await client.call('now');
    return upcoming(timingOf(rec), rec.anchorAt ?? now, now, n);
  }

  /** A key the store can hold, else InvalidOptionError. */
  #checkKey(method: string, key: unknown): void {
    const issue = this.#keyIssue(key);
    if (issue) throw new InvalidOptionError(this.#scope(method), [issue]);
  }

  /** What one round of an upsert writes, or the answer when it writes nothing. */
  #plan(key: string, stored: ScheduleRecord | null, t: Timing, hash: string, p: Prepared, now: number):
    | { done: ScheduleRecord; action: 'unchanged' | 'stale' }
    | { next: NewSchedule; action: 'created' | 'updated' | 'unchanged' } {
    const definition = {
      formatVersion: FORMAT_VERSION, key, ...timingFields(t), template: p.template, overlap: p.overlap, maxQueued: p.maxQueued,
      definitionHash: hash, definitionVersion: p.version,
    };
    if (!stored) {
      const next = { ...definition, anchorAt: now, paused: false, lastFiredFor: null, lastJobId: null, queuedTicks: [], runCount: 0 };
      // a later round's `now` may be past a cron's last match, which parseTiming checked only for the first
      return { next: { ...next, nextRunAt: nextOccurrence(t, now, now) ?? noOccurrence(this.#scope('upsertSchedule')) }, action: 'created' };
    }
    if (stored.definitionVersion > p.version) {
      this.#logStale(key, stored.definitionVersion, p.version);
      return { done: stored, action: 'stale' };
    }
    if (stored.definitionHash === hash) {
      if (stored.definitionVersion === p.version) return { done: stored, action: 'unchanged' };
      // a higher version of the same definition: raise it, so an older one can no longer come back
      return { next: { ...writable(stored), definitionVersion: p.version }, action: 'unchanged' };
    }
    const retimed = timingId(stored) !== timingId(definition);
    const anchorAt = retimed && t.kind === 'every' ? now : (stored.anchorAt ?? now);
    return {
      next: {
        ...definition, anchorAt, paused: stored.paused, nextRunAt: retimed ? (nextOccurrence(t, anchorAt, now) ?? noOccurrence(this.#scope('upsertSchedule'))) : stored.nextRunAt,
        lastFiredFor: stored.lastFiredFor, lastJobId: stored.lastJobId, queuedTicks: stored.queuedTicks, runCount: stored.runCount,
      },
      action: 'updated',
    };
  }

  #logStale(key: string, storedVersion: number, version: number): void {
    const { scope, logger, queue } = this.#host;
    const id = `${scope.namespace}\u0000${scope.queue}\u0000${key}`;
    if (staleLogged.has(id)) return;
    staleLogged.add(id);
    logger.warn(`scheduleStale: schedule "${key}" keeps its stored version ${storedVersion}; this definition has version ${version}`, {
      queue, key, storedVersion, version,
    });
  }

  /** Every check that needs no store; one InvalidOptionError with every issue, then the payload size. */
  #prepare(scope: string, key: string, def: unknown): Prepared {
    const issues: ConfigIssue[] = [];
    const keyProblem = this.#keyIssue(key);
    if (keyProblem) issues.push(keyProblem);
    const v = collect(issues, () => validate(scope, def, definitionSchema));
    // the rest is checked on the input as given, so one error lists every issue
    const raw = plain(def);
    const tpl = plain(raw['template']);
    const timing = { cron: raw['cron'], tz: raw['tz'], every: raw['every'] };
    // whether a cron has an occurrence needs store time: checked in the store loop
    collect(issues, () => parseTiming(scope, timing, 0), (i) => i.reason !== 'no-occurrence');
    const opts = templateOptions(plain(tpl['opts']), issues);
    let json = 'null';
    try {
      json = serializeValue(tpl['data']).json;
    } catch (e) {
      if (!(e instanceof SerializationError)) throw e;
      issues.push({ path: 'template.data', code: 'invalid_value', message: e.message });
    }
    if (issues.length > 0 || !v) throw new InvalidOptionError(scope, issues);
    const size = byteLength(json);
    const { maxPayloadBytes: limit, queue } = this.#host;
    if (size > limit) throw new PayloadTooLargeError({ size, limit, queue });
    const name = (v.template.name as string | undefined) ?? null;
    return {
      timing, version: v.version ?? 0, template: { name, data: json, opts }, hashed: { name, data: JSON.parse(json) as unknown, opts },
      overlap: (v.overlap as OverlapPolicy | undefined) ?? 'skip', maxQueued: v.maxQueued ?? DEFAULT_MAX_QUEUED,
    };
  }

  /** A key is 1-200 UTF-8 bytes, and the id of a job it fires must fit the store. */
  #keyIssue(key: unknown): ConfigIssue | undefined {
    if (typeof key !== 'string') return { path: 'key', code: 'invalid_type', message: 'expected a string' };
    if (key === '') return { path: 'key', code: 'invalid_value', message: 'expected a non-empty string' };
    if (byteLength(key) > MAX_SCHEDULE_KEY_BYTES) return { path: 'key', code: 'out_of_range', message: `expected at most ${MAX_SCHEDULE_KEY_BYTES} UTF-8 bytes` };
    const limit = this.#host.keyLimit();
    if (byteLength(`sched:${key}:${Number.MAX_SAFE_INTEGER}`) > limit) {
      return { path: 'key', code: 'out_of_range', message: `the job id sched:<key>:<tick> must fit the store's ${limit}-byte id limit` };
    }
    return undefined;
  }
}

function noOccurrence(scope: string): never {
  throw new InvalidOptionError(scope, [{ path: 'cron', code: 'invalid_value', reason: 'no-occurrence', message: 'no date matches within 9 years' }]);
}

const plain = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Run a check; an InvalidOptionError's issues (those `keep` keeps) go to `issues` instead. */
function collect<T>(issues: ConfigIssue[], check: () => T, keep: (i: ConfigIssue) => boolean = () => true): T | undefined {
  try {
    return check();
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    issues.push(...e.issues.filter(keep));
    return undefined;
  }
}

/** The template's `add` options as stored: reserved ones refused, the rest checked the way `add` checks them. */
function templateOptions(given: Record<string, unknown>, issues: ConfigIssue[]): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(given)) {
    if (value === undefined) continue;
    if (RESERVED.includes(k)) issues.push({ path: `template.opts.${k}`, code: 'invalid_value', message: 'not allowed in a schedule template' });
    else opts[k] = value;
  }
  const own: ConfigIssue[] = [];
  collect(own, () => resolveJobOptions({}, opts, 0));
  issues.push(...own.map((i) => ({ ...i, path: `template.opts.${i.path}` })));
  return opts;
}
