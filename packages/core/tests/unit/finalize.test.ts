import { describe, expect, it, vi } from 'vitest';
import { StoreError, StoreUnavailableError } from '../../src/errors/catalog.js';
import { finalize, type FinalizeCtx, type FinalResult } from '../../src/worker/finalize.js';

/** A finalize context on a hand-driven clock: `sleep` records the wait and moves the clock. */
const setup = (operation: FinalizeCtx['operation'] = 'complete', deadlineIn: number | null = 5000) => {
  const clock = { t: 1000 };
  const sleeps: number[] = [];
  const report = vi.fn();
  const ctx: FinalizeCtx = {
    operation,
    jobId: 'job-1',
    deadline: deadlineIn === null ? undefined : clock.t + deadlineIn,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    report,
  };
  return { clock, sleeps, report, ctx };
};
const lost = () => new StoreUnavailableError('response lost', { operation: 'complete', retryable: true, outcomeUnknown: true });

describe('finalize', () => {
  it('reconnect: complete, fail and release with unknown outcome are repeated with the same token until the local lease deadline', async () => {
    for (const operation of ['complete', 'fail', 'release'] as const) {
      const s = setup(operation, 5000);
      const tokens: number[] = [];
      const req = { id: 'job-1', token: 7 };
      const write = vi.fn(async (): Promise<FinalResult> => {
        tokens.push(req.token);
        throw lost();
      });
      expect(await finalize(write, s.ctx)).toEqual({ unconfirmed: true });
      // The ladder, then every second, the last wait cut to what is left of the lease.
      expect(s.sleeps).toEqual([50, 100, 200, 400, 800, 1000, 1000, 1000, 450]);
      expect(s.sleeps.reduce((a, b) => a + b)).toBe(5000);
      expect(write).toHaveBeenCalledTimes(10);
      expect(new Set(tokens)).toEqual(new Set([7]));
      expect(s.report).toHaveBeenCalledOnce();
      expect(s.report.mock.calls[0]![0]).toMatchObject({
        code: 'STORE_UNAVAILABLE', outcomeUnknown: true, operation, jobId: 'job-1', message: `outcome of '${operation}' for job 'job-1' is unconfirmed`,
      });
    }
  });

  it('reconnect: a write that never reached the store is repeated the same way', async () => {
    const s = setup('complete', 2000);
    const write = vi.fn(async (): Promise<FinalResult> => {
      throw new TypeError('down');
    });
    expect(await finalize(write, s.ctx)).toEqual({ unconfirmed: true });
    expect(s.sleeps).toEqual([50, 100, 200, 400, 800, 450]);
    expect(s.report).toHaveBeenCalledOnce();
  });

  it('reconnect: without a deadline the write is tried once', async () => {
    const s = setup('complete', null);
    const write = vi.fn(async (): Promise<FinalResult> => {
      throw lost();
    });
    expect(await finalize(write, s.ctx)).toEqual({ unconfirmed: true });
    expect(write).toHaveBeenCalledOnce();
    expect(s.sleeps).toEqual([]);
    expect(s.report).toHaveBeenCalledOnce();
  });

  it('reconnect: repeat that finds the record gone is reported unconfirmed and not counted as a crash', async () => {
    const s = setup();
    let n = 0;
    const write = vi.fn(async (): Promise<FinalResult> => {
      if (++n === 1) throw lost();
      return { ok: false, reason: 'not-active' };
    });
    expect(await finalize(write, s.ctx)).toEqual({ unconfirmed: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect(s.report).toHaveBeenCalledOnce();
    expect(s.report.mock.calls[0]![0].message).toBe("outcome of 'complete' for job 'job-1' is unconfirmed");
  });

  it('reconnect: not-active on the first try is the store refusing the write, returned as-is', async () => {
    const s = setup();
    const refused = { ok: false, reason: 'not-active' } as const;
    expect(await finalize(async () => refused, s.ctx)).toBe(refused);
    expect(s.report).not.toHaveBeenCalled();
  });

  it('storeerr: permanent errors (retryable false, outcome known) are not retried', async () => {
    const s = setup();
    const bad = new StoreError('bad', { operation: 'complete', retryable: false, outcomeUnknown: false });
    const write = vi.fn(async (): Promise<FinalResult> => {
      throw bad;
    });
    expect(await finalize(write, s.ctx)).toEqual({ unconfirmed: true });
    expect(write).toHaveBeenCalledOnce();
    expect(s.report).toHaveBeenCalledOnce();
    expect(s.report.mock.calls[0]![0]).toBe(bad);
  });

  it('storeerr: success on a later try returns the result with no report', async () => {
    const s = setup();
    let n = 0;
    const r = await finalize(async (): Promise<FinalResult> => {
      if (++n < 3) throw new TypeError('blip');
      return { ok: true, now: 0 };
    }, s.ctx);
    expect(r).toEqual({ ok: true, now: 0 });
    expect(s.sleeps).toEqual([50, 100]);
    expect(s.report).not.toHaveBeenCalled();
  });
});
