import type { FaultHooks, StoreOp } from '../../src/store/types.js';

/**
 * A `faults.before` hook that throws whatever `rule` returns for the 1-based call number of each
 * store operation (undefined = let the call through). Use: `new MemoryStore({ faults: failing(...) })`.
 */
export function failing(rule: (op: StoreOp, call: number) => unknown): FaultHooks {
  const calls = new Map<StoreOp, number>();
  return {
    before(op) {
      const n = (calls.get(op) ?? 0) + 1;
      calls.set(op, n);
      const err = rule(op, n);
      if (err !== undefined) throw err;
    },
  };
}
