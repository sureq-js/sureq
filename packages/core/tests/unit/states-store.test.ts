import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { canTransition, effectiveState } from '../../src/job/states.js';
import type { JobRecord } from '../../src/store/contract.js';
import { SCOPE as scope, ZERO, added, claimReq, newJob as job } from '../helpers/store.js';

const err = JSON.stringify({ v: 1, name: 'E', message: 'x' });
const setup = (start = 1000) => {
  const c = { t: start };
  const store = new MemoryStore({ clock: () => c.t });
  void store.open();
  const claim = async (limit = 1) => (await store.claim(scope, claimReq({ workerId: 'w', limit }))).jobs;
  return { c, store, claim };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('states (store)', () => {
  it('states: add without delay creates waiting with attempt 0', async () => {
    const { store } = setup();
    const [o] = added(await store.add(scope, [job()]));
    expect(o).toMatchObject({ state: 'waiting', attempt: 0 });
    expect(o!.runAt).toBe(o!.createdAt);
  });

  it('states: add with delay creates delayed; reads as waiting once runAt passes', async () => {
    const { c, store } = setup(1000);
    await store.add(scope, [job({ id: 'd', delayMs: 100 })]);
    c.t = 1099;
    expect(await store.get(scope, 'd')).toMatchObject({ state: 'delayed', attempt: 0 });
    expect((await store.list(scope, { state: 'delayed', offset: 0, limit: 5, order: 'asc' })).map((r) => r.id)).toEqual(['d']);
    expect(await store.counts(scope)).toEqual({ ...ZERO, delayed: 1 });
    c.t = 1100;
    expect((await store.get(scope, 'd'))!.state).toBe('waiting');
    expect(await store.counts(scope)).toEqual({ ...ZERO, waiting: 1 });
  });

  it('states: claim moves waiting to active and increments attempt', async () => {
    const { store, claim } = setup();
    await store.add(scope, [job()]);
    expect((await claim())[0]).toMatchObject({ state: 'active', attempt: 1 });
  });

  it('states: complete moves active to completed with result and finishedAt', async () => {
    const { c, store, claim } = setup();
    await store.add(scope, [job({ id: 'k' })]);
    const [k] = await claim();
    c.t = 4000;
    await store.complete(scope, { id: 'k', token: k!.token, result: '7' });
    expect(await store.get(scope, 'k')).toMatchObject({ state: 'completed', result: '7', finishedAt: 4000 });
  });

  it('states: failure with attempts left moves active to delayed with attempt unchanged', async () => {
    const { store, claim } = setup(2000);
    await store.add(scope, [job({ id: 'r' }), job({ id: 'z' })]);
    const [r] = await claim();
    await store.fail(scope, { id: 'r', token: r!.token, error: err, retryInMs: 500 });
    expect(await store.get(scope, 'r')).toMatchObject({ state: 'delayed', attempt: 1, runAt: 2500 });
    const [z] = await claim();
    await store.fail(scope, { id: z!.id, token: z!.token, error: err, retryInMs: 0 });
    expect(await store.get(scope, z!.id)).toMatchObject({ state: 'waiting', attempt: 1 });
  });

  it('states: failure on last attempt moves active to failed', async () => {
    const { store, claim } = setup();
    await store.add(scope, [job({ id: 'l' })]);
    const [l] = await claim();
    await store.fail(scope, { id: 'l', token: l!.token, error: err });
    const rec = store.dump().jobs.find((j) => j.id === 'l')!;
    expect(rec.state).toBe('failed');
    expect(rec.finishedAt).not.toBeNull();
    expect(rec.lastFinal?.state).toBe('failed');
  });

  it('states: waiting-for-retry job is delayed with attempt at least 1', async () => {
    const { store, claim } = setup();
    await store.add(scope, [job({ id: 'retry' }), job({ id: 'fresh', delayMs: 1000 })]);
    const [r] = await claim();
    await store.fail(scope, { id: 'retry', token: r!.token, error: err, retryInMs: 1000 });
    expect((await store.get(scope, 'retry'))!.attempt).toBeGreaterThanOrEqual(1);
    expect(await store.get(scope, 'fresh')).toMatchObject({ state: 'delayed', attempt: 0 });
  });

  it('states: terminal states never change except via explicit retry', async () => {
    const { store, claim } = setup();
    await store.add(scope, [job({ id: 'done' }), job({ id: 'dead' })]);
    const [d1, d2] = await claim(2);
    await store.complete(scope, { id: 'done', token: d1!.token, result: null });
    await store.fail(scope, { id: 'dead', token: d2!.token, error: err });
    const before = store.dump();
    expect(await store.complete(scope, { id: 'done', token: 999, result: null })).toEqual({ ok: false, reason: 'not-active' });
    expect(await store.fail(scope, { id: 'dead', token: 999, error: err })).toEqual({ ok: false, reason: 'not-active' });
    expect(await claim(10)).toEqual([]);
    expect(store.dump()).toEqual(before);
    expect(await store.remove(scope, { id: 'done' })).toMatchObject({ removed: true });
  });

  it('states: illegal transitions are rejected and change nothing', async () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const { c, store } = setup();
    const active: Array<{ id: string; token: number }> = [];
    const ids: string[] = [];
    const view = (now: number) => new Map(store.dump().jobs.map((j: JobRecord) => [j.id, effectiveState(j, now)]));
    const STATES = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const;
    // Reachable through the table (a fail with retryInMs 0 reads as waiting at once: active → delayed → waiting).
    const reachable = (from: string, to: string): boolean => {
      const seen = new Set([from]);
      for (let frontier = [from]; frontier.length; ) {
        frontier = frontier.flatMap((s) => STATES.filter((t) => canTransition(s as never, t) && !seen.has(t)));
        frontier.forEach((t) => seen.add(t));
      }
      return seen.has(to);
    };
    const stateOf = async (id: string) => {
      const rec = await store.get(scope, id);
      return rec ? effectiveState(rec, await store.now()) : undefined;
    };
    let snapshot = view(await store.now());
    /** Check the op's own target: its state before and after must be reachable in the table. */
    const checked = async (id: string, op: () => Promise<unknown>) => {
      const from = await stateOf(id);
      await op();
      const to = await stateOf(id);
      if (from !== undefined && to !== undefined) expect(reachable(from, to), `${id}: ${from} -> ${to}`).toBe(true);
    };
    for (let op = 0; op < 10_000; op++) {
      const r = rnd();
      if (r < 0.35) {
        const j = job({ delayMs: rnd() < 0.3 ? 30 : 0 });
        ids.push(j.id);
        await store.add(scope, [j]);
      } else if (r < 0.55) {
        for (const x of (await store.claim(scope, claimReq({ workerId: 'w', limit: 2 }))).jobs) {
          expect(x.state).toBe('active');
          active.push({ id: x.id, token: x.token });
        }
      } else if (r < 0.7 && active.length) {
        const a = active.splice(Math.floor(rnd() * active.length), 1)[0]!;
        await checked(a.id, () => store.complete(scope, { ...a, result: null }));
      } else if (r < 0.85 && active.length) {
        const a = active.splice(Math.floor(rnd() * active.length), 1)[0]!;
        await checked(a.id, () => store.fail(scope, { ...a, error: err, ...(rnd() < 0.5 && { retryInMs: Math.floor(rnd() * 20) }) }));
      } else if (r < 0.92 && ids.length) {
        // An active job is refused; nothing else may throw.
        const res = await store.remove(scope, { id: ids[Math.floor(rnd() * ids.length)]! });
        expect(res.removed || ['active', 'not-found'].includes(res.reason)).toBe(true);
      } else {
        c.t += Math.floor(rnd() * 40);
      }
      if (op % 100 === 99) {
        const next = view(await store.now());
        for (const [id, from] of snapshot) {
          const to = next.get(id);
          if (to !== undefined) expect(reachable(from, to), `${id}: ${from} -> ${to}`).toBe(true);
        }
        snapshot = next;
      }
    }
    const fresh = job({ id: 'planted' });
    await store.add(scope, [fresh]);
    store.unsafeMutate(scope, 'planted', { state: 'completed' });
    expect((await store.claim(scope, claimReq({ workerId: 'w', limit: 1000 }))).jobs.map((x) => x.id)).not.toContain('planted');
    expect(await store.complete(scope, { id: 'planted', token: 0, result: null })).toEqual({ ok: false, reason: 'not-active' });
  }, 60_000);

  it('states: concurrent claim and remove — exactly one wins', async () => {
    for (let i = 0; i < 1000; i++) {
      const { store, claim } = setup();
      const j = job();
      await store.add(scope, [j]);
      // remove of an active job is refused, so a lost race shows up as reason 'active'.
      const [claimed, res] = await Promise.all([claim(), store.remove(scope, { id: j.id })]);
      const removed = res.removed;
      if (!res.removed) expect(res.reason).toBe('active');
      const claimWon = claimed.length === 1;
      expect(claimWon !== removed).toBe(true);
      const counts = await store.counts(scope);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (claimWon) {
        expect((await store.get(scope, j.id))!.state).toBe('active');
        expect(total).toBe(1);
      } else {
        expect(await store.get(scope, j.id)).toBeNull();
        expect(total).toBe(0);
      }
    }
  });

  it('states: delayed job whose runAt passed is claimed without any timer', async () => {
    vi.useFakeTimers();
    const { c, store, claim } = setup(1000);
    await store.add(scope, [job({ id: 'later', delayMs: 250 })]);
    expect(vi.getTimerCount()).toBe(0);
    c.t = 1250;
    expect((await claim()).map((x) => x.id)).toEqual(['later']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
