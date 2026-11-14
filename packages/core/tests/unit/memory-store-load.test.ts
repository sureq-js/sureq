import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { SCOPE as scope, claimReq, expectConsistent, fakeClock, newJob, openStore } from '../helpers/store.js';

const LEASE = { leaseMs: 86_400_000 };
const serr = JSON.stringify({ v: 1, name: 'Error', message: 'x' });

describe('memstore (load)', () => {
  it('memstore: counts equal a full recount after random operations', async () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const take = <T>(xs: T[]): T => xs.splice(Math.floor(rnd() * xs.length), 1)[0]!;
    // a fenced write may meet a lease that expired or was swept meanwhile
    const fenced = (res: { ok: boolean; reason?: string }) => {
      if (!res.ok) expect(['expired', 'not-active', 'superseded']).toContain(res.reason);
    };
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    const active: Array<{ id: string; token: number }> = [];
    const known: string[] = [];
    for (let op = 1; op <= 10_000; op++) {
      const r = rnd();
      if (r < 0.25) {
        // a known id is a duplicate: ignored, replaced, or (once finished) reused with the old record moved to history
        const reuse = known.length > 0 && rnd() < 0.15;
        const j = newJob({
          ...(reuse && { id: pick(known), onDuplicate: rnd() < 0.5 ? 'replace' : 'ignore' }),
          priority: Math.floor(rnd() * 5) - 2, delayMs: rnd() < 0.3 ? Math.floor(rnd() * 200) : 0, first: rnd() < 0.1, name: rnd() < 0.5 ? null : 'n',
        });
        if (!reuse) known.push(j.id);
        await store.add(scope, [j]);
      } else if (r < 0.4) {
        const leaseMs = rnd() < 0.5 ? LEASE.leaseMs : 1 + Math.floor(rnd() * 100);
        const { jobs } = await store.claim(scope, claimReq({ leaseMs, limit: 3, order: rnd() < 0.5 ? 'fifo' : 'lifo' }));
        for (const got of jobs) active.push({ id: got.id, token: got.token });
      } else if (r < 0.5 && active.length) {
        fenced(await store.complete(scope, { ...take(active), result: null }));
      } else if (r < 0.58 && active.length) {
        fenced(await store.fail(scope, { ...take(active), error: serr, ...(rnd() < 0.5 && { retryInMs: Math.floor(rnd() * 100) }) }));
      } else if (r < 0.66 && active.length) {
        const delay = rnd() < 0.5 ? { delayMs: 1 + Math.floor(rnd() * 100) } : {};
        fenced(await store.release(scope, { ...take(active), refundAttempt: rnd() < 0.5, handlerStarted: false, ...delay }));
      } else if (r < 0.7) {
        await store.sweep(scope, { limit: 5, maxCrashes: 3, failError: serr, poisonError: serr });
      } else if (r < 0.76 && known.length) {
        const rec = await store.get(scope, pick(known));
        if (rec && (rec.state === 'waiting' || rec.state === 'delayed')) {
          const patch = rnd() < 0.5 ? { priority: Math.floor(rnd() * 5) - 2 } : { delayMs: Math.floor(rnd() * 100) };
          expect(await store.update(scope, { id: rec.id, expectedRev: rec.rev, patch })).toMatchObject({ ok: true });
        }
      } else if (r < 0.81 && known.length) {
        // An active job is refused; any other outcome is a bug.
        const res = await store.remove(scope, { id: pick(known) });
        if (!res.removed) expect(['active', 'not-found']).toContain(res.reason);
      } else if (r < 0.86 && known.length) {
        const res = await store.cancel(scope, { id: pick(known) });
        if (!res.ok) expect(['not-found', 'already-terminal']).toContain(res.reason);
      } else if (r < 0.9 && known.length) {
        const rec = await store.get(scope, pick(known));
        if (rec && (rec.state === 'waiting' || rec.state === 'delayed')) {
          const now = await store.now();
          store.unsafeMutate(scope, rec.id, rec.state === 'waiting' ? { state: 'delayed', runAt: now + 50 } : { state: 'waiting', runAt: now });
        }
      } else {
        c.t += Math.floor(rnd() * 50);
      }
      if (op % 100 === 0) await expectConsistent(store);
    }
    expect(store.dump().jobs.some((j) => j.id.includes('#'))).toBe(true);
    c.t += 1_000_000;
    await store.sweep(scope, { limit: 1000, maxCrashes: 3, failError: serr, poisonError: serr });
    const waiting = (await store.counts(scope)).waiting;
    const drained: string[] = [];
    for (let got = await store.claim(scope, claimReq({ ...LEASE, limit: 50 })); got.jobs.length; got = await store.claim(scope, claimReq({ ...LEASE, limit: 50 }))) {
      drained.push(...got.jobs.map((g) => g.id));
    }
    expect(drained.length).toBe(waiting);
    expect(new Set(drained).size).toBe(waiting);
  }, 30_000);

  it('memstore: 100k jobs processed with 4 simulated pods, none lost, none run twice', async () => {
    const store = new MemoryStore();
    await store.open();
    for (let b = 0; b < 100; b++) await store.add(scope, Array.from({ length: 1000 }, () => newJob()));
    const completed = new Map<string, number>();
    const pod = async (workerId: string) => {
      for (;;) {
        const { jobs } = await store.claim(scope, claimReq({ ...LEASE, workerId, limit: 25 }));
        if (!jobs.length) return;
        for (const g of jobs) {
          completed.set(g.id, (completed.get(g.id) ?? 0) + 1);
          await store.complete(scope, { id: g.id, token: g.token, result: null });
        }
      }
    };
    await Promise.all(['p1', 'p2', 'p3', 'p4'].map(pod));
    expect(completed.size).toBe(100_000);
    expect([...completed.values()].every((n) => n === 1)).toBe(true);
    expect((await store.counts(scope)).completed).toBe(100_000);
  }, 120_000);
});
