import { cancelCompleteRace } from './cancel-complete-race.js';
import { claimNotRecoverable } from './claim-not-recoverable.js';
import { closeSkipsHistory } from './close-skips-history.js';
import { failIgnoresMaxAttempts } from './fail-ignores-max-attempts.js';
import { fakeAtomicAdd } from './fake-atomic-add.js';
import { fenceBumpsRev } from './fence-bumps-rev.js';
import { fifoBroken } from './fifo-broken.js';
import { finalNotRepeatable } from './final-not-repeatable.js';
import { holdIgnored } from './hold-ignored.js';
import { ignoredFencingToken } from './ignored-fencing-token.js';
import type { BrokenStore } from './inject.js';
import { lostWrites } from './lost-writes.js';
import { noLeaseExpiry } from './no-lease-expiry.js';
import { nonAtomicAdd } from './non-atomic-add.js';
import { nonAtomicClaim } from './non-atomic-claim.js';
import { nonAtomicFire } from './non-atomic-fire.js';
import { nonAtomicSingleton } from './non-atomic-singleton.js';
import { pauseIgnored } from './pause-ignored.js';
import { obliterateWithoutMarker } from './obliterate-without-marker.js';
import { perJobTokenReset } from './per-job-token-reset.js';
import { releaseTouchesCrash } from './release-touches-crash.js';
import { replaceOverwritesAll } from './replace-overwrites-all.js';
import { reusesSeq } from './reuses-seq.js';
import { scheduleIgnoresRev } from './schedule-ignores-rev.js';
import { skewedClock } from './skewed-clock.js';
import { statsNotAtomic } from './stats-not-atomic.js';
import { sweepNeverReclaims } from './sweep-never-reclaims.js';
import { sweepUndoesRenew } from './sweep-undoes-renew.js';
import { tokenReuse } from './token-reuse.js';
import { unconditionalRedrive } from './unconditional-redrive.js';
import { unfencedProgress } from './unfenced-progress.js';
import { unfencedRelease } from './unfenced-release.js';
import { updateIgnoresRev } from './update-ignores-rev.js';

export type { BrokenStore } from './inject.js';

/** Every broken store, in the order the suite's own docs list them. */
export const BROKEN: readonly BrokenStore[] = [
  nonAtomicClaim, noLeaseExpiry, sweepNeverReclaims, ignoredFencingToken, skewedClock, lostWrites, sweepUndoesRenew, tokenReuse,
  perJobTokenReset, failIgnoresMaxAttempts, cancelCompleteRace, releaseTouchesCrash, fenceBumpsRev, pauseIgnored, unfencedRelease,
  finalNotRepeatable, claimNotRecoverable, updateIgnoresRev, fifoBroken, fakeAtomicAdd,
  nonAtomicAdd, replaceOverwritesAll, nonAtomicSingleton, reusesSeq, statsNotAtomic, scheduleIgnoresRev, closeSkipsHistory, unconditionalRedrive,
  nonAtomicFire, holdIgnored, unfencedProgress, obliterateWithoutMarker,
];
