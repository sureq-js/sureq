import type { JobRecord, JobState } from '../contract.js';
import type { Tombstone } from './hooks.js';

export type FinalKind = 'complete' | 'fail' | 'release';
export type FinalOutcome = { kind: FinalKind; state: JobState; runAt?: number };
type Fenced = Pick<JobRecord, 'state' | 'token' | 'lease' | 'lastFinal'>;
type FenceInput<R> = { rec: R | undefined; tombstone: Pick<Tombstone, 'token' | 'outcome'> | undefined; token: number; now: number };

/** A pass carries the record it judged, so the caller needs no non-null assertion. */
export type Verdict<R = Fenced> =
  | { verdict: 'pass'; rec: R }
  | { verdict: 'repeat'; outcome: FinalOutcome }
  | { verdict: 'reject'; reason: 'superseded' | 'expired' | 'not-active' };

/**
 * The one check every fenced write goes through. `kind: null` is a renew, which has no repeat.
 * Pure: it reads its input and decides; the caller applies the verdict.
 */
export function fence<R extends Fenced>(input: FenceInput<R> & { kind: null }): Exclude<Verdict<R>, { verdict: 'repeat' }>;
export function fence<R extends Fenced>(input: FenceInput<R> & { kind: FinalKind | null }): Verdict<R>;
export function fence<R extends Fenced>(input: FenceInput<R> & { kind: FinalKind | null }): Verdict<R> {
  const { rec, tombstone, token, kind, now } = input;
  if (kind !== null) {
    // The live record's last write first; then the tombstone of an earlier job with this id (removed, or superseded by a
    // new add). Tokens are unique per scope, so a tombstone whose token matches can only be that earlier job's.
    for (const last of [rec?.lastFinal, tombstone && { token: tombstone.token, ...tombstone.outcome }]) {
      if (last && last.token === token && last.kind === kind) {
        const { token: _token, ...outcome } = last;
        return { verdict: 'repeat', outcome };
      }
    }
  }
  if (!rec) return { verdict: 'reject', reason: 'not-active' };
  if (rec.token > token) return { verdict: 'reject', reason: 'superseded' };
  if (rec.state !== 'active' || !rec.lease || rec.token < token) return { verdict: 'reject', reason: 'not-active' };
  if (now >= rec.lease.expiresAt) return { verdict: 'reject', reason: 'expired' };
  return { verdict: 'pass', rec };
}
