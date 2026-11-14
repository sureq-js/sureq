import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../../src/store/contract.js';
import { fence, type FinalKind } from '../../src/store/memory/fence.js';
import type { Tombstone } from '../../src/store/memory/hooks.js';

type Rec = Pick<JobRecord, 'state' | 'token' | 'lease' | 'lastFinal'>;
const lease = (token: number, expiresAt = 2000) => ({ owner: 'w', token, expiresAt, claimId: 'c' });
const active = (token: number, expiresAt = 2000): Rec => ({ state: 'active', token, lease: lease(token, expiresAt), lastFinal: null });
const done: Rec = { state: 'completed', token: 5, lease: null, lastFinal: { token: 5, kind: 'complete', state: 'completed' } };
const tomb: Pick<Tombstone, 'token' | 'outcome'> = { token: 7, outcome: { kind: 'fail', state: 'delayed', runAt: 9000 } };

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') for (const x of Object.values(v)) deepFreeze(x);
  return Object.freeze(v);
}

const call = (rec: Rec | undefined, token: number, kind: FinalKind | null, now = 1000, tombstone?: typeof tomb) =>
  fence(deepFreeze({ rec, tombstone, token, kind, now }));

describe('fence', () => {
  it('fencing: rejection order is superseded, then not-active, then expired', () => {
    const rows: Array<[string, ReturnType<typeof call>, ReturnType<typeof fence>]> = [
      ['no record, no tombstone', call(undefined, 1, 'complete'), { verdict: 'reject', reason: 'not-active' }],
      ['newer token on a finished job', call(done, 4, 'complete'), { verdict: 'reject', reason: 'superseded' }],
      ['newer token on an active job', call(active(5), 4, null), { verdict: 'reject', reason: 'superseded' }],
      ['waiting with the same token', call({ state: 'waiting', token: 3, lease: null, lastFinal: null }, 3, 'fail'), { verdict: 'reject', reason: 'not-active' }],
      ['token above the job token', call(active(3), 4, 'complete'), { verdict: 'reject', reason: 'not-active' }],
      ['active without a lease', call({ state: 'active', token: 3, lease: null, lastFinal: null }, 3, null), { verdict: 'reject', reason: 'not-active' }],
      ['now at expiresAt', call(active(3, 2000), 3, 'complete', 2000), { verdict: 'reject', reason: 'expired' }],
      ['now one before expiresAt', call(active(3, 2000), 3, 'complete', 1999), { verdict: 'pass', rec: active(3, 2000) }],
      ['renew on a live lease', call(active(3), 3, null), { verdict: 'pass', rec: active(3) }],
    ];
    for (const [what, got, want] of rows) expect(got, what).toEqual(want);
  });

  it('contract: fence check order superseded, not-active, expired, and rejection changes nothing including rev', () => {
    const expiredDone: Rec = { ...done, lease: lease(5, 10) };
    expect(call(expiredDone, 5, 'complete', 5000)).toEqual({ verdict: 'repeat', outcome: { kind: 'complete', state: 'completed' } });
    expect(call(done, 5, 'fail')).toEqual({ verdict: 'reject', reason: 'not-active' });
    expect(call(done, 5, null)).toEqual({ verdict: 'reject', reason: 'not-active' });
    expect(call(undefined, 7, 'fail', 1000, tomb)).toEqual({ verdict: 'repeat', outcome: { kind: 'fail', state: 'delayed', runAt: 9000 } });
    expect(call(undefined, 7, 'complete', 1000, tomb)).toEqual({ verdict: 'reject', reason: 'not-active' });
    expect(call(undefined, 6, 'fail', 1000, tomb)).toEqual({ verdict: 'reject', reason: 'not-active' });
    // a tombstone outlives its job, so a live record with that id is a newer job: the earlier job's exact repeat still
    // answers, and any other token or kind meets the live record's rules
    expect(call(active(9), 7, 'fail', 1000, tomb)).toEqual({ verdict: 'repeat', outcome: { kind: 'fail', state: 'delayed', runAt: 9000 } });
    expect(call(active(9), 7, 'complete', 1000, tomb)).toEqual({ verdict: 'reject', reason: 'superseded' });
    expect(call(active(9), 8, 'fail', 1000, tomb)).toEqual({ verdict: 'reject', reason: 'superseded' });
    expect(call(undefined, 7, null, 1000, tomb)).toEqual({ verdict: 'reject', reason: 'not-active' });
  });
});
