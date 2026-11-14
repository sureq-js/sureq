import type { JobRecord, JobState, NewJob, StoredAttempt } from '../contract.js';

/** One scope's live records by id, with a running count per state so counting never scans. */
export class RecordMap extends Map<string, JobRecord> {
  readonly byState: Record<JobState, number> = { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0 };
  override set(id: string, rec: JobRecord): this {
    const old = super.get(id);
    if (old) this.byState[old.state]--;
    this.byState[rec.state]++;
    return super.set(id, rec);
  }
  override delete(id: string): boolean {
    const old = super.get(id);
    if (old) this.byState[old.state]--;
    return super.delete(id);
  }
  /** Change a record's state, keeping the counts right when the record is in this map. */
  restate(rec: JobRecord, to: JobState): void {
    if (super.get(rec.id) === rec) {
      this.byState[rec.state]--;
      this.byState[to]++;
    }
    rec.state = to;
  }
}

/** The part of one scope's data the duplicate rules read and write. */
export interface DedupState {
  records: RecordMap;
  /** Finished records whose id was reused, under `id#<seq>`; only `getAttempts` reads them. */
  history: Map<string, JobRecord>;
  /** Attempt rows per job id (live or history key), ordered by token. */
  attempts: Map<string, StoredAttempt[]>;
  /** singletonKey to the id of the waiting or delayed job holding it. */
  holders: Map<string, string>;
}

const isFinished = (rec: JobRecord): boolean => rec.state === 'completed' || rec.state === 'failed' || rec.state === 'cancelled';

/** The live record holding `id` under its own `uniqueWhile`, if any. */
export function findHolder(state: DedupState, id: string): JobRecord | undefined {
  const rec = state.records.get(id);
  return rec && (rec.uniqueWhile === 'retained' || !isFinished(rec)) ? rec : undefined;
}

function moveRows(state: DedupState, from: string, to: string): void {
  const rows = state.attempts.get(from);
  if (!rows) return;
  state.attempts.delete(from);
  state.attempts.set(to, rows);
}

/** Move a finished record that no longer holds its id, and its attempt rows, to its history key, so the id is free. */
export function supersede(state: DedupState, finished: JobRecord): void {
  const id = finished.id;
  state.records.delete(id);
  finished.id = `${id}#${finished.seq}`;
  state.history.set(finished.id, finished);
  moveRows(state, id, finished.id);
}

/** Undo `supersede`. */
export function unsupersede(state: DedupState, rec: JobRecord, id: string): void {
  state.history.delete(rec.id);
  moveRows(state, rec.id, id);
  rec.id = id;
  state.records.set(id, rec);
}

/** Drop `rec`'s hold on its key (a no-op when it holds none). */
export function releaseHold(state: DedupState, rec: JobRecord): void {
  if (!rec.singletonHeld) return;
  if (state.holders.get(rec.singletonKey!) === rec.id) state.holders.delete(rec.singletonKey!);
  rec.singletonHeld = false;
}

/** A job returning to waiting or delayed takes its key when free; otherwise it is requeued without it. */
export function takeOrSkipHold(state: DedupState, rec: JobRecord): void {
  if (rec.singletonKey === null) return;
  const holder = state.holders.get(rec.singletonKey);
  rec.singletonHeld = holder === undefined || holder === rec.id;
  if (rec.singletonHeld) state.holders.set(rec.singletonKey, rec.id);
}

/** A replace's `timeout` overrides only the sub-fields it names (`timeoutMs`, `graceMs`); `null` clears it. */
function replaceTimeout(stored: JobRecord['timeout'], given: JobRecord['timeout']): JobRecord['timeout'] {
  if (typeof stored !== 'string' || typeof given !== 'string') return given;
  try {
    return JSON.stringify({ ...(JSON.parse(stored) as object), ...(JSON.parse(given) as object) });
  } catch {
    return given;
  }
}

type Settable = 'name' | 'priority' | 'maxAttempts' | 'dataVersion' | 'backoff' | 'timeout' | 'idempotencyKey' | 'keep';

/**
 * The record after `replace`: new `data` plus only the fields the caller set (key present, not in
 * `defaulted`; `null` is a value). `maxAttempts` never drops below `attempt`; without a new
 * `runAt`/`delayMs` the stored `runAt` is kept; the state follows the resulting `runAt`.
 */
export function applyReplace(existing: JobRecord, job: NewJob, now: number): JobRecord {
  const set = (k: Settable): boolean => Object.hasOwn(job, k) && !(job.defaulted as readonly string[] | undefined)?.includes(k);
  const next: JobRecord = { ...existing, data: structuredClone(job.data), rev: existing.rev + 1 };
  if (set('name')) next.name = job.name ?? null;
  if (set('priority')) next.priority = job.priority!;
  if (set('maxAttempts')) next.maxAttempts = Math.max(job.maxAttempts, existing.attempt);
  if (set('dataVersion')) next.dataVersion = job.dataVersion ?? null;
  if (set('backoff')) next.backoff = structuredClone(job.backoff ?? null);
  if (set('timeout')) next.timeout = replaceTimeout(existing.timeout, structuredClone(job.timeout ?? null));
  if (set('idempotencyKey')) next.idempotencyKey = job.idempotencyKey ?? null;
  if (set('keep')) next.keep = structuredClone(job.keep ?? null);
  if (job.runAt !== undefined) next.runAt = job.runAt;
  else if (job.delayMs !== undefined) next.runAt = now + job.delayMs;
  next.state = next.runAt > now ? 'delayed' : 'waiting';
  return next;
}
