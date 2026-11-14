import { SureQError } from '../errors/base.js';
import { InvalidOptionError } from '../errors/catalog.js';
import type { Job } from '../job/job.js';
import type { ProgressObject } from './progress.js';

/** What a handler gets besides the job. */
export interface JobContext {
  /** Aborted with a LeaseLostError when this attempt's lease is lost; its outcome is then discarded. */
  readonly signal: AbortSignal;
  /** This attempt's fencing token; the same as `job.token`, larger on every claim. */
  readonly token: number;
  /** Same as `job.attempt`; 1 on the first run. */
  readonly attempt: number;
  /** `attempt >= maxAttempts`. */
  readonly isLastAttempt: boolean;
  /** The worker running this attempt. */
  readonly workerId: string;
  /** Fail this attempt now; `{ retry: false }` makes it final. */
  fail(err: unknown, opts?: { retry?: boolean }): never;
  /**
   * Report progress, stored on the job (fenced) and read back as `job.progress` with an ETA. Calls within
   * `progressInterval` are merged; resolves once this value or a later one was written.
   */
  progress(n: number, total?: number, message?: string): Promise<void>;
  /** Report progress as any serializable object of at most `maxProgressBytes`. */
  progress(value: ProgressObject): Promise<void>;
}

/** What `ctx.fail` recorded: the first call wins, whatever the handler does afterwards. */
export type FailRecord = { err: unknown; retry?: boolean };

/** Thrown by `ctx.fail` to end the handler; the worker reads the FailRecord instead of this. Internal. */
export class CtxFailSignal extends SureQError {
  override readonly code = 'SUREQ_ERROR';
  constructor() {
    super('ctx.fail() was called');
  }
}

/** The context plus what only the worker reads. */
export type WorkerContext = JobContext & { getFailRecord(): FailRecord | undefined };

/** Build the frozen context for one attempt. */
export function createContext(
  job: Job, workerId: string, signal: AbortSignal, token: number, progress: (...args: unknown[]) => Promise<void>,
): WorkerContext {
  let record: FailRecord | undefined;
  return Object.freeze({
    signal,
    token,
    attempt: job.attempt,
    isLastAttempt: job.attempt >= job.maxAttempts,
    workerId,
    fail(err: unknown, opts?: { retry?: boolean }): never {
      const retry: unknown = opts?.retry;
      if (retry !== undefined && typeof retry !== 'boolean') {
        throw new InvalidOptionError('ctx.fail', [{ path: 'retry', code: 'invalid_type', message: 'expected boolean', expected: 'boolean' }]);
      }
      record ??= retry === undefined ? { err } : { err, retry };
      throw new CtxFailSignal();
    },
    progress,
    getFailRecord: () => record,
  });
}

/** A non-Error throw becomes an Error whose `cause` is the original value. */
export function toError(v: unknown): Error {
  if (v instanceof Error) return v;
  let message: string;
  try {
    message = String(v);
  } catch {
    message = 'Non-Error value thrown'; // e.g. Object.create(null), or a throwing toString
  }
  return Reflect.construct(Error, [message, { cause: v }]) as Error;
}
