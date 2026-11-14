import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreRequestError } from '../../src/errors/catalog.js';
import type { JobRecord } from '../../src/store/contract.js';
import { SCOPE, claimReq, fakeClock, newJob, openStore } from '../helpers/store.js';

const ERR = '{"name":"Error","message":"boom"}';
const EXPIRED = { ok: false, reason: 'expired' };

afterEach(() => vi.restoreAllMocks());

/** A store at t=1000 with one job `a` claimed with a 1000 ms lease. */
async function claimed(opts: { finalsTtl?: number } = {}) {
  const { c, clock } = fakeClock(1000);
  const store = await openStore({ clock, ...opts });
  await store.add(SCOPE, [newJob({ id: 'a' })]);
  const [job] = (await store.claim(SCOPE, claimReq({ leaseMs: 1000, workerId: 'w1', claimId: 'k1' }))).jobs;
  return { c, store, job: job!, token: job!.token };
}

const rec = async (store: Awaited<ReturnType<typeof openStore>>, id = 'a') => (await store.get(SCOPE, id))!;

describe('lease (renew)', () => {

  it('lease: renew rejects bad requests with StoreRequestError before any change', async () => {
    const { store, token } = await claimed();
    const before = store.dump();
    for (const req of [
      { id: 'a', token, leaseMs: 0 }, { id: 'a', token, leaseMs: 1.5 }, { id: 'a', token }, { id: 'a', token, leaseMs: 10, batchId: 'b' }, { id: 'a', token, leaseMs: 10, started: 'yes' },
      { id: 'a', token, leaseMs: 10, started: 1 },
      { id: 'a', token, leaseMs: Number.MAX_SAFE_INTEGER - 999 },
    ]) {
      await expect(store.renew(SCOPE, req as never), JSON.stringify(req)).rejects.toBeInstanceOf(StoreRequestError);
    }
    expect(store.dump()).toEqual(before);
    expect(await store.renew(SCOPE, { id: 'a', token, leaseMs: Number.MAX_SAFE_INTEGER - 1000 })).toMatchObject({
      ok: true, expiresAt: Number.MAX_SAFE_INTEGER,
    });
  });

  it('lease: lease is cleared by complete, fail, release and cancel', async () => {
    const store = await openStore();
    await store.add(SCOPE, ['c', 'f', 'r', 'x'].map((id) => newJob({ id })));
    const req = claimReq();
    const tok = Object.fromEntries((await store.claim(SCOPE, req)).jobs.map((j) => [j.id, j.token]));
    await store.complete(SCOPE, { id: 'c', token: tok['c']!, result: null });
    await store.fail(SCOPE, { id: 'f', token: tok['f']!, error: ERR, retryInMs: 60_000 });
    await store.release(SCOPE, { id: 'r', token: tok['r']!, delayMs: 60_000, refundAttempt: false, handlerStarted: true });
    await store.cancel(SCOPE, { id: 'x' });
    expect(store.dump().jobs.map((j) => j.lease)).toEqual([null, null, null, null]);
    expect(await store.claim(SCOPE, req)).toMatchObject({ jobs: [] });
  });

  it('history: a renew sets lastRenewAt, and with started and batchId also batchId and heldMs', async () => {
    const { c, store, token } = await claimed();
    c.t += 100;
    await store.renew(SCOPE, { id: 'a', token, leaseMs: 1000 });
    expect((await store.getAttempts(SCOPE, { id: 'a' })).attempts[0]).toMatchObject({ lastRenewAt: 1100, batchId: null, heldMs: null });
    c.t += 150;
    expect(await store.renew(SCOPE, { id: 'a', token, leaseMs: 1000, started: true, batchId: 'b1' })).toMatchObject({ ok: true, now: 1250 });
    expect((await store.getAttempts(SCOPE, { id: 'a' })).attempts[0]).toMatchObject({ startedAt: 1000, lastRenewAt: 1250, batchId: 'b1', heldMs: 250 });
    c.t += 50;
    await store.renew(SCOPE, { id: 'a', token: token + 1, leaseMs: 1000, started: true, batchId: 'b2' });
    expect((await store.getAttempts(SCOPE, { id: 'a' })).attempts[0]).toMatchObject({ lastRenewAt: 1250, batchId: 'b1', heldMs: 250 });
  });
});

describe('fencing', () => {

  for (const [title, skew] of [
    ['fencing: expiry is judged by store time when pod clock is skewed ±1h (+1h)', 3_600_000],
    ['fencing: expiry is judged by store time when pod clock is skewed ±1h (-1h)', -3_600_000],
    ['clock: store time is unaffected by pod clock skew +1h', 3_600_000],
    ['clock: store time is unaffected by pod clock skew -1h', -3_600_000],
  ] as const) {
    it(title, async () => {
      const real = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(real + skew);
      const { c, store, token } = await claimed();
      expect(await store.now()).toBe(1000);
      c.t = 1999;
      expect(await store.renew(SCOPE, { id: 'a', token, leaseMs: 1 })).toMatchObject({ ok: true, now: 1999 });
      c.t = 2000;
      expect(await store.complete(SCOPE, { id: 'a', token, result: null })).toEqual(EXPIRED);
    });
  }
});

describe('clock', () => {
  it('clock: results carry the now that was used', async () => {
    const { c, store, token } = await claimed();
    await store.add(SCOPE, [newJob({ id: 'b' }), newJob({ id: 'r' })]);
    c.t = 1100;
    expect((await store.claim(SCOPE, claimReq({ limit: 2 }))).now).toBe(1100);
    const [b, r] = (await store.list(SCOPE, { state: 'active', offset: 0, limit: 10, order: 'asc', orderBy: 'startedAt' })).slice(1) as JobRecord[];
    c.t = 1200;
    expect((await store.renew(SCOPE, { id: 'a', token, leaseMs: 1000 })) as { now: number }).toMatchObject({ now: 1200 });
    c.t = 1300;
    expect(await store.complete(SCOPE, { id: 'a', token, result: null })).toMatchObject({ now: 1300 });
    c.t = 1400;
    expect(await store.fail(SCOPE, { id: b!.id, token: b!.token, error: ERR })).toMatchObject({ now: 1400 });
    c.t = 1500;
    expect(await store.release(SCOPE, { id: r!.id, token: r!.token, refundAttempt: false, handlerStarted: false })).toMatchObject({ now: 1500 });
    expect(await store.now()).toBe(1500);
  });

  it('clock: createdAt, startedAt and finishedAt are store instants', async () => {
    const { c, store, token } = await claimed();
    c.t = 1700;
    await store.complete(SCOPE, { id: 'a', token, result: null });
    expect(await rec(store)).toMatchObject({ createdAt: 1000, startedAt: 1000, finishedAt: 1700 });
  });

  it('clock: lease expiry and delayed due time use the same clock', async () => {
    const { c, store, token } = await claimed();
    await store.add(SCOPE, [newJob({ id: 'd', delayMs: 1000 })]);
    c.t = 2000;
    expect(await store.complete(SCOPE, { id: 'a', token, result: null })).toEqual(EXPIRED);
    expect((await rec(store, 'd')).state).toBe('waiting');
  });

  it('clock: delayMs and retryInMs are resolved against store time not request time', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock, faults: { before: (op) => void (op === 'fail' || op === 'release' ? (c.t += 500) : 0) } });
    await store.add(SCOPE, [newJob({ id: 'f' }), newJob({ id: 'r' })]);
    const [f, r] = (await store.claim(SCOPE, claimReq())).jobs;
    expect(await store.fail(SCOPE, { id: 'f', token: f!.token, error: ERR, retryInMs: 100 })).toMatchObject({ runAt: 1600, now: 1500 });
    expect(await store.release(SCOPE, { id: 'r', token: r!.token, delayMs: 100, refundAttempt: false, handlerStarted: false })).toMatchObject({
      runAt: 2100, now: 2000,
    });
  });
});
