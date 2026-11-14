import { DuplicateJobError, InvalidJobStateError, InvalidOptionError, JobNotFoundError } from '../errors/catalog.js';
import type { QueueEvents } from '../events/types.js';
import { effectiveState } from '../job/states.js';
import type { Job } from '../job/job.js';
import type { DrainedLatch } from '../queue/drained.js';
import { MAX_PRIORITY, MIN_PRIORITY, type ResolvedQueueOptions } from '../queue/options.js';
import { deadLetters } from '../retention/policy.js';
import type { StoreClient } from '../store/client.js';
import type { DeadLetterReason, FailRequest, JobRecord, ListRequest, RedriveOutcome, RedriveRequest, Scope } from '../store/contract.js';
import type { Duration } from '../util/duration.js';
import { validate, type Rule, type Schema } from '../util/validate.js';

/** How a redrive moves a failed job back. */
export interface RedriveOptions {
  /** Run later instead of now; default 0. */
  delay?: Duration;
  /** Set the job's priority; default it keeps its own. */
  priority?: number;
  /** Start the attempt and crash counts from 0 again; default true. Without it the job gets one more attempt. */
  resetAttempts?: boolean;
}

/** What a `redriveAll` did; `done` is true once no matching dead letter is left. */
export interface RedriveSummary {
  /** How many jobs were moved back. */
  redriven: number;
  /** How many matching jobs were passed by. */
  skipped: number;
  /** True once no matching dead letter is left. */
  done: boolean;
  /** The first 100 skipped ids. */
  skippedIds: string[];
}

/** What the admin calls (dead letters, redrive, clean, drain, obliterate) need from a queue. */
export interface AdminHost {
  readonly client: StoreClient;
  readonly scope: Scope;
  toJob(rec: JobRecord, now: number): Job;
  emit<K extends 'redriven' | 'cleaned' | 'obliterated'>(event: K, payload: QueueEvents[K]): void;
  readonly drainedLatch: DrainedLatch;
  /** Waiting or delayed jobs left the queue: arm the drained latch and evaluate it. */
  jobsLeft(): Promise<void>;
  /** Failed jobs went back to waiting or delayed: the cached counts are out of date, and local workers may claim them. */
  redriven(): void;
}

const MAX_PAGE = 1000;
const MAX_SKIPPED_IDS = 100;
const REASONS: readonly DeadLetterReason[] = ['exhausted', 'unrecoverable', 'retryRejected', 'crashLimit', 'legacy'];
const reason: Rule = { kind: 'enum', values: REASONS };
const optionFields = {
  delay: { kind: 'duration' },
  priority: { kind: 'integer', min: MIN_PRIORITY, max: MAX_PRIORITY },
  resetAttempts: { kind: 'boolean' },
} as const satisfies Record<keyof RedriveOptions, Rule>;
const optionsSchema: Schema<{ delay?: number; priority?: number; resetAttempts?: boolean }> = { fields: optionFields };
const filterSchema: Schema<{ reason?: DeadLetterReason; olderThan?: number }> = { fields: { reason, olderThan: { kind: 'duration' } } };
const allSchema: Schema<{ delay?: number; priority?: number; resetAttempts?: boolean; limit?: number; pageSize: number }> = {
  fields: { ...optionFields, limit: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER }, pageSize: { kind: 'integer', min: 1, max: MAX_PAGE, default: 100 } },
};
const readSchema: Schema<{ reason?: DeadLetterReason; olderThan?: number; limit: number; cursor?: string }> = {
  fields: { reason, olderThan: { kind: 'duration' }, limit: { kind: 'integer', min: 1, max: MAX_PAGE, default: 100 }, cursor: { kind: 'string' } },
  check: (v, add) => {
    if (v.cursor !== undefined && !isOffset(v.cursor)) add({ path: 'cursor', code: 'invalid_value', message: 'expected the nextCursor of an earlier page' });
  },
};
const countSchema: Schema<{ reason?: DeadLetterReason }> = { fields: { reason } };
const isOffset = (s: string): boolean => /^\d{1,16}$/.test(s) && Number.isSafeInteger(Number(s));

/**
 * The `deadLetter` field of a fail or sweep request: `false` when dead-lettering is off or the job set its own `keep.failed`,
 * else the reason core knows (none on a sweep, where the store picks it) and `deadLetter.keep` as `keepMs`. Core always
 * sends the field: its absence marks a previous-release pod.
 */
export function deadLetterExt(cfg: ResolvedQueueOptions['deadLetter'], job: Pick<JobRecord, 'keep'>, reason?: Exclude<DeadLetterReason, 'crashLimit' | 'legacy'>): NonNullable<FailRequest['deadLetter']> {
  if (!deadLetters(job, cfg.enabled)) return false;
  return { ...(reason !== undefined && { reason }), ...(cfg.keepMs !== undefined && { keepMs: cfg.keepMs }) };
}

/** The store's dead-letter filter for a reason and an age. */
const filterOf = (f: { reason?: DeadLetterReason; olderThan?: number }): NonNullable<ListRequest['deadLetter']> => ({
  ...(f.reason !== undefined && { reason: f.reason }), ...(f.olderThan !== undefined && { olderThanMs: f.olderThan }),
});

const storeOptions = (o: { delay?: number; priority?: number; resetAttempts?: boolean }): Omit<RedriveRequest, 'ids' | 'filter' | 'limit'> => ({
  ...(o.delay !== undefined && { delayMs: o.delay }), ...(o.priority !== undefined && { priority: o.priority }),
  ...(o.resetAttempts !== undefined && { resetAttempts: o.resetAttempts }),
});

/** One page of dead letters, oldest first; the cursor is an offset, so a redrive between pages can shift it. */
export async function getDeadLetters(h: AdminHost, opts: unknown = {}): Promise<{ jobs: Job[]; nextCursor: string | null }> {
  const o = validate('getDeadLetters', opts, readSchema);
  const offset = o.cursor === undefined ? 0 : Number(o.cursor);
  const recs = await h.client.call('list', h.scope, {
    state: 'failed', deadLetter: filterOf(o), orderBy: 'deadLetterAt', order: 'asc', offset, limit: o.limit,
  });
  const now = await h.client.call('now');
  return { jobs: recs.map((rec) => h.toJob(rec, now)), nextCursor: recs.length === o.limit ? String(offset + o.limit) : null };
}

/** How many dead letters there are (of one reason), read 1000 at a time. */
export async function countDeadLetters(h: AdminHost, opts: unknown = {}): Promise<number> {
  const o = validate('countDeadLetters', opts, countSchema);
  let n = 0;
  for (let offset = 0; ; offset += MAX_PAGE) {
    const page = await h.client.call('list', h.scope, { state: 'failed', deadLetter: filterOf(o), orderBy: 'deadLetterAt', order: 'asc', offset, limit: MAX_PAGE });
    n += page.length;
    if (page.length < MAX_PAGE) return n;
  }
}

function emitRedriven(h: AdminHost, outcomes: RedriveOutcome[]): void {
  let any = false;
  for (const o of outcomes) {
    if (o.status !== 'redriven') continue;
    any = true;
    h.emit('redriven', { id: o.id, state: o.state, viaDeadLetter: o.viaDeadLetter });
  }
  if (any) h.redriven();
}

/**
 * Redrive failed jobs by id, outcomes in input order, sent 1000 ids per store call. `single` is `queue.redrive(id)`
 * and `job.retry()`: a superseded dead letter throws DuplicateJobError there instead of answering `duplicate-id`.
 */
export async function redrive(h: AdminHost, ids: unknown, opts: unknown, single: boolean): Promise<RedriveOutcome[]> {
  const list = single ? [ids] : ids;
  if (!Array.isArray(list) || !list.every((id) => typeof id === 'string' && id !== '')) {
    throw new InvalidOptionError('redrive', [{ path: 'id', code: 'invalid_type', message: single ? 'expected a string job id' : 'expected an array of string job ids' }]);
  }
  const o = storeOptions(validate('redrive', opts ?? {}, optionsSchema));
  const out: RedriveOutcome[] = [];
  for (let i = 0; i < list.length; i += MAX_PAGE) {
    const chunk = (list as string[]).slice(i, i + MAX_PAGE);
    // A redriven job makes the queue non-empty again: an evaluation in flight must re-read.
    h.drainedLatch.addStarted();
    const res = await h.client.call('redrive', h.scope, { ids: chunk, limit: chunk.length, ...o });
    emitRedriven(h, res);
    out.push(...res);
  }
  const dup = out.find((x) => x.status === 'skipped' && x.reason === 'duplicate-id');
  if (single && dup) {
    const holder = await h.client.call('get', h.scope, dup.id.slice(0, dup.id.lastIndexOf('#')));
    throw new DuplicateJobError({ jobId: dup.id, existingState: holder?.state ?? 'failed', by: 'id', reason: 'superseded' });
  }
  return out;
}

/**
 * `job.retry()` of the snapshot with `id` and `seq`: redrive that failed job; a job in another state throws
 * InvalidJobStateError, a removed one JobNotFoundError, and one whose id a newer job took DuplicateJobError.
 */
export async function retryJob(h: AdminHost, id: string, seq: number, opts: unknown): Promise<RedriveOutcome> {
  // A newer job holds the id: name the snapshot's history key, which the store answers `duplicate-id`.
  // ponytail: an id reused between this get and the redrive still redrives the newer job; closing that needs `seq` in the store request (a contract change)
  const live = await h.client.call('get', h.scope, id);
  const [out] = await redrive(h, live && live.seq !== seq ? `${id}#${seq}` : id, opts, true);
  if (out!.status === 'redriven') return out!;
  const rec = out!.reason === 'not-found' ? null : await h.client.call('get', h.scope, id);
  if (!rec) throw new JobNotFoundError({ jobId: id });
  throw new InvalidJobStateError({ jobId: id, state: effectiveState(rec, await h.client.call('now')) });
}

/**
 * Redrive every dead letter matching `filter`, oldest first, `pageSize` per store call, until none is left or `limit`
 * jobs were redriven. Not atomic: a failure stops it with what it did kept; running it again picks up the rest.
 */
export async function redriveAll(h: AdminHost, filter: unknown, opts: unknown): Promise<RedriveSummary> {
  const f = filterOf(validate('redriveAll', filter ?? {}, filterSchema));
  const o = validate('redriveAll', opts ?? {}, allSchema);
  const summary: RedriveSummary = { redriven: 0, skipped: 0, done: false, skippedIds: [] };
  let left = o.limit ?? Infinity;
  while (left > 0) {
    const limit = Math.min(o.pageSize, left);
    h.drainedLatch.addStarted();
    const res = await h.client.call('redrive', h.scope, { filter: f, limit, ...storeOptions(o) });
    emitRedriven(h, res);
    let moved = 0;
    for (const x of res) {
      if (x.status === 'redriven') moved++;
      else if (++summary.skipped <= MAX_SKIPPED_IDS) summary.skippedIds.push(x.id);
    }
    summary.redriven += moved;
    left -= moved;
    if (res.length < limit) {
      summary.done = true;
      break;
    }
    // A full page that moved nothing would repeat forever.
    if (moved === 0) break;
  }
  return summary;
}
