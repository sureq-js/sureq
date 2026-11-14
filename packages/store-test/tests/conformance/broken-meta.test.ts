import { describe, expect, it } from 'vitest';
import { GROUPS } from '../../src/groups/index.js';
import { BROKEN } from '../broken/index.js';
import { runAgainst } from '../helpers/run-against.js';

/**
 * Tests a broken store also fails besides its named ones, because they exercise the same bug.
 * 'any' is for a store whose bug lands wherever a test makes its seventh write.
 */
const COLLATERAL: Record<string, { reason: string; titles: readonly string[] | 'any' }> = {
  nonAtomicClaim: {
    reason: 'the skipLocked check also claims concurrently from one store object, and the history race claims while another pod reads',
    titles: [
      'capabilities: skipLocked true — 20 concurrent claimers finish within a time bound',
      'history: record and job state change atomically',
    ],
  },
  noLeaseExpiry: {
    reason: 'each of these also checks that an expired lease refuses a fenced write',
    titles: [
      'contract: fence check order superseded, not-active, expired, and rejection changes nothing including rev',
      'fencing: rejection order is superseded, then not-active, then expired',
      'fencing: expiry is judged by store time when pod clock is skewed ±1h',
      'release: stale token is rejected and changes nothing',
      'batch: renew of one job does not extend another',
    ],
  },
  sweepNeverReclaims: {
    reason: 'each of these needs sweep to reclaim an expired lease, or to see the obliterating marker of the queue it is given',
    titles: [
      'admin: obliterate marker blocks add and claim',
      'contract: fence check order superseded, not-active, expired, and rejection changes nothing including rev',
      'claim: second claim of the same job after release or sweep issues a larger token, and tokens are unique across jobs',
      'claim: concurrent claim and sweep of an expired job yields at most one holder',
      'lease-config: lease expiry is computed from store time with the per-name duration',
      'fencing: re-claim after sweep issues a larger token than the first claim',
      'fencing: token never decreases and is kept after the job finishes',
      'fencing: concurrent stale complete and fresh claim — exactly one wins',
      'sweep: lease expiring exactly at now is swept and one millisecond earlier is not',
      'meta: sweep skips records newer than maxFormat',
      'sweep: job at maxAttempts with crashCount below maxCrashes is failed with the supplied failError',
      'sweep: job reaching maxCrashes is failed with poisonError, also when maxAttempts is used up too',
      'sweep: requeued job is claimable at once and its next claim gets a larger token',
      'sweep: limit is respected and oldest expiry goes first',
      'sweep: concurrent sweepers count each crash exactly once',
      'sweep: sweep and stale complete race — exactly one outcome',
      'sweep: returns only the jobs this call swept, with previousOwner',
      'sweep: works while the queue is paused',
      'poison: sweep at crashCount reaching maxCrashes fails the job with POISON_PILL',
      'poison: two concurrent sweeps increment crashCount once',
      'poison: sweep fails with attempts error when maxAttempts is used up first',
      'poison: crashCount is not changed by complete, fail, release or cancel',
      'release: release leaves crashCount unchanged',
      'release: concurrent sweep and release leave exactly one state transition',
      'gpause: add, renew, complete, fail, release, sweep and cancel work while paused',
      "dedup: a reused id's old record is kept out of get, list and counts",
      'singleton: returning job (retry, sweep, release) is requeued with singletonHeld false when the key is held, and re-acquires it when free',
      'history: complete, fail, cancel, sweep and release close the record with the right outcome',
      'history: rejected stale complete does not modify a crashed record',
      'dlq: sweep over crash limit sets deadLetter reason crashLimit',
      'dlq: redrive moves failed to waiting and clears deadLetter',
      'dlq: redrive with resetAttempts false keeps attempt and crashCount',
      'batch: an expired held lease is swept as a refunded release without crashCount',
      'batch: an expired lease after started is swept as an ordinary crash',
      'batch: a swept held lease closes its attempt as released',
      'retention: age sets retainUntil from store time',
    ],
  },
  ignoredFencingToken: {
    reason: 'each of these also sends a stale token to a fenced write',
    titles: [
      'contract: a repeat after the job was claimed again is rejected superseded; after removal it returns the original outcome with repeated true while the tombstone lives (finalsTtl) and not-active after it expired',
      'contract: fence check order superseded, not-active, expired, and rejection changes nothing including rev',
      'fencing: stale token from a previous incarnation of a reused id is rejected',
      'fencing: concurrent stale complete and fresh claim — exactly one wins',
      'release: stale token is rejected and changes nothing',
      'history: rejected stale complete does not modify a crashed record',
    ],
  },
  skewedClock: {
    reason: 'after a +1h skew the store clock stays an hour ahead (it never goes back), so later expiry waits in the same group never expire',
    titles: [
      'lease: renew with current token extends beyond the original expiry',
      'lease: renew after expiry is rejected as expired and does not revive the lease',
      'lease: renew and sweep race — exactly one wins',
      'lease: renew with stale token is rejected and changes nothing',
      'lease: lease is cleared by complete, fail, release, cancel and sweep',
      'fencing: expiry is judged by store time when pod clock is skewed ±1h',
      'clock: lease expiry and delayed due time use the same clock',
      'history: waitMs and durationMs use store time under pod clock skew',
      'schedule-fire: expiry judged by store time with pod clock skewed ±1h',
      'retention: pass deletes jobs with retainUntil in the past in pages',
      'retention: age and count together remove a job when either is exceeded',
      'retention: count trimming spares jobs that finished within the given age',
      'retention: records without retainUntil age from finishedAt when olderThanMs is given',
      'retention: clean deletes the superseded records of a reused id, and retainExpired expires them by their own retainUntil',
    ],
  },
  sweepUndoesRenew: {
    reason: 'two sweeps racing on one job is the same no-recheck bug, and the snapshot sweep ignores maxFormat',
    titles: [
      'poison: two concurrent sweeps increment crashCount once',
      'meta: sweep skips records newer than maxFormat',
    ],
  },
  tokenReuse: {
    reason: 'each of these needs a larger token on a re-claim; the concurrent cancel tests see the token rewrite land after the claim returned, attempt records are keyed by token, and a reused token makes a new job\'s write match the old job\'s tombstone as a repeat',
    titles: [
      'admin: clean removes attempt history with the job',
      'admin: obliterate deletes schedules and settings but not worker records',
      "admin: token after forced obliterate and re-add of the same id is higher than the stale worker's",
      'contract: seq and token are never reused after remove, clean or forced obliterate',
      'contract: release returns job to waiting and keeps its token; refundAttempt decrements attempt; the next claim gets a larger token',
      'contract: fence check order superseded, not-active, expired, and rejection changes nothing including rev',
      'claim: second claim of the same job after release or sweep issues a larger token, and tokens are unique across jobs',
      'claim: concurrent claim and cancel never leaves a claimed job in a non-active state',
      'claim: concurrent claim and sweep of an expired job yields at most one holder',
      'fencing: tokens are unique per queue across jobs and never reused after remove, clean or forced obliterate',
      'fencing: stale token from a previous incarnation of a reused id is rejected',
      'fencing: concurrent stale complete and fresh claim — exactly one wins',
      'sweep: requeued job is claimable at once and its next claim gets a larger token',
      'cancel: concurrent cancel and claim leave a consistent state',
      'history: complete, fail, cancel, sweep and release close the record with the right outcome',
      'history: rejected stale complete does not modify a crashed record',
      'history: records are deleted with the job',
      'history: a repeated finalising call or a recovered claim adds no record',
      'history: cancel without history closes the open record and adds none',
      'dlq: redrive moves failed to waiting and clears deadLetter',
      'batch: claim with limit returns distinct tokens per job',
      'progress: write with stale token is rejected and changes nothing',
      'retention: clean deletes the superseded records of a reused id, and retainExpired expires them by their own retainUntil',
      'progress: batch jobs are written independently with their own tokens',
      'dlq: a superseded dead letter stays a dead letter until it is removed',
    ],
  },
  perJobTokenReset: {
    reason: 'each of these needs tokens unique across jobs or above a removed id; the concurrent cancel tests see the token rewrite land after the claim returned, and attempt records are keyed by token',
    titles: [
      'admin: obliterate deletes schedules and settings but not worker records',
      'contract: seq and token are never reused after remove, clean or forced obliterate',
      'claim: second claim of the same job after release or sweep issues a larger token, and tokens are unique across jobs',
      'claim: concurrent claim and cancel never leaves a claimed job in a non-active state',
      'cancel: concurrent cancel and claim leave a consistent state',
      'history: complete, fail, cancel, sweep and release close the record with the right outcome',
      'history: records are deleted with the job',
      'history: a repeated finalising call or a recovered claim adds no record',
      'history: cancel without history closes the open record and adds none',
      'batch: claim with limit returns distinct tokens per job',
      'progress: batch jobs are written independently with their own tokens',
    ],
  },
  failIgnoresMaxAttempts: {
    reason: 'each of these fails a job with no attempts left and expects it failed',
    titles: [
      'dlq: fail with no attempts left sets state failed and deadLetter reason exhausted atomically',
      'dlq: redrive with resetAttempts false keeps attempt and crashCount',
    ],
  },
  cancelCompleteRace: {
    reason: 'each of these completes a cancelled job with its token',
    titles: [
      'fencing: complete on cancelled job is rejected as not-active',
      'cancel: active job becomes cancelled immediately and lease is cleared',
    ],
  },
  releaseTouchesCrash: {
    reason: 'the release race checks crashCount after a release',
    titles: [
      'release: concurrent sweep and release leave exactly one state transition',
    ],
  },
  fenceBumpsRev: {
    reason: 'each of these checks that a refused fenced write leaves the record unchanged',
    titles: [
      'contract: rev increments by exactly one per mutation and not on reads or rejections',
      'fencing: complete with old token after re-claim is rejected as superseded',
      'fencing: renew, fail and release with stale token are all rejected and change nothing',
      'release: stale token is rejected and changes nothing',
      'dlq: sweep over crash limit sets deadLetter reason crashLimit',
    ],
  },
  pauseIgnored: {
    reason: 'each of these claims from a paused queue',
    titles: [
      'contract: claim reports blocked with the first applicable reason and retryAfterMs, and only when jobs is empty',
      'contract: claim reports nextRunAt of the earliest delayed job and paused true when nothing was claimed because of pause',
      'contract: setPaused persists, changed flag is correct, claim returns nothing while paused',
      'claim: blocked is reported only when jobs is empty, with the first applicable reason',
      'gpause: claim result reports paused true and blocked reason paused, also when a gate would apply',
      'gpause: concurrent setPaused and claim never return a job claimed after pause was acknowledged',
      'meta: a paused claim reports blocked only for jobs within maxFormat',
      'gpause: flag is per queue and namespace',
    ],
  },
  unfencedRelease: {
    reason: 'each of these releases with a stale token or after the lease expired',
    titles: [
      'contract: invalid arguments throw StoreRequestError before any change',
      'contract: a repeat after the job was claimed again is rejected superseded; after removal it returns the original outcome with repeated true while the tombstone lives (finalsTtl) and not-active after it expired',
      'contract: fence check order superseded, not-active, expired, and rejection changes nothing including rev',
    ],
  },
  finalNotRepeatable: {
    reason: 'each of these repeats a finalising write',
    titles: [
      'contract: a repeat after the job was claimed again is rejected superseded; after removal it returns the original outcome with repeated true while the tombstone lives (finalsTtl) and not-active after it expired',
      "contract: a repeat after the job's id was reused by a new job returns the original outcome with repeated true and leaves the new job untouched",
      'fencing: complete, fail and release repeated with the finalising token return the original outcome with repeated true',
      'release: repeat with the same token returns the original outcome with repeated true and changes nothing',
      'history: a repeated finalising call or a recovered claim adds no record',
      'retention: keep none with resultGrace 0 deletes record and attempt history at completion',
    ],
  },
  claimNotRecoverable: {
    reason: 'each of these reads the claimId back or repeats a claim',
    titles: [
      'claim: returns a waiting job as active with attempt 1, a positive token and lease owner and claimId set',
      'claim: repeat with the same claimId returns the same jobs with recovered true and claims nothing new',
      'claim: blocked is reported only when jobs is empty, with the first applicable reason',
      'history: a repeated finalising call or a recovered claim adds no record',
    ],
  },
  updateIgnoresRev: {
    reason: 'a merge racing a claim is the same edit of an active job',
    titles: ['merge: merge racing a claim never half-applies'],
  },
  fifoBroken: {
    reason: 'first: true is a seq order within a priority too, and the idem and meta claim tests take jobs in seq order',
    titles: [
      'claim: first true job is claimed before older jobs of the same priority',
      'idem: store round-trips idempotencyKey and exposes seq',
      'meta: claim skips records newer than maxFormat and leaves them unchanged',
    ],
  },
  fakeAtomicAdd: {
    reason: 'none',
    titles: [],
  },
  nonAtomicAdd: {
    reason: 'none',
    titles: [],
  },
  replaceOverwritesAll: {
    reason: 'none',
    titles: [],
  },
  nonAtomicSingleton: {
    reason: 'none',
    titles: [],
  },
  holdIgnored: {
    reason: 'hold is dropped before the request check, so a bad hold is not refused, and a swept unheld lease closes its attempt as crashed',
    titles: ['batch: a non-boolean hold or started is a StoreRequestError', 'batch: a swept held lease closes its attempt as released'],
  },
  unfencedProgress: {
    reason: 'any token is replaced by the stored one, so a missing token or another job\'s token is accepted too, and the revived lease changes a field a progress write must leave alone',
    titles: [
      'progress: batch jobs are written independently with their own tokens',
      'meta: unknown fields on a record survive complete, fail, renew and progress',
      'progress: malformed requests are refused',
    ],
  },
  reusesSeq: {
    reason: 'each of these checks seq after a delete',
    titles: [
      "admin: token after forced obliterate and re-add of the same id is higher than the stale worker's",
      'contract: first true after deleting the lowest job still gets a seq below every seq ever issued',
      'contract: seq and token are never reused after remove, clean or forced obliterate',
    ],
  },
  statsNotAtomic: {
    reason: 'none',
    titles: [],
  },
  scheduleIgnoresRev: {
    reason: 'none',
    titles: [],
  },
  closeSkipsHistory: {
    reason: 'the other history tests read the record complete should have closed',
    titles: [
      'history: claim opens a running record with startedAt, workerId, token and waitMs',
      'history: rejected stale complete does not modify a crashed record',
      'history: records are deleted with the job',
      'history: waitMs and durationMs use store time under pod clock skew',
      'history: closer with no open record inserts one',
      'retention: keep none with the default grace keeps a result-only record for resultGrace, then the pass removes it',
    ],
  },
  unconditionalRedrive: {
    reason: 'this one redrives the live job that now holds the id, which is not failed',
    titles: ['dlq: redrive of an id held by another job is skipped duplicate-id'],
  },
  obliterateWithoutMarker: {
    reason: 'it deletes through public calls only: it never refuses active jobs, never sets the marker and leaves history, schedules and the pause flag behind',
    titles: [
      'admin: obliterate refuses with active jobs unless forced',
      'admin: obliterate with active jobs and no force sets no marker',
      'admin: obliterate marker blocks every other write path',
      'admin: obliterate deletes schedules and settings but not worker records',
    ],
  },
  nonAtomicFire: {
    reason: 'its job goes in through add, so it also lacks the scheduleKey and scheduledFor the store must stamp and lets a singletonKey through',
    titles: ['schedule-fire: fire advances nextRunAt, bumps rev, and inserts the job atomically', 'schedule-fire: a fired job with a singletonKey is refused and changes nothing'],
  },
  lostWrites: {
    reason: 'every seventh write is dropped, so any test that makes seven or more writes on the group store can fail',
    titles: 'any',
  },
};

const REAL = ['lease', 'clock'];
/** Every title a group registers (a group may hold titles of more than one area). */
const titlesOf = (g: (typeof GROUPS)[number]): string[] => {
  const out: string[] = [];
  g.register({ test: (title) => void out.push(title), race: (title) => void out.push(title) });
  return out;
};
const isReal = (title: string): boolean => REAL.some((g) => title.startsWith(`${g}: `));
describe('suite: broken stores', { timeout: 600_000 }, () => {
  it('suite: each broken store fails exactly its named tests and no unrelated required group is skipped', async () => {
    for (const b of BROKEN) {
      const touchesReal = b.mustFail.some(isReal);
      const r = await runAgainst(b.make, (t) => touchesReal || !isReal(t), { iterations: 20 });
      const allowed = COLLATERAL[b.name]!;
      const extra = r.failed.filter((t) => !b.mustFail.includes(t));
      expect(b.mustFail.filter((t) => !r.failed.includes(t)), `${b.name}: named tests that did not fail`).toEqual([]);
      if (allowed.titles !== 'any') expect(extra.sort(), `${b.name}: failures outside its named tests`).toEqual([...allowed.titles].sort());
      expect(r.harnessErrors.filter((t) => b.mustFail.includes(t)), `${b.name}: named tests that crashed`).toEqual([]);
      expect(r.timeouts.filter((t) => b.mustFail.includes(t)), `${b.name}: named tests that only timed out`).toEqual([]);
      for (const g of GROUPS) {
        if (g.optIn || (!touchesReal && REAL.includes(g.name))) continue;
        const own = titlesOf(g);
        const ran = [...r.passed, ...r.failed].filter((t) => own.includes(t));
        expect(ran.length, `${b.name}: group ${g.name} ran`).toBeGreaterThan(0);
      }
      expect(r.report.skippedGroups.every((s) => s.startsWith('capabilities:') || s === 'merge:core'), `${b.name}: only gated groups skipped`).toBe(true);
    }
  });
});
