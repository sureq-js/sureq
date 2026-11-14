// Contract methods this template does not build yet. Each one rejects with `StoreRequestError` naming the
// operation.
// WHY: a store must have every method of the contract version it declares; when you build one, delete its
// name here and add its block to store.ts.
import type { Store } from '@sureq/core';
import { bad } from './check.js';

export const PENDING = [] as const satisfies readonly (keyof Store)[];
export type PendingOp = (typeof PENDING)[number];

/** Define every pending method once on the store's prototype and return the store. */
export function withPending<T extends object>(store: T): T & Pick<Store, PendingOp> {
  const proto = Object.getPrototypeOf(store) as object;
  for (const op of PENDING) {
    if (Object.hasOwn(proto, op)) continue;
    const value = async (): Promise<never> => bad(op, `${op} is not implemented`);
    Object.defineProperty(proto, op, { value, writable: true, configurable: true });
  }
  return store as T & Pick<Store, PendingOp>;
}
