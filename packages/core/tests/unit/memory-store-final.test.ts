import { describe, expect, it } from 'vitest';
import { StoreRequestError } from '../../src/errors/catalog.js';
import { SCOPE, claimReq, fakeClock, newJob, openStore } from '../helpers/store.js';

const ERR = '{"name":"Error","message":"boom"}';

describe('memstore (complete, fail)', () => {
  it('memstore: complete and fail apply outcome atomically', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' })]);
    const [a] = (await store.claim(SCOPE, claimReq({ limit: 1 }))).jobs;
    c.t = 1500;
    expect(await store.complete(SCOPE, { id: 'a', token: a!.token, result: '"ok"' })).toEqual({ ok: true, now: 1500 });
    expect(await store.get(SCOPE, 'a')).toMatchObject({
      state: 'completed', result: '"ok"', finishedAt: 1500, lease: null, token: a!.token, workerId: 'w1', rev: a!.rev + 1,
      lastFinal: { token: a!.token, kind: 'complete', state: 'completed' },
    });
    const [b] = (await store.claim(SCOPE, claimReq({ limit: 1 }))).jobs;
    expect(await store.fail(SCOPE, { id: 'b', token: b!.token, error: ERR })).toEqual({ ok: true, state: 'failed', now: 1500 });
    expect(await store.get(SCOPE, 'b')).toMatchObject({ state: 'failed', error: ERR, finishedAt: 1500, lease: null, attempt: 1, rev: b!.rev + 1 });
  });

  it('memstore: fail with retry delay uses the store clock', async () => {
    const { c, clock } = fakeClock(5000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'r' }), newJob({ id: 'z' })]);
    const [r] = (await store.claim(SCOPE, claimReq({ limit: 1 }))).jobs;
    expect(await store.fail(SCOPE, { id: 'r', token: r!.token, error: ERR, retryInMs: 250 })).toEqual({
      ok: true, state: 'delayed', runAt: 5250, now: 5000,
    });
    expect(await store.get(SCOPE, 'r')).toMatchObject({ state: 'delayed', runAt: 5250, finishedAt: null });
    c.t = 5249;
    expect((await store.get(SCOPE, 'r'))!.state).toBe('delayed');
    c.t = 5250;
    expect((await store.get(SCOPE, 'r'))!.state).toBe('waiting');
    const [z] = (await store.claim(SCOPE, claimReq({ limit: 1 }))).jobs;
    await store.fail(SCOPE, { id: z!.id, token: z!.token, error: ERR, retryInMs: 0 });
    expect(await store.get(SCOPE, z!.id)).toMatchObject({ state: 'waiting', runAt: 5250 });
  });

  it('memstore: fail rejects a retryInMs that overflows the safe integer range', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob({ id: 'o' })]);
    const [j] = (await store.claim(SCOPE, claimReq())).jobs;
    await expect(store.fail(SCOPE, { id: 'o', token: j!.token, error: ERR, retryInMs: Number.MAX_SAFE_INTEGER })).rejects.toBeInstanceOf(
      StoreRequestError,
    );
    expect((await store.get(SCOPE, 'o'))!).toMatchObject({ state: 'active', rev: 2 });
  });

  it('memstore: deadLetter keepMs or a redrive delayMs that overflows the safe integer range is refused before any change', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob({ id: 'k', maxAttempts: 1 })]);
    const [j] = (await store.claim(SCOPE, claimReq())).jobs;
    const before = store.dump();
    const huge = Number.MAX_SAFE_INTEGER;
    await expect(store.fail(SCOPE, { id: 'k', token: j!.token, error: ERR, deadLetter: { keepMs: huge } })).rejects.toBeInstanceOf(StoreRequestError);
    expect(store.dump()).toEqual(before);
    await store.fail(SCOPE, { id: 'k', token: j!.token, error: ERR, deadLetter: {} });
    const failed = store.dump();
    await expect(store.redrive(SCOPE, { ids: ['k'], delayMs: huge, limit: 1 })).rejects.toBeInstanceOf(StoreRequestError);
    expect(store.dump()).toEqual(failed);
  });

  it('memstore: redrive clears progress and batchProgress', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob({ id: 'p', maxAttempts: 1 })]);
    const [j] = (await store.claim(SCOPE, claimReq())).jobs;
    store.unsafeMutate(SCOPE, 'p', { progress: { value: '50', updatedAt: 1000 }, batchProgress: { value: '3', updatedAt: 1000 } });
    await store.fail(SCOPE, { id: 'p', token: j!.token, error: ERR, deadLetter: {} });
    expect(await store.get(SCOPE, 'p')).toMatchObject({ progress: { value: '50' }, batchProgress: { value: '3' } });
    await store.redrive(SCOPE, { ids: ['p'], limit: 1 });
    expect(await store.get(SCOPE, 'p')).toMatchObject({ state: 'waiting', progress: null, batchProgress: null });
  });

  it('memstore: a repeat after the job was deleted returns the original outcome with repeated true within finalsTtl and not-active after it', async () => {
    const { c, clock } = fakeClock(10_000);
    const store = await openStore({ clock, finalsTtl: 1000 });
    await store.add(SCOPE, [newJob({ id: 'gone' }), newJob({ id: 'never' }), newJob({ id: 'retry' })]);
    const [g, r] = (await store.claim(SCOPE, claimReq({ limit: 2, names: [null] }))).jobs;
    await store.complete(SCOPE, { id: 'gone', token: g!.token, result: null });
    await store.fail(SCOPE, { id: 'never', token: r!.token, error: ERR, retryInMs: 5 });
    expect(await store.remove(SCOPE, { id: 'gone' })).toEqual({ removed: true, previousState: 'completed' });
    expect(await store.remove(SCOPE, { id: 'never' })).toEqual({ removed: true, previousState: 'delayed' });
    expect(await store.remove(SCOPE, { id: 'retry' })).toEqual({ removed: true, previousState: 'waiting' });
    expect(store.dump().tombstones.map((t) => t.id)).toEqual(['gone', 'never']);
    c.t = 10_999;
    expect(await store.complete(SCOPE, { id: 'gone', token: g!.token, result: null })).toEqual({ ok: true, now: 10_999, repeated: true });
    expect(await store.fail(SCOPE, { id: 'gone', token: g!.token, error: ERR })).toEqual({ ok: false, reason: 'not-active' });
    expect(await store.fail(SCOPE, { id: 'never', token: r!.token, error: ERR, retryInMs: 5 })).toEqual({
      ok: true, state: 'delayed', runAt: 10_005, now: 10_999, repeated: true,
    });
    c.t = 11_001;
    expect(await store.complete(SCOPE, { id: 'gone', token: g!.token, result: null })).toEqual({ ok: false, reason: 'not-active' });
    expect(await store.complete(SCOPE, { id: 'retry', token: 0, result: null })).toEqual({ ok: false, reason: 'not-active' });
  });

  it('contract: remove deletes non-active jobs and refuses active (active half)', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'act' })]);
    await store.claim(SCOPE, claimReq());
    const before = store.dump();
    expect(await store.remove(SCOPE, { id: 'act' })).toEqual({ removed: false, reason: 'active' });
    expect(store.dump()).toEqual(before);
  });

  it('contract: update applies on matching rev, conflict on stale rev, not-editable when active (active half)', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'act' })]);
    const [j] = (await store.claim(SCOPE, claimReq())).jobs;
    expect(await store.update(SCOPE, { id: 'act', expectedRev: j!.rev, patch: { priority: 1 } })).toEqual({ ok: false, reason: 'not-editable' });
  });
});

describe('memstore (release, repeats, tombstones)', () => {
  const rel = (id: string, token: number, over: Record<string, unknown> = {}) => ({ id, token, refundAttempt: false, handlerStarted: false, ...over });

  it('memstore: retainExpired deleting a live job and its expired superseded record leaves one tombstone, for the live id', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    const finish = async (retainMs: number) => {
      await store.add(SCOPE, [newJob({ id: 'r' })]);
      const [r] = (await store.claim(SCOPE, claimReq({ limit: 1 }))).jobs;
      await store.complete(SCOPE, { id: 'r', token: r!.token, result: null, retention: { retainMs } });
    };
    // the old record expires after the live one, so the live one comes first in the pick
    await finish(500_000);
    c.t = 2000;
    await finish(1000);
    // within finalsTtl of the live job's finish, so its tombstone is still worth writing
    c.t = 502_000;
    expect(await store.clean(SCOPE, { state: 'completed', retainExpired: true, limit: 10 })).toEqual({ removed: 2, remaining: false });
    expect(store.dump().jobs).toEqual([]);
    expect(store.dump().tombstones.map((t) => t.id)).toEqual(['r']);
  });

  it('memstore: a job deleted longer than finalsTtl after it finished leaves no tombstone', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock, finalsTtl: 1000 });
    await store.add(SCOPE, [newJob({ id: 'old' }), newJob({ id: 'new' })]);
    const [a, b] = (await store.claim(SCOPE, claimReq({ limit: 2, leaseMs: 3_600_000 }))).jobs;
    await store.complete(SCOPE, { id: 'old', token: a!.token, result: null });
    c.t += 1000;
    await store.complete(SCOPE, { id: 'new', token: b!.token, result: null });
    expect(await store.clean(SCOPE, { state: 'completed', olderThanMs: 0, limit: 10 })).toEqual({ removed: 2, remaining: false });
    expect(store.dump().tombstones.map((t) => t.id)).toEqual(['new']);
    expect(await store.complete(SCOPE, { id: 'old', token: a!.token, result: null })).toEqual({ ok: false, reason: 'not-active' });
  });

  it('contract: release with delayMs goes delayed, without goes waiting', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob({ id: 'd' }), newJob({ id: 'w' }), newJob({ id: 'z' })]);
    const [d, w, z] = (await store.claim(SCOPE, claimReq())).jobs;
    expect(await store.release(SCOPE, rel('d', d!.token, { delayMs: 500 }))).toEqual({ ok: true, state: 'delayed', runAt: 1500, now: 1000 });
    expect(await store.release(SCOPE, rel('w', w!.token))).toEqual({ ok: true, state: 'waiting', runAt: 1000, now: 1000 });
    expect(await store.release(SCOPE, rel('z', z!.token, { delayMs: 0 }))).toMatchObject({ state: 'waiting' });
    expect((await store.claim(SCOPE, claimReq())).jobs.map((j) => j.id)).toEqual(['w', 'z']);
  });

  it('memstore: release rejects bad requests with StoreRequestError before any change', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob({ id: 'a' })]);
    const [a] = (await store.claim(SCOPE, claimReq())).jobs;
    const before = store.dump();
    for (const over of [
      { reason: 'bogus' }, { reason: 'snooze' }, { started: true }, { refundAttempt: undefined }, { handlerStarted: 'yes' },
      { delayMs: -1 }, { delayMs: 1.5 }, { delayMs: Number.MAX_SAFE_INTEGER - 999 },
    ]) {
      await expect(store.release(SCOPE, rel('a', a!.token, over) as never), JSON.stringify(over)).rejects.toBeInstanceOf(StoreRequestError);
    }
    expect(store.dump()).toEqual(before);
  });

  for (const title of [
    'contract: complete, fail and release repeated with the same token return the original outcome with repeated true and change nothing, not even rev',
    'fencing: complete, fail and release repeated with the finalising token return the original outcome with repeated true',
  ]) {
    it(title, async () => {
      const { c, clock } = fakeClock(1000);
      const store = await openStore({ clock });
      await store.add(SCOPE, ['c', 'd', 'f', 'r'].map((id) => newJob({ id, ...(id === 'f' && { maxAttempts: 1 }) })));
      const tok = Object.fromEntries((await store.claim(SCOPE, claimReq({ leaseMs: 100 }))).jobs.map((j) => [j.id, j.token]));
      await store.complete(SCOPE, { id: 'c', token: tok['c']!, result: null });
      await store.fail(SCOPE, { id: 'd', token: tok['d']!, error: ERR, retryInMs: 5000 });
      await store.fail(SCOPE, { id: 'f', token: tok['f']!, error: ERR, retryInMs: 5000 });
      await store.release(SCOPE, rel('r', tok['r']!, { delayMs: 7000 }));
      c.t = 2000;
      const before = store.dump();
      expect(await store.complete(SCOPE, { id: 'c', token: tok['c']!, result: '"other"' })).toEqual({ ok: true, now: 2000, repeated: true });
      expect(await store.fail(SCOPE, { id: 'd', token: tok['d']!, error: ERR, retryInMs: 1 })).toEqual({
        ok: true, state: 'delayed', runAt: 6000, now: 2000, repeated: true,
      });
      expect(await store.fail(SCOPE, { id: 'f', token: tok['f']!, error: ERR })).toEqual({ ok: true, state: 'failed', now: 2000, repeated: true });
      expect(await store.release(SCOPE, rel('r', tok['r']!))).toEqual({ ok: true, state: 'delayed', runAt: 8000, now: 2000, repeated: true });
      expect(store.dump()).toEqual(before);
      expect(await store.complete(SCOPE, { id: 'f', token: tok['f']!, result: null })).toEqual({ ok: false, reason: 'not-active' });
      expect(await store.fail(SCOPE, { id: 'r', token: tok['r']!, error: ERR })).toEqual({ ok: false, reason: 'not-active' });
    });
  }

  it('contract: a repeat after the job was claimed again is rejected superseded', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' })]);
    const [a] = (await store.claim(SCOPE, claimReq())).jobs;
    await store.release(SCOPE, rel('a', a!.token));
    await store.claim(SCOPE, claimReq());
    expect(await store.release(SCOPE, rel('a', a!.token))).toEqual({ ok: false, reason: 'superseded' });
    const [b] = (await store.list(SCOPE, { state: 'active', offset: 0, limit: 1, order: 'asc' }));
    await store.fail(SCOPE, { id: 'a', token: b!.token, error: ERR, retryInMs: 0 });
    await store.claim(SCOPE, claimReq());
    expect(await store.fail(SCOPE, { id: 'a', token: b!.token, error: ERR, retryInMs: 0 })).toEqual({ ok: false, reason: 'superseded' });
  });

  it('contract: a repeat after removal returns the original outcome with repeated true while the tombstone lives (finalsTtl) and not-active after it expired', async () => {
    const { c, clock } = fakeClock(10_000);
    const store = await openStore({ clock, finalsTtl: 1000 });
    await store.add(SCOPE, [newJob({ id: 'r' }), newJob({ id: 'n' })]);
    const [r] = (await store.claim(SCOPE, claimReq({ limit: 1 }))).jobs;
    await store.release(SCOPE, rel('r', r!.token, { delayMs: 50 }));
    await store.remove(SCOPE, { id: 'r' });
    await store.remove(SCOPE, { id: 'n' });
    c.t = 10_999;
    expect(await store.release(SCOPE, rel('r', r!.token))).toEqual({ ok: true, state: 'delayed', runAt: 10_050, now: 10_999, repeated: true });
    expect(await store.complete(SCOPE, { id: 'n', token: 0, result: null })).toEqual({ ok: false, reason: 'not-active' });
    c.t = 11_001;
    expect(await store.release(SCOPE, rel('r', r!.token))).toEqual({ ok: false, reason: 'not-active' });
  });

  it('memstore: a repeat answers from the tombstone after the id was taken again, and other tokens still meet the live record', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' })]);
    const [a] = (await store.claim(SCOPE, claimReq())).jobs;
    await store.complete(SCOPE, { id: 'a', token: a!.token, result: null });
    await store.remove(SCOPE, { id: 'a' });
    await store.add(SCOPE, [newJob({ id: 'a' })]);
    expect(await store.complete(SCOPE, { id: 'a', token: a!.token, result: null })).toMatchObject({ ok: true, repeated: true });
    // a token neither job held is refused by the live record's rules
    expect(await store.complete(SCOPE, { id: 'a', token: a!.token + 100, result: null })).toEqual({ ok: false, reason: 'not-active' });
    expect((await store.get(SCOPE, 'a'))!.state).toBe('waiting');
  });

  it('memstore: a finished job superseded by a new add with its id leaves a tombstone, so a repeat of its last write still answers', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' })]);
    const [a] = (await store.claim(SCOPE, claimReq())).jobs;
    expect(await store.fail(SCOPE, { id: 'a', token: a!.token, error: ERR })).toMatchObject({ ok: true, state: 'failed' });
    await store.add(SCOPE, [newJob({ id: 'a' })]);
    const fresh = await store.get(SCOPE, 'a');
    expect(await store.fail(SCOPE, { id: 'a', token: a!.token, error: ERR })).toEqual({ ok: true, state: 'failed', now: expect.any(Number), repeated: true });
    expect(await store.get(SCOPE, 'a')).toEqual(fresh);
  });

  it('memstore: an atomic add refused after superseding a record also takes back the tombstone it left', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' })]);
    const [a] = (await store.claim(SCOPE, claimReq({ limit: 1 }))).jobs;
    await store.complete(SCOPE, { id: 'a', token: a!.token, result: null });
    const out = await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b', onDuplicate: 'reject' })], { atomic: true });
    expect(out.map((o) => o.status)).toEqual(['not-applied', 'duplicate']);
    expect(store.dump().tombstones).toEqual([]);
    expect((await store.get(SCOPE, 'a'))!.state).toBe('completed');
  });

  it('contract: rev increments by exactly one per mutation and not on reads or rejections', async () => {
    const store = await openStore();
    const rev = async () => (await store.get(SCOPE, 'a'))!.rev;
    const steps: Array<[string, () => Promise<unknown>, number]> = [];
    await store.add(SCOPE, [newJob({ id: 'a', maxAttempts: 5 })]);
    expect(await rev()).toBe(1);
    let token = 0;
    const claim = async () => void (token = (await store.claim(SCOPE, claimReq())).jobs[0]!.token);
    steps.push(
      ['claim', claim, 1],
      ['renew', () => store.renew(SCOPE, { id: 'a', token, leaseMs: 1000 }), 1],
      ['get, list, counts', async () => [await store.get(SCOPE, 'a'), await store.list(SCOPE, { state: 'active', offset: 0, limit: 5, order: 'asc' }), await store.counts(SCOPE)], 0],
      ['rejected renew', () => store.renew(SCOPE, { id: 'a', token: token + 1, leaseMs: 1000 }), 0],
      ['release', () => store.release(SCOPE, rel('a', token)), 1],
      ['repeated release', () => store.release(SCOPE, rel('a', token)), 0],
      ['update', async () => store.update(SCOPE, { id: 'a', expectedRev: await rev(), patch: { priority: 2 } }), 1],
      ['claim', claim, 1],
      ['fail', () => store.fail(SCOPE, { id: 'a', token, error: ERR, retryInMs: 0 }), 1],
      ['claim', claim, 1],
      ['complete', () => store.complete(SCOPE, { id: 'a', token, result: null }), 1],
      ['repeated complete', () => store.complete(SCOPE, { id: 'a', token, result: null }), 0],
      ['rejected fail', () => store.fail(SCOPE, { id: 'a', token, error: ERR }), 0],
    );
    for (const [what, step, delta] of steps) {
      const before = await rev();
      await step();
      expect(await rev(), what).toBe(before + delta);
    }
    await store.add(SCOPE, [newJob({ id: 'x' })]);
    await store.cancel(SCOPE, { id: 'x' });
    expect((await store.get(SCOPE, 'x'))!.rev).toBe(2);
  });
});
