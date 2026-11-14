import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError, StoreUnavailableError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { resolveLeases, workerOptionsSchema, resolveQueueOptions } from '../../src/queue/options.js';
import type { ClaimRequest, Scope } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { validate } from '../../src/util/validate.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const leases = (queue: object, worker: object, names: (string | null)[] = ['a', 'b']) =>
  resolveLeases(resolveQueueOptions('q', queue), validate('w', worker, workerOptionsSchema), names);

function issuePath(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidOptionError);
    return (e as InvalidOptionError).issues[0]?.path;
  }
  return undefined;
}

describe('lease options', () => {
  it('lease-config: precedence is name over worker over queue over default', () => {
    expect(leases({}, {}).leaseMsFor('a')).toBe(30_000);
    expect(leases({}, {}).leaseMsFor(null)).toBe(30_000);
    expect(leases({ leaseDuration: '45s' }, {}).leaseMsFor('a')).toBe(45_000);
    expect(leases({ leaseDuration: '45s' }, { leaseDuration: '20s' }).leaseMsFor('a')).toBe(20_000);
    const w = { leaseDuration: '20s', leaseDurationByName: { a: '5s' } };
    expect(leases({ leaseDuration: '45s' }, w).leaseMsFor('a')).toBe(5000);
    expect(leases({ leaseDuration: '45s' }, w).leaseMsFor('b')).toBe(20_000);
    const both = leases({ leaseDurationByName: { a: '9s', b: '9s' } }, w);
    expect(both.leaseMsFor('a')).toBe(5000);
    expect(both.leaseMsFor('b')).toBe(9000);
    expect(both.leaseMsFor(null)).toBe(20_000);
    expect(both.minLeaseMs).toBe(5000);
    expect(both.leaseMsByName).toEqual({ a: 5000, b: 9000 });
  });

  it('lease-config: invalid, too small or too large values throw InvalidOptionError', () => {
    for (const [value, path] of [
      [{ leaseDuration: 999 }, 'leaseDuration'],
      [{ leaseDuration: 86_400_001 }, 'leaseDuration'],
      [{ leaseDuration: 1500.5 }, 'leaseDuration'],
      [{ leaseDuration: 'soon' }, 'leaseDuration'],
      [{ leaseDurationByName: { 'bad name': 1000 } }, 'leaseDurationByName.bad name'],
      [{ leaseDurationByName: { a: 500 } }, 'leaseDurationByName.a'],
      [{ leaseDurationByName: { a: 'soon' } }, 'leaseDurationByName.a'],
      [{ leaseDurationByName: [] }, 'leaseDurationByName'],
    ] as const) {
      expect.soft(issuePath(() => new Queue('q', { logger: silent, ...value } as never)), JSON.stringify(value)).toBe(path);
      const q = new Queue('q', { logger: silent });
      queues.push(q);
      expect.soft(issuePath(() => q.process(() => {}, { autorun: false, ...value } as never)), JSON.stringify(value)).toBe(path);
    }
    expect(leases({ leaseDuration: '1d' }, { leaseDuration: 1000 }).leaseMsFor(null)).toBe(1000);
  });

  it('lease-config: claim sends leaseMs and leaseMsByName for handled names only', async () => {
    vi.useFakeTimers();
    const spy = spyStore(new MemoryStore());
    const q = new Queue('c', { store: spy.store, logger: silent });
    queues.push(q);
    const w = q.process({ a: () => {}, b: () => {} }, { ...poll(60_000), leaseDuration: '30s', leaseDurationByName: { a: '5s', z: '9s' } });
    await vi.advanceTimersByTimeAsync(10);
    const req = spy.calls.find((c) => c.op === 'claim')!.args[1] as ClaimRequest;
    expect(req.leaseMs).toBe(30_000);
    expect(req.leaseMsByName).toEqual({ a: 5000 });
    await w.close();
    const plain = q.process(() => {}, poll(60_000));
    await vi.advanceTimersByTimeAsync(10);
    const req2 = spy.calls.filter((c) => c.op === 'claim').at(-1)!.args[1] as ClaimRequest;
    expect(req2.leaseMs).toBe(30_000);
    expect('leaseMsByName' in req2).toBe(false);
    await plain.close();
  });

  it('claim: claimId is not reused once the shortest lease has passed', async () => {
    vi.useFakeTimers();
    let perf = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => perf);
    const run = async (lostFor: number) => {
      let lose = true;
      const inner = new MemoryStore();
      const spy = spyStore(inner, {
        claim: async (s: Scope, r: ClaimRequest) => {
          if (!lose) return inner.claim(s, r);
          lose = false;
          perf += lostFor;
          throw new StoreUnavailableError('lost', { operation: 'claim', retryable: true, outcomeUnknown: true });
        },
      });
      const q = new Queue('c', { store: spy.store, logger: silent, leaseDuration: 1000 });
      queues.push(q);
      const w = q.process(() => {}, poll(60_000));
      w.on('error', () => {});
      await vi.advanceTimersByTimeAsync(200);
      await w.close();
      const [lost, retry] = spy.calls.filter((c) => c.op === 'claim').map((c) => c.args[1] as ClaimRequest);
      return retry!.claimId === lost!.claimId;
    };
    expect(await run(600)).toBe(true);
    expect(await run(1200)).toBe(false);
  });
});
