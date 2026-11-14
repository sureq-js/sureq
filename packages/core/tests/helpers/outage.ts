import type { Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';

export type OutageCtl = {
  /** Every store call is refused with a connection error while true. */
  down: boolean;
  /** Which calls fail; by default every call while `down`. */
  failing: (op: string) => boolean;
  /** Each store call: its name and the pod's monotonic time. */
  calls: Array<{ op: string; at: number }>;
};

/** A store whose calls throw `TypeError('down')` while `ctl.down` (`subscribe` and `close` are never refused). */
export function outageStore(inner: Store = new MemoryStore()): { store: Store; ctl: OutageCtl } {
  const ctl: OutageCtl = { down: false, failing: () => ctl.down, calls: [] };
  const store = new Proxy(inner, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== 'function' || prop === 'subscribe' || prop === 'close') return typeof v === 'function' ? v.bind(target) : v;
      const op = String(prop);
      return (...args: unknown[]) => {
        ctl.calls.push({ op, at: performance.now() });
        if (ctl.failing(op)) return Promise.reject(new TypeError('down'));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, ctl };
}

/** The gaps between consecutive calls of `op`, starting from `from`. */
export function gaps(ctl: OutageCtl, op: string, from: number): number[] {
  const at = ctl.calls.filter((c) => c.op === op && c.at > from).map((c) => c.at);
  return at.map((t, i) => t - (i === 0 ? from : at[i - 1]!));
}
