import { describe, expect, it, vi } from 'vitest';
import { Lifecycle, releaseLease } from '../../src/worker/lifecycle.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError, StoreError, StoreUnavailableError } from '../../src/errors/catalog.js';
import type { StoreClient } from '../../src/store/client.js';
import type { ReleaseRequest, ReleaseResult } from '../../src/store/contract.js';
import { silent } from '../helpers/harness.js';

const scope = { namespace: 'n', queue: 'q' };
const req: ReleaseRequest = { id: 'j1', token: 4, refundAttempt: true, handlerStarted: true, reason: 'shutdown' };
const unknown = () => new StoreUnavailableError('lost', { operation: 'release', retryable: true, outcomeUnknown: true });

/** A client whose `release` answers from `answers` in turn (a function throws). */
function fakeClient(...answers: Array<ReleaseResult | (() => never)>) {
  const call = vi.fn(async (_op: string, _scope: unknown, _req: ReleaseRequest) => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (typeof a === 'function') a();
    return a as ReleaseResult;
  });
  return { client: { call } as unknown as StoreClient, call };
}
const ctx = (over: { deadline?: number } = {}) => ({
  deadline: Infinity, now: () => performance.now(), sleep: async () => {}, report: vi.fn(), raised: vi.fn(), ...over,
});

describe('lifecycle', () => {
  it('lifecycle: created goes to running, stopping, stopped in order', () => {
    const l = new Lifecycle();
    expect(l.state).toBe('created');
    l.start();
    expect(l.state).toBe('running');
    expect(l.beginStop()).toBe(true);
    expect(l.state).toBe('stopping');
    expect(l.beginStop()).toBe(false);
    l.finish();
    expect(l.state).toBe('stopped');
  });

  it('lifecycle: stop from created goes to stopped without running', () => {
    const l = new Lifecycle();
    expect(l.beginStop()).toBe(true);
    l.finish();
    expect(l.state).toBe('stopped');
  });

  it('lifecycle: start after stopping throws WorkerClosedError', () => {
    const l = new Lifecycle();
    l.start();
    l.beginStop();
    expect(() => l.start()).toThrow(expect.objectContaining({ code: 'WORKER_CLOSED' }));
    l.finish();
    expect(() => l.start()).toThrow(expect.objectContaining({ code: 'WORKER_CLOSED' }));
  });
});

describe('shutdown options', () => {
  it('shutdown: options default to 30 s timeout, 2 s grace and no signals', async () => {
    const q = new Queue('q', { logger: silent });
    expect(q.internals).toMatchObject({ shutdownTimeout: 25_000, shutdownAbortGrace: 2_000, signals: [] });
    const set = new Queue('r', { logger: silent, shutdownTimeout: '5s', shutdownAbortGrace: 0, signals: ['SIGTERM'] });
    expect(set.internals).toMatchObject({ shutdownTimeout: 5_000, shutdownAbortGrace: 0, signals: ['SIGTERM'] });
    const w = q.process(() => 1, { shutdownTimeout: 100, shutdownAbortGrace: '1s', autorun: false });
    await w.close();
    await Promise.all([q.close(), set.close()]);
  });

  it('shutdown: unknown option shutdownTimout throws InvalidOptionError suggesting shutdownTimeout', () => {
    expect(() => new Queue('q', { shutdownTimout: 1 } as never)).toThrow(/did you mean "shutdownTimeout"/);
    const q = new Queue('q', { logger: silent });
    expect(() => q.process(() => 1, { shutdownTimout: 1 } as never)).toThrow(/did you mean "shutdownTimeout"/);
    // signals are a queue option only
    expect(() => q.process(() => 1, { signals: ['SIGTERM'] } as never)).toThrow(InvalidOptionError);
  });

  it('shutdown: signals rejects an unknown signal name', () => {
    const e = (() => {
      try {
        new Queue('q', { signals: ['SIGTERM', 'SIGNOPE'] as never });
      } catch (x) {
        return x as InvalidOptionError;
      }
    })();
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect(e!.issues[0]).toMatchObject({ path: 'signals[1]' });
    // a signal a process cannot catch is not a valid name either
    expect(() => new Queue('q', { signals: ['SIGKILL'] as never })).toThrow(InvalidOptionError);
  });
});

describe('releaseLease', () => {
  it('shutdown: release repeats the same request after an unknown outcome and reports released once', async () => {
    const { client, call } = fakeClient(() => {
      throw unknown();
    }, { ok: true, state: 'waiting', runAt: 1, now: 1, repeated: true });
    const c = ctx();
    expect(await releaseLease(client, scope, req, c)).toBe('released');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]).toEqual(['release', scope, req]);
    expect(call.mock.calls[1]).toEqual(['release', scope, req]);
    expect(c.report).not.toHaveBeenCalled();
    expect(c.raised).not.toHaveBeenCalled();
  });

  it('shutdown: release gives up as unconfirmed at the deadline', async () => {
    const { client, call } = fakeClient(() => {
      throw unknown();
    });
    const c = ctx({ deadline: 0 });
    expect(await releaseLease(client, scope, req, c)).toBe('unconfirmed');
    expect(call).toHaveBeenCalledTimes(1);
    expect(c.report).toHaveBeenCalledTimes(1);
    expect(c.report.mock.calls[0]![0]).toMatchObject({ code: 'STORE_UNAVAILABLE', operation: 'release', jobId: 'j1' });
    expect(c.raised).not.toHaveBeenCalled();
  });

  it('shutdown: stale release is rejected, not an error', async () => {
    const { client } = fakeClient({ ok: false, reason: 'expired' });
    const c = ctx();
    expect(await releaseLease(client, scope, req, c)).toBe('rejected');
    expect(c.report).not.toHaveBeenCalled();
    expect(c.raised).not.toHaveBeenCalled();
  });

  it('shutdown: a store error that cannot be retried is handed to raised, not reported', async () => {
    const boom = new StoreError('boom', { operation: 'release', retryable: false, outcomeUnknown: false });
    const { client } = fakeClient(() => {
      throw boom;
    });
    const c = ctx();
    expect(await releaseLease(client, scope, req, c)).toBe('unconfirmed');
    expect(c.raised).toHaveBeenCalledWith(boom);
    expect(c.report).not.toHaveBeenCalled();
  });
});
