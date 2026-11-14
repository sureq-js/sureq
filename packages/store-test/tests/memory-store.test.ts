import { MemoryStore, Queue } from '@sureq/core';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { runStoreConformance } from '../src/index.js';

// The built-in memory store against the whole suite; `test:stress` runs its stress group at release size.
// The 100k-job tests outlast Vitest's 5 s default under coverage; the suite enforces its own limit per test.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

runStoreConformance({
  name: 'MemoryStore',
  runner: { describe, it, before: beforeAll, after: afterAll },
  // the opt-in stress group too
  groups: ['stress'],
  createStore: async (ctx) => {
    const store = new MemoryStore(ctx.clock ? { clock: () => ctx.clock!.now() } : {});
    await store.open();
    return { store, cleanup: () => store.close() };
  },
  core: (store, { namespace, queue }) => new Queue(queue, { store, namespace, logger: false }),
});
