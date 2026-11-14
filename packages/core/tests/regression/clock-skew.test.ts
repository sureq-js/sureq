import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { claimReq } from '../helpers/store.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const HOUR = 3_600_000;
const sweepReq = { limit: 100, maxCrashes: 3, failError: '{"v":1,"name":"E","message":"f"}', poisonError: '{"v":1,"name":"E","message":"p"}' };

describe('clock skew (regression)', () => {
  it('regression: two pods with clocks ±1h apart never double-claim and recover on schedule', async () => {
    const clock = { t: 1_700_000_000_000 };
    const store = new MemoryStore({ clock: () => clock.t });
    // Pod wall clocks: every read lands an hour ahead or an hour behind the store, alternately.
    let skew = HOUR;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.t + (skew = -skew));
    const qa = new Queue('skew', { store, logger: silent });
    const qb = new Queue('skew', { store, logger: silent });
    const runs = new Map<unknown, number>();
    const handler = (job: { data: unknown }) => void runs.set(job.data, (runs.get(job.data) ?? 0) + 1);
    const wa = qa.process(handler, { concurrency: 3, ...poll(5) });
    const wb = qb.process(handler, { concurrency: 3, ...poll(5) });
    await qa.addBulk(Array.from({ length: 25 }, (_, i) => ({ data: `a${i}` })));
    await qb.addBulk(Array.from({ length: 25 }, (_, i) => ({ data: `b${i}` })));
    await vi.waitFor(async () => expect((await qa.getCounts()).completed).toBe(50));
    expect(runs.size).toBe(50);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    await Promise.all([wa.close(), wb.close()]);

    // A worker that dies holding a lease is recovered exactly when the store clock reaches its expiry.
    const scope = qa.internals.scope;
    const { job } = await qa.add('orphan');
    const [held] = (await store.claim(scope, claimReq({ workerId: 'dead', leaseMs: 1000, limit: 1 }))).jobs;
    const expiresAt = held!.lease!.expiresAt;
    expect(expiresAt).toBe(clock.t + 1000);
    clock.t = expiresAt - 1;
    skew = 10 * HOUR; // a pod clock step changes nothing below
    expect((await store.sweep(scope, sweepReq)).swept).toEqual([]);
    clock.t = expiresAt;
    expect((await store.sweep(scope, sweepReq)).swept.map((s) => [s.id, s.action])).toEqual([[job.id, 'requeued']]);
    const wc = qb.process(handler, poll(5));
    await vi.waitFor(async () => expect((await qb.getJob(job.id))!.state).toBe('completed'));
    expect(runs.get('orphan')).toBe(1);
    await wc.close();
    await Promise.all([qa.close(), qb.close()]);
  });
});
