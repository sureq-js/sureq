import { describe, expect, it } from 'vitest';
import { StoreRequestError } from '../../src/errors/catalog.js';
import type { SweepRequest } from '../../src/store/contract.js';
import { SCOPE, claimReq, fakeClock, newJob, openStore } from '../helpers/store.js';

const FAIL_ERR = '{"name":"AttemptsExhausted"}';
const POISON = new Uint8Array([0xde, 0xad]);
const sweepReq = (over: Partial<SweepRequest> = {}): SweepRequest => ({
  limit: 100, maxCrashes: 3, failError: FAIL_ERR, poisonError: POISON, ...over,
});

/** A store at t=1000 with `ids` claimed by `w1` with a 1000 ms lease (expiry 2000). */
async function setup(ids: string[] = ['a'], job: { maxAttempts?: number } = {}) {
  const { c, clock } = fakeClock(1000);
  const store = await openStore({ clock });
  await store.add(SCOPE, ids.map((id) => newJob({ id, ...job })));
  const jobs = (await store.claim(SCOPE, claimReq({ leaseMs: 1000 }))).jobs;
  return { c, store, jobs, token: jobs[0]?.token ?? 0 };
}

describe('sweep', () => {

  for (const title of ['sweep: live lease is never touched', 'lease: active jobs with live leases are never returned by sweep']) {
    it(title, async () => {
      const { c, store } = await setup(['a', 'b']);
      c.t = 1999;
      const before = store.dump();
      expect(await store.sweep(SCOPE, sweepReq())).toEqual({ swept: [], now: 1999 });
      expect(store.dump()).toEqual(before);
    });
  }

  it('lease: renew and sweep decide by store time at the exact boundary', async () => {
    const atBoundary = await setup();
    atBoundary.c.t = 2000;
    expect((await atBoundary.store.sweep(SCOPE, sweepReq())).swept).toHaveLength(1);
    expect(await atBoundary.store.renew(SCOPE, { id: 'a', token: atBoundary.token, leaseMs: 1000 })).toEqual({ ok: false, reason: 'not-active' });
    const renewFirst = await setup();
    renewFirst.c.t = 2000;
    expect(await renewFirst.store.renew(SCOPE, { id: 'a', token: renewFirst.token, leaseMs: 1000 })).toEqual({ ok: false, reason: 'expired' });
    expect((await renewFirst.store.sweep(SCOPE, sweepReq())).swept).toHaveLength(1);
    const earlier = await setup();
    earlier.c.t = 1999;
    expect(await earlier.store.renew(SCOPE, { id: 'a', token: earlier.token, leaseMs: 1000 })).toMatchObject({ ok: true, expiresAt: 2999 });
    earlier.c.t = 2000;
    expect((await earlier.store.sweep(SCOPE, sweepReq())).swept).toEqual([]);
  });

  it('lease: renew with a shorter leaseMs moves the expiry earlier and sweep follows it', async () => {
    const { c, store, token } = await setup();
    c.t = 1100;
    await store.renew(SCOPE, { id: 'a', token, leaseMs: 200 });
    c.t = 1299;
    expect((await store.sweep(SCOPE, sweepReq())).swept).toEqual([]);
    c.t = 1300;
    expect((await store.sweep(SCOPE, sweepReq())).swept).toMatchObject([{ id: 'a', action: 'requeued' }]);
  });

  for (const title of [
    'sweep: job reaching maxCrashes is failed with poisonError, also when maxAttempts is used up too',
    'poison: sweep at crashCount reaching maxCrashes fails the job with the poison payload',
  ]) {
    it(title, async () => {
      for (const maxAttempts of [5, 2]) {
        const { c, store } = await setup(['a'], { maxAttempts });
        c.t = 2000;
        expect((await store.sweep(SCOPE, sweepReq({ maxCrashes: 2 }))).swept[0]!.action).toBe('requeued');
        await store.claim(SCOPE, claimReq({ leaseMs: 1000 }));
        c.t = 3000;
        expect((await store.sweep(SCOPE, sweepReq({ maxCrashes: 2 }))).swept).toMatchObject([{ action: 'failed', attempt: 2, crashCount: 2 }]);
        const rec = (await store.get(SCOPE, 'a'))!;
        expect(rec).toMatchObject({ state: 'failed', finishedAt: 3000 });
        expect(rec.error).toEqual(new Uint8Array([0xde, 0xad]));
      }
    });
  }

  it('poison: maxCrashes 1 fails on the first crash', async () => {
    const { c, store } = await setup(['a'], { maxAttempts: 10 });
    c.t = 2000;
    expect((await store.sweep(SCOPE, sweepReq({ maxCrashes: 1 }))).swept).toMatchObject([{ action: 'failed', crashCount: 1 }]);
  });

  for (const title of [
    'sweep: requeued job is claimable at once and its next claim gets a larger token',
    'fencing: re-claim after sweep issues a larger token than the first claim',
  ]) {
    it(title, async () => {
      const { c, store, token } = await setup();
      c.t = 2000;
      await store.sweep(SCOPE, sweepReq());
      const [again] = (await store.claim(SCOPE, claimReq())).jobs;
      expect(again).toMatchObject({ id: 'a', attempt: 2, crashCount: 1 });
      expect(again!.token).toBeGreaterThan(token);
    });
  }

  it('claim: a repeat with the same claimId after the leases expired and were swept claims normally', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' })]);
    const req = claimReq({ limit: 1, leaseMs: 1000 });
    const first = await store.claim(SCOPE, req);
    c.t = 2000;
    await store.sweep(SCOPE, sweepReq());
    const again = await store.claim(SCOPE, req);
    expect(again).not.toHaveProperty('recovered');
    expect(again.jobs.map((j) => j.id)).toEqual(['a']);
    expect(again.jobs[0]!.token).toBeGreaterThan(first.jobs[0]!.token);
    expect(again.jobs[0]).toMatchObject({ attempt: 2, crashCount: 1 });
  });

  it('lease: lease is cleared by sweep', async () => {
    const { c, store } = await setup();
    c.t = 2000;
    await store.sweep(SCOPE, sweepReq());
    expect((await store.get(SCOPE, 'a'))!.lease).toBeNull();
    expect((await store.sweep(SCOPE, sweepReq())).swept).toEqual([]);
  });

  for (const title of ['sweep: sweep does not undo a renew that landed first', 'fencing: sweep does not undo a renew that landed first']) {
    it(title, async () => {
      const { c, store, token } = await setup();
      c.t = 1999;
      const [renewed, swept] = await Promise.all([store.renew(SCOPE, { id: 'a', token, leaseMs: 1000 }), store.sweep(SCOPE, sweepReq())]);
      expect(renewed).toMatchObject({ ok: true });
      expect(swept.swept).toEqual([]);
      c.t = 2500;
      expect((await store.sweep(SCOPE, sweepReq())).swept).toEqual([]);
      expect(await store.complete(SCOPE, { id: 'a', token, result: null })).toMatchObject({ ok: true });
    });
  }

  it('sweep: invalid limit or maxCrashes throws StoreRequestError', async () => {
    const { c, store } = await setup();
    c.t = 2000;
    const before = store.dump();
    const { failError: _f, ...noFailError } = sweepReq();
    for (const req of [
      sweepReq({ limit: 0 }), sweepReq({ limit: 1001 }), sweepReq({ limit: 1.5 }), sweepReq({ maxCrashes: 0 }), noFailError,
      { ...sweepReq(), poisonError: 5 }, { ...sweepReq(), retention: 1 },
    ]) {
      await expect(store.sweep(SCOPE, req as SweepRequest), JSON.stringify(req)).rejects.toBeInstanceOf(StoreRequestError);
    }
    expect(store.dump()).toEqual(before);
  });

  for (const title of ['sweep: concurrent sweepers count each crash exactly once', 'poison: two concurrent sweeps increment crashCount once']) {
    it(title, async () => {
      const { c, clock } = fakeClock(1000);
      const store = await openStore({ clock });
      for (let round = 0; round < 1000; round++) {
        const job = newJob({ maxAttempts: 10 });
        await store.add(SCOPE, [job]);
        await store.claim(SCOPE, claimReq({ leaseMs: 10 }));
        c.t += 10;
        const [x, y] = await Promise.all([store.sweep(SCOPE, sweepReq()), store.sweep(SCOPE, sweepReq())]);
        expect(x.swept.length + y.swept.length).toBe(1);
        expect((await store.get(SCOPE, job.id))!.crashCount).toBe(1);
        await store.cancel(SCOPE, { id: job.id });
      }
    });
  }

  it('memstore: unsafeMutate re-indexes so a lease-expiry scan finds the planted lease, without bumping rev', async () => {
    const { store, jobs } = await setup();
    store.unsafeMutate(SCOPE, 'a', { lease: { ...jobs[0]!.lease!, expiresAt: 500 } });
    expect((await store.get(SCOPE, 'a'))!.rev).toBe(jobs[0]!.rev);
    expect((await store.sweep(SCOPE, sweepReq())).swept.map((x) => x.id)).toEqual(['a']);
  });
});
