import { MemoryStore, type Scope } from '@sureq/core';
import type { ResolvedOptions } from '../../src/register.js';
import type { HarnessContext, RunnerHooks, StoreHandle } from '../../src/types.js';

/** A memory store factory that records every context and keeps the stores for inspection. */
export function memoryFactory() {
  const contexts: HarnessContext[] = [];
  const stores: MemoryStore[] = [];
  const createStore = async (ctx: HarnessContext): Promise<StoreHandle> => {
    contexts.push(ctx);
    const store = new MemoryStore(ctx.clock ? { clock: () => ctx.clock!.now() } : {});
    stores.push(store);
    return { store, cleanup: async () => {} };
  };
  return { contexts, stores, createStore };
}

export function resolved(runner: RunnerHooks, over: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    name: 'probe', createStore: memoryFactory().createStore, runner, concurrency: 20, iterations: 3, timeScale: 1, skip: [],
    groups: [], realTime: false, ...over,
  };
}

export const ZERO = { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 };
export type { Scope };
