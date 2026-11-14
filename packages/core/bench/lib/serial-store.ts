import type { ClaimRequest, ClaimResult, Scope, Store } from '../../src/store/contract.js';
import { defineCapabilities } from '../../src/store/capabilities.js';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A store whose `claim` is wrapped by a function; every other member (and `subscribe`, if any) is the inner one. */
function wrap<T extends object>(inner: Store, claim: (scope: Scope, req: ClaimRequest) => Promise<ClaimResult>, extra: T, caps?: Store['capabilities']): Store & T {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'claim') return claim;
      if (prop === 'capabilities' && caps) return caps;
      if (prop in extra) return (extra as Record<PropertyKey, unknown>)[prop];
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Store & T;
}

/**
 * Models a database whose claims serialise per scope: one claim at a time holds the scope's lock for
 * `baseMs + rowMs x jobs` of real time. Everything else is delegated untouched.
 */
export function serialStore(inner: Store, opts: { baseMs: number; rowMs: number; skipLocked: boolean }): Store & { lockWaitMs(): number[] } {
  const tails = new Map<string, Promise<void>>();
  const waits: number[] = [];
  const claim = async (scope: Scope, req: ClaimRequest): Promise<ClaimResult> => {
    const asked = performance.now();
    const key = `${scope.namespace}/${scope.queue}`;
    const before = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    tails.set(key, new Promise<void>((resolve) => (release = resolve)));
    await before;
    waits.push(performance.now() - asked);
    try {
      const res = await inner.claim(scope, req);
      await wait(opts.baseMs + opts.rowMs * res.jobs.length);
      return res;
    } finally {
      release();
    }
  };
  return wrap(inner, claim, { lockWaitMs: () => waits }, defineCapabilities({ ...inner.capabilities, skipLocked: opts.skipLocked }));
}

/** Counts claim calls, empty answers and the time of each call per worker; optionally clamps the request `limit`. */
export function observeClaims(inner: Store, opts: { limit?: number } = {}): Store & { stats(): { calls: number; empty: number; at: Map<string, number> } } {
  const s = { calls: 0, empty: 0, at: new Map<string, number>() };
  const claim = async (scope: Scope, req: ClaimRequest): Promise<ClaimResult> => {
    s.calls++;
    s.at.set(req.workerId, performance.now());
    const res = await inner.claim(scope, opts.limit === undefined ? req : { ...req, limit: Math.min(req.limit, opts.limit) });
    if (res.jobs.length === 0) s.empty++;
    return res;
  };
  return wrap(inner, claim, { stats: () => s });
}

/** Counts every function call on the store by member name; everything is delegated untouched. */
export function countCalls<S extends Store>(inner: S): S & { calls(): Record<string, number> } {
  const counts: Record<string, number> = {};
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'calls') return () => ({ ...counts });
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      return (...args: unknown[]) => {
        counts[prop] = (counts[prop] ?? 0) + 1;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as S & { calls(): Record<string, number> };
}
