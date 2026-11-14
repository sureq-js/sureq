import { afterEach, describe, expect, it, vi } from 'vitest';
import { toJob, type JobBinding } from '../../src/job/job.js';
import type { JobRecord, StoredProgress } from '../../src/store/contract.js';
import { StoreUnavailableError } from '../../src/errors/catalog.js';
import type { SetProgressResult } from '../../src/store/contract.js';
import { deriveProgress, ProgressChannel } from '../../src/worker/progress.js';
import { FORMAT_SUPPORT } from '../../src/format/support.js';

const counter = (n: number, total?: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'counter', n, total: total ?? null, message: null, ...extra });
const stored = (value: string, updatedAt: number): StoredProgress => ({ value, updatedAt });
const derive = (s: StoredProgress | null, startedAt: number | null = 1_000) => deriveProgress(s, startedAt, JSON.parse);

const channel = (write: () => Promise<SetProgressResult>) =>
  new ProgressChannel({ intervalMs: 250, now: () => performance.now(), write, onWritten: () => {}, onRejected: async () => new TypeError('x'), onError: () => {} });

describe('progress (reading)', () => {
  afterEach(() => vi.useRealTimers());

  it('progress: eta is elapsed * (total - n) / n from store times', () => {
    expect(derive(stored(counter(25, 100), 11_000))).toEqual({
      kind: 'counter', n: 25, total: 100, message: null, percent: 25, etaMs: 30_000, etaAt: 41_000, updatedAt: 11_000,
    });
    expect(derive(stored(counter(25, 100, { baseAt: 0 }), 11_000))).toMatchObject({ etaMs: 33_000, etaAt: 44_000 });
  });

  it('progress: eta is null without total or with n zero', () => {
    expect(derive(stored(counter(0, 100), 11_000))).toMatchObject({ percent: 0, etaMs: null, etaAt: null });
    expect(derive(stored(counter(5), 11_000))).toMatchObject({ n: 5, total: null, percent: null, etaMs: null, etaAt: null });
    expect(derive(stored(counter(5, 10), 1_000))).toMatchObject({ percent: 50, etaMs: null, etaAt: null });
    expect(derive(stored(counter(5, 10), 11_000), null)).toMatchObject({ percent: 50, etaMs: null, etaAt: null });
  });

  it('progress: eta is 0 and percent clamps when n exceeds total', () => {
    expect(derive(stored(counter(150, 100), 11_000))).toMatchObject({ percent: 100, etaMs: 0, etaAt: 11_000 });
    expect(derive(stored(counter(100, 100), 11_000))).toMatchObject({ percent: 100, etaMs: 0 });
  });

  it('progress: eta is correct when pod clock is skewed ±1h', () => {
    const expected = derive(stored(counter(25, 100), 11_000));
    for (const skew of [3_600_000, -3_600_000]) {
      vi.useFakeTimers({ toFake: ['Date', 'performance'] });
      vi.setSystemTime(Date.now() + skew);
      expect(derive(stored(counter(25, 100), 11_000))).toEqual(expected);
      vi.useRealTimers();
    }
  });

  it('progress: object form, no value and an unreadable value', () => {
    const obj = JSON.stringify({ kind: 'object', value: { stage: 'x' } });
    expect(derive(stored(obj, 5_000))).toEqual({ kind: 'object', value: { stage: 'x' }, updatedAt: 5_000 });
    expect(derive(null)).toBeNull();
    expect(derive(stored('{', 5_000))).toBeNull();
    expect(derive(stored(JSON.stringify({ kind: 'other' }), 5_000))).toBeNull();
    expect(derive({ value: new TextEncoder().encode(counter(1, 2)), updatedAt: 2_000 })).toMatchObject({ n: 1, total: 2, etaMs: 1_000 });
  });

  it('progress: toJob derives progress and batchProgress, the batch value from its baseAt', () => {
    const rec = {
      formatVersion: 1, namespace: 'n', queue: 'q', id: 'j1', name: null, data: 'null', state: 'active', priority: 0, seq: 1,
      runAt: 0, attempt: 1, maxAttempts: 3, crashCount: 0, lease: null, token: 1, result: null, error: null, createdAt: 0,
      startedAt: 1_000, finishedAt: null, workerId: 'w', backoff: null, timeout: null, lastFinal: null, rev: 1, dataVersion: null,
      idempotencyKey: null, uniqueWhile: 'pending', singletonKey: null, singletonHeld: false, deadLetter: null, retainUntil: null,
      keep: null, redriveCount: 0, lastError: null, attemptsTruncated: 0, scheduleKey: null, scheduledFor: null, cancelReason: null,
      progress: stored(counter(25, 100, { message: 'resizing' }), 11_000),
      batchProgress: stored(counter(1, 3, { baseAt: 0 }), 11_000),
    } satisfies JobRecord;
    const binding: JobBinding = {
      remove: async () => true, cancel: async () => ({ ok: false, reason: 'not-found' }) as never, getAttempts: async () => [], retry: async () => ({ id: 'j1', status: 'skipped', reason: 'not-failed' }) as never, deserialize: JSON.parse, format: FORMAT_SUPPORT,
    };
    const job = toJob(rec, 11_000, binding);
    expect(job.progress).toMatchObject({ n: 25, message: 'resizing', etaMs: 30_000 });
    expect(job.batchProgress).toMatchObject({ n: 1, total: 3, etaMs: 22_000 });
  });
  it('progress: a flush with no deadline waits for the write without a timer warning', async () => {
    const warnings: unknown[] = [];
    const onWarning = (w: unknown) => void warnings.push(w);
    process.on('warning', onWarning);
    try {
      const ch = channel(() => new Promise((r) => setTimeout(() => r({ ok: true, now: 1 }), 20)));
      const call = ch.push('a');
      await ch.flush(Infinity);
      await expect(call).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings).toEqual([]);
  });

  it('progress: a flush for an attempt with no lease left drops the write at once', async () => {
    const ch = channel(() => new Promise(() => {}));
    const call = ch.push('a');
    const queued = ch.push('b');
    const started = performance.now();
    await ch.flush(undefined);
    expect(performance.now() - started).toBeLessThan(50);
    await expect(call).rejects.toBeInstanceOf(StoreUnavailableError);
    await expect(queued).rejects.toBeInstanceOf(StoreUnavailableError);
    const reason = new TypeError('aborted');
    const other = channel(() => new Promise(() => {}));
    const pending = other.push('a');
    await other.flush(undefined, reason);
    await expect(pending).rejects.toBe(reason);
  });
});
