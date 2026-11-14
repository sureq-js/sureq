import { describe, expect, it } from 'vitest';
import { InvalidOptionError, MemoryStore, Producer, Queue, defineCapabilities } from '../../src/index.js';
import { validateCapabilities } from '../../src/store/capabilities.js';

const FLAGS = [
  'transactions', 'skipLocked', 'notify', 'ttl', 'durable', 'shared', 'claimConstraints', 'boundedAdd', 'flows', 'logs',
  'archive', 'audit', 'metricsHistory', 'changeFeed', 'externalTransaction', 'migrations', 'singleNode', 'patch', 'deadlines',
  'queueRecords',
] as const;

const issuesOf = (fn: () => unknown): Array<{ path: string; code: string }> => {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidOptionError) return e.issues.map(({ path, code }) => ({ path, code }));
    throw e;
  }
  throw new TypeError('expected InvalidOptionError');
};

describe('capabilities', () => {
  it('capabilities: defineCapabilities fills defaults, validates and freezes', () => {
    const c = defineCapabilities({});
    for (const f of FLAGS) expect(c[f], f).toBe(false);
    expect(c.limits).toEqual({ maxIdBytes: 255, maxClaimLimit: 1000 });
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.limits)).toBe(true);
    expect(() => {
      (c as { transactions: boolean }).transactions = true;
    }).toThrow(TypeError);
    const input = { transactions: true, notify: true, limits: { maxIdBytes: 64 } };
    const d = defineCapabilities(input);
    expect([d.transactions, d.notify, d.skipLocked, d.limits]).toEqual([true, true, false, { maxIdBytes: 64, maxClaimLimit: 1000 }]);
    input.transactions = false;
    input.limits.maxIdBytes = 1;
    expect([d.transactions, d.limits.maxIdBytes]).toEqual([true, 64]);
  });

  it('capabilities: each call returns a separate frozen object', () => {
    const a = defineCapabilities({});
    const b = defineCapabilities({});
    expect(a).not.toBe(b);
    expect(a.limits).not.toBe(b.limits);
  });

  it('capabilities: unknown extra keys are ignored', () => {
    const c = defineCapabilities({ future: true, limits: { extra: 1 } } as never);
    expect(c).not.toHaveProperty('future');
    expect(c.limits).not.toHaveProperty('extra');
  });

  it('capabilities: missing or mistyped field throws InvalidOptionError naming it', () => {
    expect(issuesOf(() => defineCapabilities({ transactions: 'yes' } as never))).toEqual([{ path: 'transactions', code: 'invalid_type' }]);
    expect(issuesOf(() => defineCapabilities({ limits: { maxIdBytes: 64.5 } }))).toEqual([{ path: 'limits.maxIdBytes', code: 'invalid_type' }]);
    expect(issuesOf(() => defineCapabilities({ limits: { maxClaimLimit: 'x' } } as never))).toEqual([{ path: 'limits.maxClaimLimit', code: 'invalid_type' }]);
    expect(issuesOf(() => defineCapabilities({ notify: 1, limits: { maxIdBytes: 1 } } as never)).map((i) => i.path)).toEqual(['limits.maxIdBytes', 'notify']);
    expect(() => defineCapabilities(null as never)).toThrow(InvalidOptionError);
  });

  it('capabilities: an explicit null flag or limit is reported as invalid_type, not defaulted', () => {
    expect(issuesOf(() => defineCapabilities({ durable: null } as never))).toEqual([{ path: 'durable', code: 'invalid_type' }]);
    expect(issuesOf(() => defineCapabilities({ limits: { maxIdBytes: null } } as never))).toEqual([{ path: 'limits.maxIdBytes', code: 'invalid_type' }]);
    expect(issuesOf(() => defineCapabilities({ limits: null } as never))).toEqual([{ path: 'limits', code: 'invalid_type' }]);
  });

  it('capabilities: limits.maxIdBytes below 36 is rejected', () => {
    expect(issuesOf(() => defineCapabilities({ limits: { maxIdBytes: 35 } }))).toEqual([{ path: 'limits.maxIdBytes', code: 'out_of_range' }]);
    expect(defineCapabilities({ limits: { maxIdBytes: 36 } }).limits.maxIdBytes).toBe(36);
  });

  it('capabilities: limits.maxClaimLimit below 1 or non-integer is rejected', () => {
    expect(issuesOf(() => defineCapabilities({ limits: { maxClaimLimit: 0 } }))).toEqual([{ path: 'limits.maxClaimLimit', code: 'out_of_range' }]);
    expect(issuesOf(() => defineCapabilities({ limits: { maxClaimLimit: 1.5 } }))).toEqual([{ path: 'limits.maxClaimLimit', code: 'invalid_type' }]);
    expect(defineCapabilities({ limits: { maxClaimLimit: 1 } }).limits.maxClaimLimit).toBe(1);
  });

  it('capabilities: a capabilities object that is not frozen is rejected when read', () => {
    const c = defineCapabilities({});
    expect(validateCapabilities(c, 'store')).toBe(c);
    expect(issuesOf(() => validateCapabilities({ ...c }, 'store'))).toEqual([{ path: 'capabilities', code: 'invalid_value' }]);
    expect(issuesOf(() => validateCapabilities(Object.freeze({ ...c, limits: { ...c.limits } }), 'store'))).toEqual([{ path: 'limits', code: 'invalid_value' }]);
    const { skipLocked: _skip, ...rest } = c;
    expect(issuesOf(() => validateCapabilities(Object.freeze(rest), 'store'))).toEqual([{ path: 'skipLocked', code: 'missing_option' }]);
    const bad = Object.freeze({ ...c, limits: Object.freeze({ ...c.limits, maxClaimLimit: 'x' }) });
    expect(issuesOf(() => validateCapabilities(bad, 'store'))).toEqual([{ path: 'limits.maxClaimLimit', code: 'invalid_type' }]);
    expect(() => validateCapabilities(undefined, 'MyStore')).toThrow(expect.objectContaining({ name: 'InvalidOptionError', scope: 'MyStore' }));
  });

  it('capabilities: a store with incomplete or unfrozen capabilities is refused at new Queue and new Producer', () => {
    const real = new MemoryStore();
    const withCaps = (capabilities: unknown) =>
      new Proxy(real, { get: (t, k) => (k === 'capabilities' ? capabilities : Reflect.get(t, k)) });
    const c = defineCapabilities({});
    const { skipLocked: _skip, ...rest } = c;
    const incomplete = withCaps(Object.freeze({ durable: false }));
    expect(issuesOf(() => new Queue('q', { store: incomplete }))).toContainEqual({ path: 'store.capabilities.skipLocked', code: 'missing_option' });
    expect(issuesOf(() => new Queue('q', { store: incomplete }))).toContainEqual({ path: 'store.capabilities.limits', code: 'missing_option' });
    expect(issuesOf(() => new Queue('q', { store: withCaps(Object.freeze(rest)) }))).toEqual([{ path: 'store.capabilities.skipLocked', code: 'missing_option' }]);
    expect(issuesOf(() => new Queue('q', { store: withCaps({ ...c }) }))).toEqual([{ path: 'store.capabilities', code: 'invalid_value' }]);
    expect(issuesOf(() => new Producer('q', { store: withCaps({ ...c }) }))).toEqual([{ path: 'store.capabilities', code: 'invalid_value' }]);
  });

  it('capabilities: the six declared flags of the memory store are accepted', () => {
    const c = defineCapabilities({ transactions: true, skipLocked: true, notify: true, ttl: false, durable: false, shared: false });
    expect(c).toEqual({ ...Object.fromEntries(FLAGS.map((f) => [f, false])), transactions: true, skipLocked: true, notify: true, limits: { maxIdBytes: 255, maxClaimLimit: 1000 } });
  });
});
