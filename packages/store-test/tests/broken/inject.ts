import { MemoryStore } from '@sureq/core';

export interface BrokenStore {
  name: string;
  /** The overridden own methods (`constructor` when the constructor is the bug). */
  methods: readonly string[];
  /** Exact titles of the tests that must fail against this store. */
  mustFail: readonly string[];
  make(opts: { clock?: () => number }): MemoryStore;
}

type Ctor = new (opts: { clock?: () => number }) => MemoryStore;

/** Declare one broken store: a direct MemoryStore subclass carrying exactly one injected bug. */
export function inject(name: string, methods: readonly string[], mustFail: readonly string[], cls: Ctor): BrokenStore {
  return { name, methods, mustFail, make: (opts) => new cls(opts) };
}

export const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
export const FOREVER = Number.MAX_SAFE_INTEGER;
