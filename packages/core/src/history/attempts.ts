import { InvalidOptionError } from '../errors/catalog.js';
import { parsePayload } from '../job/job.js';
import type { SerializedError } from '../serialize/error.js';
import type { StoreClient } from '../store/client.js';
import type { AttemptOutcome, Scope, StoredAttempt } from '../store/contract.js';
import { validate, type Schema } from '../util/validate.js';

/** One attempt of a job: who ran it, when (store time), how long, and how it ended. */
export interface AttemptRecord {
  /** The job. */
  readonly jobId: string;
  /** The job's attempt number this attempt ran as, from 1. */
  readonly attempt: number;
  /** The job's redrive count at the claim: 0 for the first run. */
  readonly cycle: number;
  /** The fencing token of the attempt's lease; unique per queue, ascending in claim order. */
  readonly token: number;
  /** The worker that ran it. */
  readonly workerId: string;
  /** The host the worker ran on; null when the store had no record of it. */
  readonly host: string | null;
  /** When it was claimed, in store time. */
  readonly startedAt: number;
  /** Null while the attempt runs. */
  readonly finishedAt: number | null;
  /** `finishedAt - startedAt`, or null while it runs. */
  readonly durationMs: number | null;
  /** How long the job waited to be claimed: `startedAt - runAt`. */
  readonly waitMs: number;
  /** The batch it ran in, or null. */
  readonly batchId: string | null;
  /** How long a batch job was held before its handler started, or null. */
  readonly heldMs: number | null;
  /** How it ended; `'running'` while it is open. */
  readonly outcome: AttemptOutcome;
  /** The handler's error of a failed attempt; for a crashed one a `LeaseExpired` error with the last renew time and worker id. */
  readonly error: SerializedError | null;
  /** What closed the record, or null while it runs. */
  readonly endedBy: 'worker' | 'sweeper' | 'cancel' | 'shutdown' | null;
}

/** One page of a job's attempt records, oldest first. */
export interface AttemptPage {
  /** The records, oldest first. */
  attempts: AttemptRecord[];
  /** How many older records the per-job cap dropped. */
  truncated: number;
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

/** The public record of a stored row; a crashed attempt's error is built here from its last renew time. */
export function toAttemptRecord(row: StoredAttempt): AttemptRecord {
  const error: SerializedError | null = row.outcome === 'crashed'
    ? { v: 1, name: 'LeaseExpired', message: 'the lease expired before the attempt ended', props: { lastRenewAt: row.lastRenewAt, workerId: row.workerId } }
    : (parsePayload(row.error) as SerializedError | null);
  return Object.freeze({
    jobId: row.jobId, attempt: row.attempt, cycle: row.cycle, token: row.token, workerId: row.workerId, host: row.host,
    startedAt: row.startedAt, finishedAt: row.finishedAt, durationMs: row.durationMs, waitMs: row.waitMs, batchId: row.batchId,
    heldMs: row.heldMs, outcome: row.outcome, error, endedBy: row.endedBy,
  });
}

const pageSchema: Schema<{ limit?: number; cursor?: string }> = {
  fields: { limit: { kind: 'integer', min: 1, max: 1000 }, cursor: { kind: 'string' } },
  check: (v, add) => {
    if (v.cursor !== undefined && !(/^\d{1,16}$/.test(v.cursor) && Number.isSafeInteger(Number(v.cursor)))) add({ path: 'cursor', code: 'invalid_value', message: 'expected the nextCursor of an earlier page' });
  },
};

/** One page of `jobId`'s attempt records; a bad id, limit or cursor throws InvalidOptionError. */
export async function readAttempts(client: StoreClient, scope: Scope, jobId: string, opts: unknown): Promise<AttemptPage> {
  if (typeof jobId !== 'string' || jobId === '') {
    throw new InvalidOptionError('getAttempts', [{ path: 'id', code: 'invalid_type', message: 'expected a string job id' }]);
  }
  const page = validate('getAttempts', opts, pageSchema);
  const res = await client.call('getAttempts', scope, { id: jobId, ...page });
  return { attempts: res.attempts.map(toAttemptRecord), truncated: res.truncated, nextCursor: res.nextCursor };
}

/** Every attempt record of a job, oldest first, read page by page. */
export async function readAllAttempts(client: StoreClient, scope: Scope, jobId: string): Promise<AttemptRecord[]> {
  const all: AttemptRecord[] = [];
  for (let cursor: string | undefined; ;) {
    const page = await readAttempts(client, scope, jobId, { limit: 1000, ...(cursor !== undefined && { cursor }) });
    all.push(...page.attempts);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
}
