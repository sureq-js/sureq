import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { BatchWorkerOptions } from '../../src/queue/options.js';
import type { RenewRequest } from '../../src/store/contract.js';
import type { Duration } from '../../src/util/duration.js';
import { addAll, batchSetup, closeBatchQueues, gate, ids } from '../helpers/batch.js';

afterEach(closeBatchQueues);

const setup = (o: { over?: NonNullable<Parameters<typeof batchSetup>[0]>['over']; lease?: Duration } = {}) =>
  batchSetup({ ...(o.over && { over: o.over }), queue: { leaseDuration: o.lease ?? '30s' } });

describe('batch forming and delivery', () => {
  it('batch: handler receives up to batchSize jobs in claim order', async () => {
    const s = setup();
    const prio = [0, 5, 0, 5, 1, 0, 1];
    for (const [i, priority] of prio.entries()) await s.q.add({}, { id: `j${i}`, priority });
    s.run({ batchSize: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.calls.map((c) => c.ids)).toEqual([['j1', 'j3', 'j4'], ['j6', 'j0', 'j2'], ['j5']]);
  });

  it('batch: partial batch closes after batchDelay of quiet', async () => {
    const s = setup();
    await addAll(s.q, ids(2));
    s.run({ batchSize: 10, batchDelay: '200ms', batchMaxWait: '10s' });
    await vi.advanceTimersByTimeAsync(199);
    expect(s.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.map((c) => c.ids)).toEqual([['j1', 'j2']]);

    const t = setup();
    await addAll(t.q, ids(2));
    t.run({ batchSize: 10, batchDelay: '200ms', batchMaxWait: '10s' });
    await vi.advanceTimersByTimeAsync(150);
    await t.q.add({}, { id: 'j3' });
    await vi.advanceTimersByTimeAsync(199);
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.calls.map((c) => c.ids)).toEqual([['j1', 'j2', 'j3']]);
    expect(t.calls[0]!.at).toBeGreaterThanOrEqual(350);
  });

  it('batch: batchMaxWait closes a batch under a steady trickle', async () => {
    const s = setup();
    s.run({ batchSize: 100, batchDelay: 100, batchMaxWait: 1000 });
    let n = 0;
    await s.q.add({}, { id: `t${n++}` });
    const trickle = setInterval(() => void s.q.add({}, { id: `t${n++}` }), 90);
    await vi.advanceTimersByTimeAsync(1100);
    clearInterval(trickle);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(s.calls[0]!.at).toBeLessThanOrEqual(1050);
    expect(s.calls[0]!.ids.length).toBeGreaterThanOrEqual(11);
  });

  it('batch: without batchMaxWait a trickled batch closes twenty batchDelays after its first job', async () => {
    const s = setup();
    s.run({ batchSize: 100, batchDelay: 100 });
    let n = 0;
    await s.q.add({}, { id: `t${n++}` });
    const trickle = setInterval(() => void s.q.add({}, { id: `t${n++}` }), 90);
    await vi.advanceTimersByTimeAsync(1950);
    expect(s.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    clearInterval(trickle);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.at).toBeGreaterThanOrEqual(2000);
    expect(s.calls[0]!.at).toBeLessThanOrEqual(2050);
  });

  it('batch: batchDelay 0 delivers whatever is claimable at once', async () => {
    const s = setup();
    await addAll(s.q, ids(2));
    let claims = 0;
    s.run({ batchSize: 10 }, async () => void (claims = s.ops('claim').length));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.calls.map((c) => c.ids)).toEqual([['j1', 'j2']]);
    expect(claims).toBe(1);
  });

  it('batch: flush releases a partial batch immediately and returns the count', async () => {
    const s = setup();
    await addAll(s.q, ids(3));
    const g = gate();
    const w = s.run({ batchSize: 10, batchDelay: '1h' }, () => g.p);
    await vi.advanceTimersByTimeAsync(100);
    expect(w.batch.held).toBe(3);
    await expect(w.batch.flush()).resolves.toBe(3);
    expect(w.batch.held).toBe(0);
    expect(s.calls.map((c) => c.ids)).toEqual([ids(3)]);
    g.open();
  });

  it('batch: flush with nothing held resolves 0', async () => {
    const s = setup();
    const w = s.run({ batchSize: 10, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(w.batch.flush()).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.calls).toEqual([]);
  });

  it('batch: flush racing the size trigger delivers each job once', async () => {
    // The claim that fills the batch and a flush land in the same tick, flush first and then flush second.
    for (const flushFirst of [true, false]) {
      const ref: { w?: ReturnType<ReturnType<typeof setup>['run']> } = {};
      const flushes: Array<Promise<number>> = [];
      const s = setup({
        over: (inner) => ({
          claim: async (scope, req) => {
            const res = await inner.claim(scope, req);
            if (res.jobs.some((j) => j.id === 'j4')) {
              if (flushFirst) flushes.push(ref.w!.batch.flush());
              else void Promise.resolve().then(() => flushes.push(ref.w!.batch.flush()));
            }
            return res;
          },
        }),
      });
      await addAll(s.q, ids(3));
      const w = (ref.w = s.run({ batchSize: 4, batchDelay: '1h' }));
      await vi.advanceTimersByTimeAsync(100);
      await s.q.add({}, { id: 'j4' });
      await vi.advanceTimersByTimeAsync(100);
      await w.batch.flush();
      await vi.advanceTimersByTimeAsync(100);
      const flushed = await Promise.all(flushes);
      expect(flushes, `flushFirst ${flushFirst}`).toHaveLength(1);
      expect(s.calls.flatMap((c) => c.ids).sort(), `flushFirst ${flushFirst}`).toEqual(ids(4));
      // Whichever closes the batch first wins; the other finds it closed or the next batch forming.
      expect([[3, [3, 1]], [0, [4]]]).toContainEqual([flushed[0], s.calls.map((c) => c.ids.length)]);
      if (flushFirst) await closeBatchQueues();
    }
  });

  it('batch: a long batchDelay keeps the default batchMaxWait within one timer', async () => {
    const s = setup();
    await addAll(s.q, ids(2));
    const w = s.run({ batchSize: 5, batchDelay: '3d' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.calls).toEqual([]);
    expect(w.batch.held).toBe(2);
  });

  it('batch: every job in a batch has its own lease and fencing token', async () => {
    const s = setup();
    await addAll(s.q, ids(3));
    let owners: Array<string | undefined> = [];
    const w = s.run({ batchSize: 3 }, async (batch) => void (owners = batch.jobs.map((j) => j.lease?.owner)));
    await vi.advanceTimersByTimeAsync(100);
    const { jobs } = s.calls[0]!;
    expect(new Set(jobs.map((j) => j.token)).size).toBe(3);
    expect(owners).toEqual([w.id, w.id, w.id]);
    expect(new Set(jobs.map((j) => j.signal)).size).toBe(3);
  });

  it('batch: heartbeat renews held jobs while the batch is forming', async () => {
    const s = setup({ lease: '3s' });
    await addAll(s.q, ids(2));
    const w = s.run({ batchSize: 10, batchDelay: '1h' });
    let activeAt: number | undefined;
    w.on('active', () => void (activeAt ??= s.spy.calls.length));
    await vi.advanceTimersByTimeAsync(5000);
    const renews = () => s.ops('renew').map((c) => c.args[1] as RenewRequest);
    for (const id of ids(2)) expect(renews().filter((r) => r.id === id).length).toBeGreaterThanOrEqual(4);
    expect(renews().some((r) => r.started)).toBe(false);
    const before = s.spy.calls.length;
    await w.batch.flush();
    const started = s.spy.calls.slice(before).filter((c) => c.op === 'renew' && (c.args[1] as RenewRequest).started);
    expect(started.map((c) => (c.args[1] as RenewRequest).id).sort()).toEqual(ids(2));
    expect(activeAt).toBeGreaterThanOrEqual(before + 2);
    expect(s.spy.calls.indexOf(started.at(-1)!)).toBeLessThan(activeAt!);
  });

  it('batch: empty batch is never delivered', async () => {
    const s = setup({ lease: '3s' });
    await addAll(s.q, ids(1));
    const w = s.run({ batchSize: 10, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    await s.q.cancel('j1');
    await vi.advanceTimersByTimeAsync(1100);
    await expect(w.batch.flush()).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.calls).toEqual([]);
  });

  it('batch: concurrency counts batches', async () => {
    const s = setup();
    await addAll(s.q, ids(10));
    const gates = [gate(), gate(), gate(), gate()];
    let k = 0;
    s.run({ batchSize: 3, concurrency: 2 }, () => gates[k++]!.p);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.calls.map((c) => c.ids.length)).toEqual([3, 3]);
    const claims = s.ops('claim').length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.ops('claim')).toHaveLength(claims);
    gates[0]!.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.calls.map((c) => c.ids.length)).toEqual([3, 3, 3]);
    for (const g of gates) g.open();
  });

  it('batch: process with batchSize throws InvalidOptionError', () => {
    const s = setup();
    let err: unknown;
    try {
      s.q.process(async () => {}, { batchSize: 2 } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidOptionError);
    expect((err as InvalidOptionError).issues.map((i) => i.path)).toEqual(['batchSize']);
    expect((err as Error).message).toContain('processBatch');
  });

  it('batch: invalid options (size 1, maxWait below delay) throw InvalidOptionError', () => {
    const s = setup();
    const bad: Array<[object, string]> = [
      [{ batchSize: 1 }, 'batchSize'], [{ batchSize: 1001 }, 'batchSize'], [{ batchSize: 2.5 }, 'batchSize'], [{}, 'batchSize'],
      [{ batchSize: 2, batchDelay: '1s', batchMaxWait: '500ms' }, 'batchMaxWait'], [{ batchSize: 2, onShutdown: 'drop' }, 'onShutdown'],
      [{ batchSize: 2, batchDelay: 2_147_483_648 }, 'batchDelay'],
    ];
    for (const [opts, path] of bad) {
      let err: unknown;
      try {
        s.q.processBatch(async () => {}, opts as BatchWorkerOptions);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(opts)).toBeInstanceOf(InvalidOptionError);
      expect((err as InvalidOptionError).issues.map((i) => i.path), JSON.stringify(opts)).toEqual([path]);
    }
  });

  it('batch: active event fires at handler start while getJob shows active from claim', async () => {
    const s = setup();
    await addAll(s.q, ids(2));
    const w = s.run({ batchSize: 10, batchDelay: '1h' });
    const active = vi.fn();
    w.on('active', active);
    await vi.advanceTimersByTimeAsync(100);
    expect((await s.q.getJob('j1'))?.state).toBe('active');
    expect(active).not.toHaveBeenCalled();
    await w.batch.flush();
    expect(active.mock.calls.map(([e]) => (e as { job: { id: string } }).job.id)).toEqual(ids(2));
  });

  it('batch: store outage longer than lease drops held jobs locally', async () => {
    let down = false;
    const s = setup({
      lease: '3s',
      over: (inner) => ({
        renew: (scope, req) => (down ? Promise.reject(new StoreUnavailableError('down', { operation: 'renew', retryable: true, outcomeUnknown: false })) : inner.renew(scope, req)),
      }),
    });
    await addAll(s.q, ids(2));
    const w = s.run({ batchSize: 10, batchDelay: '1h' });
    const lost = vi.fn();
    w.on('leaseLost', lost);
    w.on('error', () => {});
    await vi.advanceTimersByTimeAsync(100);
    down = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(lost.mock.calls.map(([e]) => [(e as { job: { id: string } }).job.id, (e as { reason: string }).reason]).sort()).toEqual([['j1', 'expired'], ['j2', 'expired']]);
    expect(w.batch.held).toBe(0);
    await expect(w.batch.flush()).resolves.toBe(0);
    expect(s.calls).toEqual([]);
  });

  it('batch: a started renew that cannot reach the store drops only that job', async () => {
    const s = setup({
      lease: '3s',
      over: (inner) => ({
        renew: (scope, req) => (req.started && req.id === 'j2'
          ? Promise.reject(new StoreUnavailableError('down', { operation: 'renew', retryable: true, outcomeUnknown: false }))
          : inner.renew(scope, req)),
      }),
    });
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 10, batchDelay: '1h' });
    const lost = vi.fn();
    w.on('leaseLost', lost);
    w.on('error', () => {});
    await vi.advanceTimersByTimeAsync(100);
    const flushed = w.batch.flush();
    await vi.advanceTimersByTimeAsync(3500);
    await expect(flushed).resolves.toBe(2);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0]![0]).toMatchObject({ job: { id: 'j2' }, reason: 'expired' });
    expect(s.calls.map((c) => c.ids)).toEqual([['j1', 'j3']]);
  });

  it('batch-result: void return completes every unsettled job', async () => {
    const s = setup();
    await addAll(s.q, ids(3));
    const w = s.run({ batchSize: 3 });
    const completed = vi.fn();
    w.on('completed', completed);
    await vi.advanceTimersByTimeAsync(100);
    expect(completed).toHaveBeenCalledTimes(3);
    for (const id of ids(3)) {
      const job = await s.q.getJob(id);
      expect([job?.state, job?.result]).toEqual(['completed', undefined]);
    }
  });

  it('merge: job held in a forming batch is not merged', async () => {
    const s = setup();
    await s.q.add({ a: 1 }, { id: 'm' });
    const w = s.run({ batchSize: 10, batchDelay: '1h' });
    await vi.advanceTimersByTimeAsync(100);
    const other = s.other();
    const merge = vi.fn((e: { data: unknown }, i: unknown) => ({ ...(e.data as object), ...(i as object) }));
    const r = await other.add({ b: 2 }, { id: 'm', onDuplicate: merge as never });
    expect(r).toMatchObject({ added: false, duplicate: { action: 'ignored', existingState: 'active' } });
    expect(merge).not.toHaveBeenCalled();
    await w.batch.flush();
    expect(s.calls[0]!.jobs[0]!.data).toEqual({ a: 1 });
  });
});
