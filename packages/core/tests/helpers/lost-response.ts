import { StoreUnavailableError } from '../../src/errors/catalog.js';
import type { Store } from '../../src/store/contract.js';

/** A view of `store` whose first `times` calls of `op` are applied and then answered with a lost response. */
export function withLostResponses(store: Store, op: keyof Store, times: number): Store {
  let left = times;
  return new Proxy(store, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      const fn = (v as (...a: unknown[]) => Promise<unknown>).bind(target);
      if (prop !== op) return fn;
      return async (...args: unknown[]) => {
        const r = await fn(...args);
        if (left-- > 0) throw new StoreUnavailableError('response lost', { operation: String(op), retryable: true, outcomeUnknown: true });
        return r;
      };
    },
  });
}
