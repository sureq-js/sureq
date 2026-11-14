// The one fence check behind the lease writes, a pure function with no store access.
import type { JobRecord, JobState } from '@sureq/core';
import type { Tombstone } from './backend.js';

export type FinalKind = 'complete' | 'fail' | 'release';
export type Verdict =
  | { verdict: 'pass'; rec: JobRecord }
  | { verdict: 'repeat'; state: JobState; runAt?: number }
  | { verdict: 'reject'; reason: 'superseded' | 'expired' | 'not-active' };

/**
 * The one fence check behind renew, complete, fail and release.
 * WHY: a worker may write to a job only while it holds the newest, unexpired lease, and a write that already
 * happened must be answered again, not refused. The steps run in this order; do not reorder them.
 * `kind` is absent for renew, which has no repeat. `tomb` is the last finalising write of an earlier job with this id.
 * WHY: the tombstone is checked even while a new job holds the id (it was removed and added again, or superseded):
 * tokens are unique per queue, so a tombstone whose token matches can only be that earlier job's.
 */
export function fenceCheck(rec: JobRecord | undefined, token: number, now: number, kind?: FinalKind, tomb?: Tombstone): Verdict {
  for (const last of [rec?.lastFinal, tomb && tomb.expiresAt > now ? tomb : undefined]) {
    if (kind && last && last.token === token && last.kind === kind) {
      return { verdict: 'repeat', state: last.state, ...(last.runAt !== undefined && { runAt: last.runAt }) };
    }
  }
  if (!rec) return { verdict: 'reject', reason: 'not-active' };
  if (rec.token > token) return { verdict: 'reject', reason: 'superseded' };
  if (rec.state !== 'active' || !rec.lease || rec.token < token) return { verdict: 'reject', reason: 'not-active' };
  if (now >= rec.lease.expiresAt) return { verdict: 'reject', reason: 'expired' };
  return { verdict: 'pass', rec };
}
