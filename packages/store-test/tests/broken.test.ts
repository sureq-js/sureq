import { MemoryStore, type RenewRequest, type RenewResult, type Scope } from '@sureq/core';
import { describe, expect, it } from 'vitest';
import { BROKEN, type BrokenStore } from './broken/index.js';
import { runAgainst } from './helpers/run-against.js';

const store = (name: string): BrokenStore => BROKEN.find((b) => b.name === name)!;

async function caught(name: string): Promise<void> {
  const b = store(name);
  const r = await runAgainst(b.make, b.mustFail);
  expect(r.failed.filter((t) => b.mustFail.includes(t)).sort(), `${name} fails every named test`).toEqual([...b.mustFail].sort());
  expect(r.harnessErrors.filter((t) => b.mustFail.includes(t)), `${name} is caught by assertions`).toEqual([]);
  expect(r.timeouts.filter((t) => b.mustFail.includes(t)), `${name} is not caught by a timeout`).toEqual([]);
}

describe('broken stores', { timeout: 120_000 }, () => {
  it('broken: nonAtomicClaim is caught', () => caught('nonAtomicClaim'));
  it('broken: noLeaseExpiry is caught', () => caught('noLeaseExpiry'));
  it('broken: sweepNeverReclaims is caught', () => caught('sweepNeverReclaims'));
  it('broken: ignoredFencingToken is caught', () => caught('ignoredFencingToken'));
  it('broken: skewedClock is caught', () => caught('skewedClock'));
  it('broken: lostWrites is caught', () => caught('lostWrites'));
  it('broken: sweepUndoesRenew is caught', () => caught('sweepUndoesRenew'));
  it('broken: tokenReuse is caught', () => caught('tokenReuse'));
  it('broken: perJobTokenReset is caught', () => caught('perJobTokenReset'));
  it('broken: failIgnoresMaxAttempts is caught', () => caught('failIgnoresMaxAttempts'));
  it('broken: cancelCompleteRace is caught', () => caught('cancelCompleteRace'));
  it('broken: releaseTouchesCrash is caught', () => caught('releaseTouchesCrash'));
  it('broken: fenceBumpsRev is caught', () => caught('fenceBumpsRev'));
  it('broken: pauseIgnored is caught', () => caught('pauseIgnored'));
  it('broken: unfencedRelease is caught', () => caught('unfencedRelease'));
  it('broken: finalNotRepeatable is caught', () => caught('finalNotRepeatable'));
  it('broken: claimNotRecoverable is caught', () => caught('claimNotRecoverable'));
  it('broken: updateIgnoresRev is caught', () => caught('updateIgnoresRev'));
  it('broken: fifoBroken is caught', () => caught('fifoBroken'));
  it('broken: fakeAtomicAdd is caught', () => caught('fakeAtomicAdd'));
  it('broken: nonAtomicAdd is caught', () => caught('nonAtomicAdd'));
  it('broken: replaceOverwritesAll is caught', () => caught('replaceOverwritesAll'));
  it('broken: nonAtomicSingleton is caught', () => caught('nonAtomicSingleton'));
  it('broken: reusesSeq is caught', () => caught('reusesSeq'));
  it('broken: statsNotAtomic is caught', () => caught('statsNotAtomic'));
  it('broken: scheduleIgnoresRev is caught', () => caught('scheduleIgnoresRev'));
  it('broken: closeSkipsHistory is caught', () => caught('closeSkipsHistory'));
  it('broken: unconditionalRedrive is caught', () => caught('unconditionalRedrive'));
  it('broken: nonAtomicFire is caught', () => caught('nonAtomicFire'));
  it('broken: holdIgnored is caught', () => caught('holdIgnored'));
  it('broken: unfencedProgress is caught', () => caught('unfencedProgress'));
  it('broken: obliterateWithoutMarker is caught', () => caught('obliterateWithoutMarker'));

  it('broken: a renew that reports success on an expired lease loses the renew and sweep race', async () => {
    // renew answers ok for a lease that ran out without extending it, so the sweep takes the job too: both win
    class RenewHidesExpiry extends MemoryStore {
      override async renew(scope: Scope, req: RenewRequest): Promise<RenewResult> {
        const res = await super.renew(scope, req);
        if (res.ok || res.reason !== 'expired') return res;
        const now = await this.now();
        return { ok: true, expiresAt: now + req.leaseMs, now };
      }
    }
    const title = 'lease: renew and sweep race — exactly one wins';
    const r = await runAgainst((opts) => new RenewHidesExpiry(opts), [title]);
    expect(r.failed).toEqual([title]);
    expect(r.harnessErrors).toEqual([]);
    expect(String((r.errors[title] as Error).message)).toContain('exactly one of renew and sweep wins');
  });
});
