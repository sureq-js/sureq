import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTimeoutError } from '../../src/errors/catalog.js';
import { resolveTimeout, startTimeout } from '../../src/worker/timeout.js';

const start = (timeoutMs: number, graceMs: number) => {
  const abort = new AbortController();
  const onAbandon = vi.fn<(error: JobTimeoutError) => void>();
  const timer = startTimeout({ timeoutMs, graceMs, abort, jobId: 'j1', attempt: 2, onAbandon });
  return { abort, onAbandon, timer };
};

describe('startTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('timeout: signal aborts with JobTimeoutError at timeout ms', () => {
    const { abort } = start(1000, 500);
    vi.advanceTimersByTime(999);
    expect(abort.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(abort.signal.reason).toBeInstanceOf(JobTimeoutError);
    expect(abort.signal.reason).toMatchObject({ jobId: 'j1', attempt: 2, timeoutMs: 1000, graceMs: 500, abandoned: false });
  });

  it('timeout: grace expiry calls onAbandon once with abandoned true', () => {
    const { onAbandon } = start(1000, 500);
    vi.advanceTimersByTime(1499);
    expect(onAbandon).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAbandon).toHaveBeenCalledOnce();
    const err = onAbandon.mock.calls[0]![0];
    expect(err).toBeInstanceOf(JobTimeoutError);
    expect(err).toMatchObject({ jobId: 'j1', attempt: 2, timeoutMs: 1000, graceMs: 500, abandoned: true });
    vi.advanceTimersByTime(10_000);
    expect(onAbandon).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    // Grace 0: the abort and the abandon happen in the same timer callback, no further timer.
    const zero = start(1000, 0);
    vi.advanceTimersByTime(1000);
    expect(zero.abort.signal.aborted).toBe(true);
    expect(zero.onAbandon).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeout: settled before the limit clears both timers', () => {
    const { abort, onAbandon, timer } = start(1000, 500);
    vi.advanceTimersByTime(500);
    timer.settled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(abort.signal.aborted).toBe(false);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('timeout: settled after the abort cancels the grace timer', () => {
    const { abort, onAbandon, timer } = start(1000, 500);
    vi.advanceTimersByTime(1200);
    expect(abort.signal.aborted).toBe(true);
    timer.settled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('timeout: timer is cleared when another reason aborts the signal first', () => {
    const { abort, onAbandon } = start(1000, 500);
    vi.advanceTimersByTime(300);
    const other = new Error('x');
    abort.abort(other);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(abort.signal.reason).toBe(other);
    expect(onAbandon).not.toHaveBeenCalled();
  });
});

describe('resolveTimeout', () => {
  const ADD = '{"timeoutMs":1000}';
  const cases: [string, string | null, { timeoutMs?: number; graceMs?: number }, { timeoutMs?: number; graceMs?: number }, { timeoutMs: number | undefined; graceMs: number }][] = [
    ['none', null, {}, {}, { timeoutMs: undefined, graceMs: 5000 }],
    ['queue only', null, {}, { timeoutMs: 3000 }, { timeoutMs: 3000, graceMs: 5000 }],
    ['worker only', null, { timeoutMs: 2000 }, {}, { timeoutMs: 2000, graceMs: 5000 }],
    ['add only', ADD, {}, {}, { timeoutMs: 1000, graceMs: 5000 }],
    ['worker over queue', null, { timeoutMs: 2000 }, { timeoutMs: 3000 }, { timeoutMs: 2000, graceMs: 5000 }],
    ['add over queue', ADD, {}, { timeoutMs: 3000 }, { timeoutMs: 1000, graceMs: 5000 }],
    ['add over worker', ADD, { timeoutMs: 2000 }, {}, { timeoutMs: 1000, graceMs: 5000 }],
    ['add over worker over queue', ADD, { timeoutMs: 2000 }, { timeoutMs: 3000 }, { timeoutMs: 1000, graceMs: 5000 }],
    ['add grace with worker timeout', '{"graceMs":100}', { timeoutMs: 2000, graceMs: 700 }, { graceMs: 900 }, { timeoutMs: 2000, graceMs: 100 }],
    ['worker grace over queue grace', null, { graceMs: 700 }, { timeoutMs: 3000, graceMs: 900 }, { timeoutMs: 3000, graceMs: 700 }],
    ['queue grace', null, {}, { graceMs: 0 }, { timeoutMs: undefined, graceMs: 0 }],
    ['malformed add ignored', '{"timeoutMs":', { timeoutMs: 2000 }, {}, { timeoutMs: 2000, graceMs: 5000 }],
    ['non-object add ignored', '[1]', {}, { timeoutMs: 3000 }, { timeoutMs: 3000, graceMs: 5000 }],
    ['non-integer stored fields ignored', '{"timeoutMs":"1000","graceMs":1.5}', { timeoutMs: 2000 }, { graceMs: 900 }, { timeoutMs: 2000, graceMs: 900 }],
    ['negative and null stored fields ignored', '{"timeoutMs":-1,"graceMs":null}', {}, { timeoutMs: 3000 }, { timeoutMs: 3000, graceMs: 5000 }],
    ['out-of-range stored fields ignored', '{"timeoutMs":0,"graceMs":2147483648}', {}, { timeoutMs: 3000, graceMs: 900 }, { timeoutMs: 3000, graceMs: 900 }],
    ['stored upper bounds kept', '{"timeoutMs":2147483647,"graceMs":2147483647}', {}, {}, { timeoutMs: 2147483647, graceMs: 2147483647 }],
    ['stored zero grace kept', '{"timeoutMs":1000,"graceMs":0}', {}, { graceMs: 900 }, { timeoutMs: 1000, graceMs: 0 }],
  ];

  it.each(cases)('timeout: resolution takes add over worker over queue per field (%s)', (_, timeout, worker, queue, want) => {
    expect(resolveTimeout({ timeout }, worker, queue)).toEqual(want);
  });

  it('timeout: a record without the field resolves from the pod config', () => {
    expect(resolveTimeout({} as { timeout: null }, { timeoutMs: 2000 }, {})).toEqual({ timeoutMs: 2000, graceMs: 5000 });
  });
});
