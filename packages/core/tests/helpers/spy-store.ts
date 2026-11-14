import type { Store } from '../../src/store/contract.js';

type Method = Exclude<keyof Store, 'contractVersion' | 'capabilities'>;
type Overrides = Partial<{ [K in Method]: (...a: Parameters<NonNullable<Store[K]>>) => ReturnType<NonNullable<Store[K]>> }>;
export type SpyCall = { op: string; args: unknown[]; at: number };

const METHODS: readonly Method[] = [
  'open', 'close', 'now', 'add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'get', 'list',
  'counts', 'setPaused', 'isPaused', 'subscribe', 'stats', 'getAttempts', 'clean', 'obliterate', 'redrive', 'setProgress', 'registerWorker',
  'heartbeatWorker', 'unregisterWorker', 'listWorkers', 'purgeWorkers', 'ensureNamespaceMeta', 'getNamespaceMeta', 'putSchedule',
  'getSchedule', 'listSchedules', 'deleteSchedule', 'listDueSchedules', 'fireSchedule',
];

/**
 * A delegating Store that records every call (`at` is the test's `Date.now()`) and lets a test
 * replace any method. An override can call `inner` itself.
 */
export function spyStore(inner: Store, over: Overrides = {}): { store: Store; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const store: Record<string, unknown> = {
    get contractVersion() {
      return inner.contractVersion;
    },
    get capabilities() {
      return inner.capabilities;
    },
  };
  for (const op of METHODS) {
    const fn = (over[op] ?? inner[op]?.bind(inner)) as ((...a: unknown[]) => unknown) | undefined;
    if (!fn) continue;
    store[op] = (...args: unknown[]) => {
      calls.push({ op, args, at: Date.now() });
      return fn(...args);
    };
  }
  return { store: store as unknown as Store, calls };
}
