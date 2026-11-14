import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import type { Queue } from '../../src/queue/queue.js';
import { harness, next } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { claimJobs } from '../helpers/store.js';

const queues: Queue[] = [];
const setup = () => {
  const h = harness({ queue: { defaultJobOptions: { backoff: 0 } } });
  queues.push(h.queue);
  return { ...h, scope: h.queue.internals.scope };
};
afterEach(async () => void (await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })))));

/** Run the job to its end, failing every attempt before the last; what each attempt saw. */
async function runAll(queue: Queue, opts: Parameters<Queue['add']>[1] = {}) {
  const seen: Array<{ key: string; attempt: number }> = [];
  const w = queue.process((job) => {
    seen.push({ key: job.idempotencyKey, attempt: job.attempt });
    if (job.attempt < job.maxAttempts) throw new TypeError('again');
  }, { ...poll(5) });
  const done = next(w, 'completed');
  const { job } = await queue.add(1, opts);
  await done;
  await w.close();
  return { job, seen };
}

describe('idempotency key and attempt', () => {
  it('idem: default key is the same across retries of one job', async () => {
    const { queue } = setup();
    const { job, seen } = await runAll(queue, { maxAttempts: 3 });
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(new Set(seen.map((s) => s.key))).toEqual(new Set([`default:h:${job.id}:${job.seq}`]));
    expect(job.idempotencyKey).toBe(`default:h:${job.id}:${job.seq}`);
  });

  it('idem: default key is the same after crash reclaim and shutdown release', async () => {
    const { queue, raw, scope, clock } = setup();
    const { job } = await queue.add(1);
    const [claimed] = await claimJobs(raw, scope, { leaseMs: 1000 });
    clock.advance(1001);
    await raw.sweep(scope, { limit: 10, maxCrashes: 3, failError: '{}', poisonError: '{}' });
    expect((await queue.getJob(job.id))!.idempotencyKey).toBe(job.idempotencyKey);
    const [again] = await claimJobs(raw, scope);
    expect(again!.token).toBeGreaterThan(claimed!.token);
    await raw.release(scope, { id: job.id, token: again!.token, refundAttempt: true, handlerStarted: true, reason: 'shutdown' });
    expect((await queue.getJob(job.id))!.idempotencyKey).toBe(job.idempotencyKey);
  });

  it('idem: default key differs when an id is reused after the first job finished', async () => {
    const { queue, raw, scope } = setup();
    const first = (await queue.add(1, { id: 'x' })).job;
    const [c] = await claimJobs(raw, scope);
    await raw.complete(scope, { id: 'x', token: c!.token, result: null });
    const second = (await queue.add(2, { id: 'x' })).job;
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('idem: default key differs when an id is removed and added again, and for a first-true job added after deletes', async () => {
    const { queue } = setup();
    const keys: string[] = [];
    const a = (await queue.add(1, { id: 'a' })).job;
    keys.push(a.idempotencyKey);
    await queue.remove('a');
    keys.push((await queue.add(1, { id: 'a' })).job.idempotencyKey);
    await queue.remove('a');
    keys.push((await queue.add(1, { id: 'a', first: true })).job.idempotencyKey);
    keys.push((await queue.add(1, { first: true })).job.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('idem: replace keeps the default key', async () => {
    const { queue } = setup();
    const first = (await queue.add(1, { id: 'r' })).job;
    expect((await queue.add(2, { id: 'r', onDuplicate: 'replace' })).job.idempotencyKey).toBe(first.idempotencyKey);
    expect((await queue.add(3, { id: 'r', onDuplicate: 'replace', idempotencyKey: 'own' })).job.idempotencyKey).toBe('own');
  });

  it('idem: explicit key is returned unchanged on every attempt', async () => {
    const { queue } = setup();
    const { seen } = await runAll(queue, { maxAttempts: 3, idempotencyKey: 'charge:order-123' });
    expect(seen.map((s) => s.key)).toEqual(['charge:order-123', 'charge:order-123', 'charge:order-123']);
  });

  it('idem: two jobs may share an explicit key', async () => {
    const { queue } = setup();
    const a = await queue.add(1, { idempotencyKey: 'same' });
    const b = await queue.add(2, { idempotencyKey: 'same' });
    expect([a.added, b.added]).toEqual([true, true]);
    expect(b.job.idempotencyKey).toBe('same');
  });

  it('idem: invalid explicit key throws InvalidOptionError without a store call', async () => {
    const { queue, raw } = setup();
    const add = vi.spyOn(raw, 'add');
    for (const key of ['', 'k'.repeat(256), 42]) await expect(queue.add(1, { idempotencyKey: key as string })).rejects.toThrow(InvalidOptionError);
    expect(add).not.toHaveBeenCalled();
    await expect(queue.add(1, { idempotencyKey: 'k'.repeat(255) })).resolves.toMatchObject({ added: true });
  });

  it('idem: attempt is 1 on first run and increases on each retry', async () => {
    const { queue } = setup();
    const { seen } = await runAll(queue, { maxAttempts: 4 });
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3, 4]);
  });

  it('idem: attempt after a graceful release reuses the number', async () => {
    const { queue, raw, scope } = setup();
    const { job } = await queue.add(1);
    const [c] = await claimJobs(raw, scope);
    expect(c!.attempt).toBe(1);
    await raw.release(scope, { id: job.id, token: c!.token, refundAttempt: true, handlerStarted: false, reason: 'shutdown' });
    const [again] = await claimJobs(raw, scope);
    expect(again!.attempt).toBe(1);
  });

  it('idem: maxAttempts equals the configured value', async () => {
    const { queue } = setup();
    expect((await queue.add(1, { maxAttempts: 7 })).job.maxAttempts).toBe(7);
  });

  it('idem: key and attempt are visible via getJob and in events', async () => {
    const { queue } = setup();
    const keys: string[] = [];
    queue.on('added', ({ job }) => void keys.push(job.idempotencyKey));
    queue.on('active', ({ job }) => void keys.push(job.idempotencyKey));
    queue.on('completed', ({ job }) => void keys.push(job.idempotencyKey));
    const w = queue.process(() => 'ok', { ...poll(5) });
    const done = next<{ job: Job }>(w, 'completed');
    const { job } = await queue.add(1, { id: 'v' });
    expect((await done).job.attempt).toBe(1);
    expect((await queue.getJob('v'))!.idempotencyKey).toBe(job.idempotencyKey);
    expect((await queue.getJobs('completed'))[0]!.idempotencyKey).toBe(job.idempotencyKey);
    expect(keys).toEqual([job.idempotencyKey, job.idempotencyKey, job.idempotencyKey]);
  });

  it('regression: a handler that crashes after its side effect sees the same key on the retry', async () => {
    const { queue, raw, scope, clock } = setup();
    const { job } = await queue.add(1);
    // a pod claimed it, did its side effect with the key, and died
    const [dead] = await claimJobs(raw, scope, { leaseMs: 1000 });
    const sideEffectKey = job.idempotencyKey;
    expect(dead!.attempt).toBe(1);
    clock.advance(1001);
    await raw.sweep(scope, { limit: 10, maxCrashes: 3, failError: '{}', poisonError: '{}' });
    const seen: Array<[string, number]> = [];
    const w = queue.process((j) => void seen.push([j.idempotencyKey, j.attempt]), { ...poll(5) });
    await next(w, 'completed');
    expect(seen).toEqual([[sideEffectKey, 2]]);
  });
});
