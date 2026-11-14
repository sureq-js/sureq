import type { SureQError } from '../errors/base.js';
import { StoreUnavailableError, isStoreError } from '../errors/catalog.js';
import { wrapStoreError } from '../errors/store.js';
import type { CompleteResult, FailResult, ReleaseResult } from '../store/contract.js';

/** The first waits between tries of a finalising write; after them it waits FINALIZE_RETRY_MAX_DELAY_MS. */
export const FINALIZE_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
export const FINALIZE_RETRY_MAX_DELAY_MS = 1000;

/** What a finalising write returns; `{ ok: false }` means the store no longer has the job active for us. */
export type FinalResult = CompleteResult | FailResult | ReleaseResult;

export type FinalizeCtx = {
  operation: 'complete' | 'fail' | 'release';
  jobId: string;
  /** The local lease deadline on the `now` clock; undefined means one try only. */
  deadline: number | undefined;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  report: (e: SureQError) => void;
  /** Aborted when the caller gives up (a close that timed out): stop at once, quietly. */
  signal?: AbortSignal;
};

/** Worth trying again: the store may answer differently, or the write may not have landed. */
export function transient(e: SureQError): boolean {
  return isStoreError(e) && (e.retryable || e.outcomeUnknown);
}

/**
 * Run a `complete`/`fail`/`release` write, repeating the same write (same token) until the local
 * lease deadline. Past it the store would refuse the write and the sweeper owns the job, so the
 * outcome is reported once as unconfirmed; it is never a failure of the job.
 */
export async function finalize<T extends FinalResult>(write: () => Promise<T>, ctx: FinalizeCtx): Promise<T | { unconfirmed: true }> {
  let unknown = false;
  for (let i = 0; ; i++) {
    try {
      const r = await write();
      if (ctx.signal?.aborted) return { unconfirmed: true };
      // The earlier try may have landed and the record since moved on: nobody can tell.
      if (!(unknown && !r.ok && r.reason === 'not-active')) return r;
      break;
    } catch (e) {
      if (ctx.signal?.aborted) return { unconfirmed: true };
      const err = wrapStoreError(ctx.operation, e, ctx.jobId);
      if (!transient(err)) {
        ctx.report(err);
        return { unconfirmed: true };
      }
      unknown ||= isStoreError(err) && err.outcomeUnknown;
    }
    const left = ctx.deadline === undefined ? 0 : ctx.deadline - ctx.now();
    if (left <= 0) break;
    await ctx.sleep(Math.min(left, FINALIZE_RETRY_DELAYS_MS[i] ?? FINALIZE_RETRY_MAX_DELAY_MS));
    if (ctx.signal?.aborted) return { unconfirmed: true };
  }
  const message = `outcome of '${ctx.operation}' for job '${ctx.jobId}' is unconfirmed`;
  ctx.report(new StoreUnavailableError(message, { operation: ctx.operation, retryable: true, outcomeUnknown: true, jobId: ctx.jobId }));
  return { unconfirmed: true };
}
