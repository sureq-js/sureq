import { describe, expect, it } from 'vitest';
import { StoreRequestError } from '../../src/errors/catalog.js';
import type { Scope } from '../../src/store/contract.js';
import { SCOPE, claimReq, fakeClock, newJob, openStore } from '../helpers/store.js';

const SWEEP = { limit: 10, maxCrashes: 3, failError: 'f', poisonError: 'p' };
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('memstore (subscribe)', () => {
  it('contract: subscribe delivers a wake on add and unsubscribe stops it', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    const other: Scope = { namespace: 'n', queue: 'other' };
    let wakes = 0;
    let otherWakes = 0;
    const off = await store.subscribe(SCOPE, () => void wakes++);
    await store.subscribe(other, () => void otherWakes++);
    const expectWakes = async (n: number, what: string) => {
      await tick();
      expect(wakes, what).toBe(n);
      wakes = 0;
    };
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' }), newJob({ id: 'c' })]);
    await expectWakes(1, 'add');
    const [a, b, cc] = (await store.claim(SCOPE, claimReq({ leaseMs: 100 }))).jobs;
    await expectWakes(0, 'claim');
    await store.complete(SCOPE, { id: 'a', token: a!.token, result: null });
    await store.release(SCOPE, { id: 'c', token: cc!.token, delayMs: 50, refundAttempt: false, handlerStarted: false });
    await store.cancel(SCOPE, { id: 'c' });
    await store.setPaused(SCOPE, true);
    await expectWakes(0, 'complete, delayed release, cancel, pause');
    await store.setPaused(SCOPE, false);
    await expectWakes(1, 'resume');
    await store.setPaused(SCOPE, false);
    await expectWakes(0, 'resume without change');
    await store.release(SCOPE, { id: 'b', token: b!.token, refundAttempt: false, handlerStarted: false });
    await expectWakes(1, 'release to waiting');
    await store.claim(SCOPE, claimReq({ leaseMs: 100 }));
    c.t = 1100;
    await store.sweep(SCOPE, SWEEP);
    await expectWakes(1, 'sweep requeue');
    expect(otherWakes).toBe(0);
    await off();
    await off();
    await store.add(SCOPE, [newJob()]);
    await expectWakes(0, 'after unsubscribe');
  });

  it('memstore: a throwing wake handler does not break the write and wakes coalesce', async () => {
    const store = await openStore();
    let good = 0;
    await store.subscribe(SCOPE, () => {
      throw new TypeError('bad subscriber');
    });
    await store.subscribe(SCOPE, () => void good++);
    const results = await Promise.all(Array.from({ length: 10 }, () => store.add(SCOPE, [newJob()])));
    expect(results.every((r) => r[0]!.status === 'added')).toBe(true);
    await tick();
    expect(good).toBe(1);
    await store.add(SCOPE, [newJob()]);
    await tick();
    expect(good).toBe(2);
  });

  it('memstore: close drops subscriptions', async () => {
    const store = await openStore();
    let wakes = 0;
    await store.subscribe(SCOPE, () => void wakes++);
    await store.close();
    await store.open();
    await store.add(SCOPE, [newJob()]);
    await tick();
    expect(wakes).toBe(0);
    await expect(store.subscribe(SCOPE, 5 as never)).rejects.toBeInstanceOf(StoreRequestError);
  });
});
