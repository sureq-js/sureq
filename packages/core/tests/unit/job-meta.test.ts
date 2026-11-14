import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import type { JobRecord } from '../../src/store/contract.js';
import { SCOPE as scope, claimReq, newJob as job } from '../helpers/store.js';

const err = JSON.stringify({ v: 1, name: 'E', message: 'x' });
const setup = (start = 1000) => {
  const c = { t: start };
  const store = new MemoryStore({ clock: () => c.t });
  void store.open();
  const claim = async (workerId = 'w1', limit = 1) => (await store.claim(scope, claimReq({ workerId, limit }))).jobs;
  const rec = async (id: string) => (await store.get(scope, id))!;
  return { c, store, claim, rec };
};

afterEach(() => {
  vi.useRealTimers();
});

/** Every metadata invariant for one record. */
function assertInvariants(r: JobRecord): void {
  const times = [r.createdAt, r.runAt, r.startedAt, r.finishedAt].filter((x): x is number => x !== null);
  for (const t of times) expect(Number.isInteger(t), `${r.id} time`).toBe(true);
  if (r.startedAt !== null) expect(r.createdAt).toBeLessThanOrEqual(r.startedAt);
  if (r.startedAt !== null && r.finishedAt !== null) expect(r.startedAt).toBeLessThanOrEqual(r.finishedAt);
  if (r.state === 'active') {
    expect(r.startedAt, r.id).not.toBeNull();
    expect(r.workerId, r.id).not.toBeNull();
  }
  if ((r.state === 'waiting' || r.state === 'delayed') && r.attempt === 0) {
    expect(r.startedAt).toBeNull();
    expect(r.workerId).toBeNull();
  }
  if (r.state === 'completed' || r.state === 'failed' || r.state === 'cancelled') {
    expect(r.finishedAt, r.id).not.toBeNull();
    expect(r.lease).toBeNull();
  }
  expect(r.attempt).toBeLessThanOrEqual(r.maxAttempts);
}

describe('meta (store-set fields)', () => {
  it('meta: createdAt is store time at add and never changes', async () => {
    const { c, store, claim, rec } = setup(1000);
    await store.add(scope, [job({ id: 'a' })]);
    c.t = 2000;
    const [a] = await claim();
    await store.fail(scope, { id: 'a', token: a!.token, error: err, retryInMs: 10 });
    c.t = 3000;
    const [a2] = await claim();
    await store.complete(scope, { id: 'a', token: a2!.token, result: null });
    expect((await rec('a')).createdAt).toBe(1000);
  });

  it('meta: claim sets attempt, startedAt and workerId atomically', async () => {
    const { c, store, claim } = setup(1000);
    await store.add(scope, [job({ id: 'b' })]);
    const before = store.dump().jobs[0]!;
    expect([before.attempt, before.startedAt, before.workerId]).toEqual([0, null, null]);
    c.t = 2000;
    await claim('w1');
    const after = store.dump().jobs[0]!;
    expect([after.attempt, after.startedAt, after.workerId, after.state]).toEqual([1, 2000, 'w1', 'active']);
  });

  it('meta: complete and fail set finishedAt; retry leaves it null', async () => {
    const { c, store, claim, rec } = setup(1000);
    await store.add(scope, [job({ id: 'ok' }), job({ id: 'bad' }), job({ id: 'again' })]);
    const [ok, bad, again] = await claim('w1', 3);
    c.t = 3000;
    await store.complete(scope, { id: 'ok', token: ok!.token, result: null });
    await store.fail(scope, { id: 'bad', token: bad!.token, error: err });
    await store.fail(scope, { id: 'again', token: again!.token, error: err, retryInMs: 500 });
    expect((await rec('ok')).finishedAt).toBe(3000);
    expect((await rec('bad')).finishedAt).toBe(3000);
    expect((await rec('again')).finishedAt).toBeNull();
  });

  it('meta: retry resets startedAt on next claim, keeps createdAt', async () => {
    const { c, store, claim, rec } = setup(1000);
    await store.add(scope, [job({ id: 'r' })]);
    c.t = 2000;
    const [r] = await claim();
    await store.fail(scope, { id: 'r', token: r!.token, error: err, retryInMs: 100 });
    expect(await rec('r')).toMatchObject({ startedAt: 2000, finishedAt: null });
    c.t = 2100;
    await claim();
    expect(await rec('r')).toMatchObject({ startedAt: 2100, createdAt: 1000, attempt: 2 });
  });

  it('meta: finished job still reports the worker that ran it', async () => {
    const { store, claim } = setup();
    await store.add(scope, [job({ id: 'w' })]);
    const [w] = await claim('w1');
    await store.complete(scope, { id: 'w', token: w!.token, result: null });
    const stored = store.dump().jobs[0]!;
    expect([stored.workerId, stored.lease, stored.token]).toEqual(['w1', null, w!.token]);
  });

  it('meta: timestamp ordering invariant holds across 1000 random jobs', async () => {
    let seed = 5;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const { c, store } = setup(10_000);
    const active: Array<{ id: string; token: number; attempt: number; maxAttempts: number }> = [];
    let added = 0;
    for (let op = 0; added < 1000 || active.length; op++) {
      const r = rnd();
      if (r < 0.3 && added < 1000) {
        await store.add(scope, [job({ maxAttempts: 1 + Math.floor(rnd() * 3), delayMs: rnd() < 0.2 ? 20 : 0 })]);
        added++;
      } else if (r < 0.55) {
        for (const x of (await store.claim(scope, claimReq({ workerId: `w${Math.floor(rnd() * 3)}`, limit: 2 }))).jobs) {
          active.push({ id: x.id, token: x.token, attempt: x.attempt, maxAttempts: x.maxAttempts });
        }
      } else if (r < 0.75 && active.length) {
        const { id, token } = active.splice(Math.floor(rnd() * active.length), 1)[0]!;
        await store.complete(scope, { id, token, result: null });
      } else if (r < 0.9 && active.length) {
        const a = active.splice(Math.floor(rnd() * active.length), 1)[0]!;
        const retry = a.attempt < a.maxAttempts && rnd() < 0.7;
        await store.fail(scope, { id: a.id, token: a.token, error: err, ...(retry && { retryInMs: 5 }) });
      } else {
        c.t += rnd() < 0.2 ? -Math.floor(rnd() * 500) : Math.floor(rnd() * 50); // includes backwards jumps
      }
      if (op % 50 === 0) for (const rec of store.dump().jobs) assertInvariants(rec);
      if (op > 200_000) break;
    }
    for (const rec of store.dump().jobs) assertInvariants(rec);
  }, 30_000);

  it('meta: attempt never exceeds maxAttempts', async () => {
    const { store, claim, rec } = setup();
    await store.add(scope, [job({ id: 'twice', maxAttempts: 2 })]);
    const [a1] = await claim();
    await store.fail(scope, { id: 'twice', token: a1!.token, error: err, retryInMs: 0 });
    const [a2] = await claim();
    await store.fail(scope, { id: 'twice', token: a2!.token, error: err });
    expect(await rec('twice')).toMatchObject({ state: 'failed', attempt: 2 });
    expect(await claim()).toEqual([]);
  });

  it('meta: pod clock skew of ±1h does not change any timestamp', async () => {
    vi.useFakeTimers();
    const { c, store, claim, rec } = setup(50_000);
    vi.setSystemTime(Date.now() + 3_600_000);
    await store.add(scope, [job({ id: 'sk' })]);
    vi.setSystemTime(Date.now() - 7_200_000);
    c.t = 51_000;
    const [s] = await claim();
    vi.setSystemTime(Date.now() + 3_600_000);
    c.t = 52_000;
    await store.complete(scope, { id: 'sk', token: s!.token, result: null });
    expect(await rec('sk')).toMatchObject({ createdAt: 50_000, startedAt: 51_000, finishedAt: 52_000 });
  });

  it('meta: store clock going backwards is clamped to the previous timestamp and never throws', async () => {
    const { c, store, claim, rec } = setup(1000);
    await store.add(scope, [job({ id: 'back' })]);
    c.t = 5000;
    const [b] = await claim();
    c.t = 100;
    await expect(store.complete(scope, { id: 'back', token: b!.token, result: null })).resolves.toMatchObject({ ok: true });
    const r = await rec('back');
    expect(r.finishedAt).toBe(5000);
    expect(r.startedAt!).toBeLessThanOrEqual(r.finishedAt!);
  });
});
