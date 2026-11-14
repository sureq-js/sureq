// The public API end to end, imported only from '@sureq/core' (src, built ESM or built CJS by SUREQ_TARGET).
import { describe, expect, it, vi } from 'vitest';
import { InvalidJobStateError, InvalidOptionError, MemoryStore, Queue, UnrecoverableError, isSureQError } from '@sureq/core';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const once = <P>(emitter: { once(e: string, fn: (p: P) => void): unknown }, event: string) => new Promise<P>((r) => emitter.once(event, r));
const queue = (opts: Record<string, unknown> = {}, name = 'pub') => new Queue(name, { logger: silent, ...opts });

describe('public API on the package entry', { timeout: 30_000 }, () => {
  it('pkg: MemoryStore is exported from the main entry', async () => {
    const store = new MemoryStore();
    const a = queue({ store });
    const b = queue({ store });
    const { job } = await a.add(1);
    expect((await b.getJob(job.id))!.id).toBe(job.id);
    await Promise.all([a.close(), b.close()]);
  });

  it('public: add, process, complete', async () => {
    const q = queue();
    const w = q.process(() => ({ ok: 1 }));
    const done = once(w as never, 'completed');
    const { job } = await q.add('x');
    await done;
    expect((await q.getJob(job.id))!.result).toEqual({ ok: 1 });
    expect((await q.getCounts()).completed).toBe(1);
    await q.close();
  });

  it('public: retry with backoff then fail', async () => {
    const q = queue({ defaultJobOptions: { backoff: 0 } });
    let calls = 0;
    const w = q.process(() => {
      calls++;
      throw new TypeError('always');
    }, { pollMin: 5, pollMax: 5, pollJitter: 0 });
    const failed = once<{ reason: string }>(w as never, 'failed');
    await q.add(1, { maxAttempts: 3 });
    expect((await failed).reason).toBe('attempts-exhausted');
    expect(calls).toBe(3);
    await q.close();
  });

  it('public: UnrecoverableError and ctx.fail stop retries', async () => {
    for (const how of ['throw', 'ctx.fail'] as const) {
      const q = queue({ defaultJobOptions: { backoff: 0 } });
      let calls = 0;
      const w = q.process((_job, ctx) => {
        calls++;
        if (how === 'throw') throw new UnrecoverableError('bad');
        return ctx.fail(new TypeError('bad'), { retry: false });
      }, { pollMin: 5, pollMax: 5, pollJitter: 0 });
      const failed = once<{ reason: string }>(w as never, 'failed');
      await q.add(1, { maxAttempts: 5 });
      expect((await failed).reason).toBe('unrecoverable');
      expect(calls).toBe(1);
      await q.close();
    }
  });

  it('public: retryIf false fails with not-retryable', async () => {
    const q = queue();
    const w = q.process(() => Promise.reject(new TypeError('x')), { retryIf: () => false });
    const failed = once<{ reason: string }>(w as never, 'failed');
    await q.add(1, { maxAttempts: 5 });
    expect((await failed).reason).toBe('not-retryable');
    await q.close();
  });

  it('public: named backoff strategy is used', async () => {
    const q = queue({ defaultJobOptions: { backoff: { type: 'mine' } } });
    const w = q.process(() => Promise.reject(new TypeError('x')), { backoffStrategies: { mine: () => 0 } });
    const retrying = once<{ delayMs: number }>(w as never, 'retrying');
    await q.add(1, { maxAttempts: 2 });
    expect((await retrying).delayMs).toBe(0);
    await q.close();
  });

  it('public: getJobs order and paging', async () => {
    const q = queue();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await q.add(i, { priority: i % 2 })).job.id);
    const pages = [...(await q.getJobs('waiting', { limit: 2 })), ...(await q.getJobs('waiting', { offset: 2, limit: 3 }))];
    expect(pages.map((j) => j.id)).toEqual(ids);
    await q.close();
  });

  it('public: remove returns true then false', async () => {
    const q = queue();
    const { job } = await q.add(1);
    expect(await q.remove(job.id)).toBe(true);
    expect(await q.remove(job.id)).toBe(false);
    await q.close();
  });

  it('public: remove of an active job throws InvalidJobStateError', async () => {
    const q = queue();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = q.process(() => gate);
    const active = once(w as never, 'active');
    const { job } = await q.add(1);
    await active;
    const e = await q.remove(job.id).catch((x: unknown) => x);
    expect(isSureQError(e) && (e as { code: string }).code).toBe('INVALID_JOB_STATE');
    expect(e).toBeInstanceOf(InvalidJobStateError);
    open();
    await q.close();
  });

  it('public: drained fires once after the last job', async () => {
    const q = queue();
    const drained = vi.fn();
    q.on('drained', drained);
    q.process(() => 'ok');
    const done = once(q as never, 'drained');
    await q.addBulk([1, 2, 3].map((data) => ({ data })));
    await done;
    await new Promise((r) => setTimeout(r, 10));
    expect(drained).toHaveBeenCalledOnce();
    await q.close();
  });

  it('public: delayed job runs after its delay', async () => {
    const q = queue();
    const ranAt: number[] = [];
    const w = q.process(() => void ranAt.push(Date.now()), { pollMin: 10, pollMax: 10, pollJitter: 0 });
    const done = once(w as never, 'completed');
    const t0 = Date.now();
    await q.add(1, { delay: '50ms' });
    await done;
    expect(ranAt[0]! - t0).toBeGreaterThanOrEqual(45);
    await q.close();
  });

  it('public: invalid option names throw InvalidOptionError with a suggestion', async () => {
    const q = queue();
    const e = await q.add(1, { maxAtempts: 3 } as never).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect((e as InvalidOptionError).issues[0]).toMatchObject({ path: 'maxAtempts', suggestion: 'maxAttempts' });
    await q.close();
  });
});
