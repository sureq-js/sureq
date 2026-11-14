import { describe, expect, it } from 'vitest';
import { StoreFormatError, StoreRequestError } from '../../src/errors/catalog.js';
import type { JobRecord, Scope } from '../../src/store/contract.js';
import { SCOPE, claimReq, fakeClock, newJob, openStore } from '../helpers/store.js';

const ids = (recs: JobRecord[]) => recs.map((r) => r.id);

describe('memstore (claim)', () => {
  it('memstore: claim sets state active, increments attempt and token', async () => {
    const store = await openStore({ clock: fakeClock(2000).clock });
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' })]);
    const res = await store.claim(SCOPE, claimReq({ limit: 1, workerId: 'w9', claimId: 'cl-1', leaseMs: 5000 }));
    expect(res).toMatchObject({ now: 2000, nextRunAt: null, paused: false });
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0]).toMatchObject({ id: 'a', state: 'active', attempt: 1, token: 1, workerId: 'w9', startedAt: 2000, rev: 2 });
    expect(res.jobs[0]!.lease).toEqual({ owner: 'w9', token: 1, expiresAt: 7000, claimId: 'cl-1' });
    const [b] = (await store.claim(SCOPE, claimReq({ limit: 1, workerId: 'w2' }))).jobs;
    expect(b).toMatchObject({ id: 'b', token: 2, workerId: 'w2' });
    expect((await store.get(SCOPE, 'a'))!.state).toBe('active');
  });

  it('memstore: claim returns jobs in priority then seq order and respects limit', async () => {
    const store = await openStore();
    await store.add(SCOPE, [0, 5, 5, -1, 5].map((priority, i) => newJob({ id: `p${i}`, priority })));
    expect(ids((await store.claim(SCOPE, claimReq({ limit: 3 }))).jobs)).toEqual(['p1', 'p2', 'p4']);
    expect(ids((await store.claim(SCOPE, claimReq())).jobs)).toEqual(['p0', 'p3']);
    expect((await store.claim(SCOPE, claimReq())).jobs).toEqual([]);
  });

  it('memstore: claim with a names filter returns only matching names, in order, and null matches unnamed jobs', async () => {
    const fill = async () => {
      const store = await openStore();
      await store.add(SCOPE, ['a', 'b', null, 'a', 'b'].map((name, i) => newJob({ id: `n${i}`, name })));
      return store;
    };
    expect(ids((await (await fill()).claim(SCOPE, claimReq({ names: ['a', null] }))).jobs)).toEqual(['n0', 'n2', 'n3']);
    expect((await (await fill()).claim(SCOPE, claimReq({ names: ['b'] }))).jobs.map((r) => r.name)).toEqual(['b', 'b']);
    expect(ids((await (await fill()).claim(SCOPE, claimReq())).jobs)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect((await (await fill()).claim(SCOPE, claimReq({ names: [] }))).jobs).toEqual([]);
  });

  it('memstore: claim promotes due delayed jobs and skips future ones', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'soon', delayMs: 100 }), newJob({ id: 'later', delayMs: 500 })]);
    expect((await store.claim(SCOPE, claimReq())).jobs).toEqual([]);
    c.t = 1100;
    expect(ids((await store.claim(SCOPE, claimReq())).jobs)).toEqual(['soon']);
  });

  it('memstore: claim reports nextRunAt of the earliest delayed job', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob({ delayMs: 500 }), newJob({ delayMs: 200 }), newJob()]);
    expect(await store.claim(SCOPE, claimReq())).toMatchObject({ nextRunAt: 1200 });
    const empty = await openStore();
    expect(await empty.claim(SCOPE, claimReq())).toMatchObject({ jobs: [], nextRunAt: null });
  });

  it('memstore: tokens come from one per-queue counter and are never reused', async () => {
    const store = await openStore();
    const other: Scope = { namespace: 'n', queue: 'q2' };
    await store.add(SCOPE, [newJob({ id: 'same' })]);
    await store.add(other, [newJob({ id: 'o' })]);
    const [s1] = (await store.claim(SCOPE, claimReq())).jobs;
    const [o1] = (await store.claim(other, claimReq())).jobs;
    expect([s1!.token, o1!.token]).toEqual([1, 1]);
    await store.complete(SCOPE, { id: 'same', token: s1!.token, result: null });
    await store.remove(SCOPE, { id: 'same' });
    await store.add(SCOPE, [newJob({ id: 'same' })]);
    const [s2] = (await store.claim(SCOPE, claimReq())).jobs;
    expect(s2!.token).toBe(2);
  });

  it('memstore: claim skips a record whose format is unreadable and leaves it untouched', async () => {
    const store = await openStore();
    await store.add(SCOPE, ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => newJob({ id })));
    store.unsafeMutate(SCOPE, 'c2', { formatVersion: 2 });
    store.unsafeMutate(SCOPE, 'c4', { formatVersion: '1' });
    expect(ids((await store.claim(SCOPE, claimReq({ maxFormat: 1 }))).jobs)).toEqual(['c1', 'c3', 'c5']);
    const left = store.dump().jobs.filter((j) => j.id === 'c2' || j.id === 'c4');
    expect(left.map((j) => [j.id, j.state, j.rev, j.attempt])).toEqual([['c2', 'waiting', 1, 0], ['c4', 'waiting', 1, 0]]);
    expect((await store.claim(SCOPE, claimReq({ maxFormat: 1 }))).jobs).toEqual([]);
    // without maxFormat the store has no format filter; a broken stamp is still never claimed
    expect(ids((await store.claim(SCOPE, claimReq())).jobs)).toEqual(['c2']);
    await expect(store.get(SCOPE, 'c4')).rejects.toBeInstanceOf(StoreFormatError);
  });

  it('memstore: update of priority re-buckets a waiting job (claim order)', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' }), newJob({ id: 'c' })]);
    await store.update(SCOPE, { id: 'b', expectedRev: 1, patch: { priority: 5 } });
    await store.update(SCOPE, { id: 'b', expectedRev: 2, patch: { priority: 0 } });
    await store.update(SCOPE, { id: 'c', expectedRev: 1, patch: { priority: 5 } });
    expect(ids((await store.claim(SCOPE, claimReq())).jobs)).toEqual(['c', 'a', 'b']);
  });

  it('memstore: unsafeMutate re-indexes so claim sees the new state', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob({ id: 'm' })]);
    store.unsafeMutate(SCOPE, 'm', { state: 'delayed', runAt: 5000 });
    expect((await store.claim(SCOPE, claimReq())).jobs).toEqual([]);
    store.unsafeMutate(SCOPE, 'm', { state: 'waiting' });
    store.unsafeMutate(SCOPE, 'm', { state: 'waiting' });
    store.unsafeMutate(SCOPE, 'm', { state: 'active', lease: { owner: 'w', token: 1, expiresAt: 9000, claimId: 'x' } });
    expect((await store.claim(SCOPE, claimReq())).jobs).toEqual([]);
    store.unsafeMutate(SCOPE, 'm', { state: 'waiting', lease: null });
    expect(ids((await store.claim(SCOPE, claimReq())).jobs)).toEqual(['m']);
  });

});

describe('claim (contract)', () => {

  it('claim: limit 0, over max and non-integer throw StoreRequestError', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob()]);
    const before = store.dump();
    const bad = [
      { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { leaseMs: 0 }, { leaseMsByName: { x: 0 } }, { hold: 'yes' },
      { leaseMs: Number.MAX_SAFE_INTEGER - 999 }, { leaseMsByName: { x: Number.MAX_SAFE_INTEGER - 999 } },
    ];
    for (const over of bad) {
      await expect(store.claim(SCOPE, claimReq(over as object)), JSON.stringify(over)).rejects.toBeInstanceOf(StoreRequestError);
    }
    expect(store.dump()).toEqual(before);
    const [j] = (await store.claim(SCOPE, claimReq({ leaseMs: Number.MAX_SAFE_INTEGER - 1000 }))).jobs;
    expect(j!.lease!.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  for (const title of [
    'claim: repeat with the same claimId returns the same jobs with recovered true and claims nothing new',
    'contract: claim repeated with the same claimId returns the same jobs with recovered true and claims nothing new',
  ]) {
    it(title, async () => {
      const store = await openStore({ clock: fakeClock(1000).clock });
      await store.add(SCOPE, ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => newJob({ id })));
      const req = claimReq({ limit: 2 });
      const first = await store.claim(SCOPE, req);
      const before = store.dump();
      const again = await store.claim(SCOPE, req);
      expect(again).toEqual({ ...first, recovered: true });
      expect(store.dump()).toEqual(before);
      expect((await store.counts(SCOPE)).active).toBe(2);
      await store.complete(SCOPE, { id: 'r1', token: first.jobs[0]!.token, result: null });
      expect(await store.claim(SCOPE, req)).toMatchObject({ jobs: [first.jobs[1]], recovered: true });
      await store.complete(SCOPE, { id: 'r2', token: first.jobs[1]!.token, result: null });
      const fresh = await store.claim(SCOPE, req);
      expect(ids(fresh.jobs)).toEqual(['r3', 'r4']);
      expect(fresh).not.toHaveProperty('recovered');
    });
  }

  it('claim: an expired lease is not recovered by a repeat with the same claimId', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' })]);
    const req = claimReq({ limit: 1, leaseMs: 100 });
    await store.claim(SCOPE, req);
    c.t = 1100;
    const res = await store.claim(SCOPE, req);
    expect(ids(res.jobs)).toEqual(['b']);
    expect(res).not.toHaveProperty('recovered');
  });

  it('memstore: a renew keeps the order a repeated claim returns its jobs in', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'r1' }), newJob({ id: 'r2' }), newJob({ id: 'r3' })]);
    const req = claimReq({ limit: 3 });
    const first = await store.claim(SCOPE, req);
    expect(ids(first.jobs)).toEqual(['r1', 'r2', 'r3']);
    expect(await store.renew(SCOPE, { id: 'r1', token: first.jobs[0]!.token, leaseMs: 60_000 })).toMatchObject({ ok: true });
    expect(ids((await store.claim(SCOPE, req)).jobs)).toEqual(['r1', 'r2', 'r3']);
  });

  it('memstore: a huge leaseMsByName is checked without overflowing the call stack', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ name: 'n0' })]);
    const leaseMsByName = Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`n${i}`, 1000]));
    expect((await store.claim(SCOPE, claimReq({ leaseMsByName }))).jobs).toHaveLength(1);
    const over = { ...leaseMsByName, n1: Number.MAX_SAFE_INTEGER };
    await expect(store.claim(SCOPE, claimReq({ leaseMsByName: over }))).rejects.toThrow(StoreRequestError);
  });

  it('memstore: a paused queue reports blocked only when it holds back a waiting job the claim could take', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.setPaused(SCOPE, true);
    await store.add(SCOPE, [newJob({ name: 'a', delayMs: 100 })]);
    const idle = await store.claim(SCOPE, claimReq());
    expect(idle).toMatchObject({ jobs: [], paused: false, nextRunAt: 1100 });
    expect(idle).not.toHaveProperty('blocked');
    c.t = 1100;
    expect(await store.claim(SCOPE, claimReq())).toMatchObject({ paused: true, blocked: { reason: 'paused' } });
    expect(await store.claim(SCOPE, claimReq({ names: ['b'] }))).not.toHaveProperty('blocked');
    expect(await store.claim(SCOPE, claimReq({ names: ['a'] }))).toMatchObject({ paused: true, blocked: { reason: 'paused' } });
  });

  for (const n of [2, 4]) {
    it(`claim: concurrent claimers never receive the same job (${n} claimers)`, async () => {
      const store = await openStore();
      for (let round = 0; round < 1000; round++) {
        await store.add(SCOPE, Array.from({ length: 5 }, () => newJob()));
        const res = await Promise.all(Array.from({ length: n }, (_, i) => store.claim(SCOPE, claimReq({ workerId: `p${i}`, limit: 2 }))));
        const got = res.flatMap((r) => ids(r.jobs));
        expect(new Set(got).size).toBe(got.length);
        await store.claim(SCOPE, claimReq({ limit: 10 }));
      }
    });
  }

});
