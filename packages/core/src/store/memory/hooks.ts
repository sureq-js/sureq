import type { JobRecord, JobState, ScheduleRecord, StoreMeta, StoredAttempt } from '../contract.js';

/** Every store operation a fault hook can intercept. */
export type StoreOp =
  | 'open' | 'close' | 'now' | 'add' | 'claim' | 'renew' | 'complete' | 'fail' | 'release' | 'sweep' | 'cancel' | 'remove'
  | 'update' | 'get' | 'list' | 'counts' | 'setPaused' | 'isPaused' | 'subscribe' | 'stats' | 'getAttempts' | 'clean' | 'obliterate'
  | 'redrive' | 'setProgress' | 'registerWorker' | 'heartbeatWorker' | 'unregisterWorker' | 'listWorkers' | 'purgeWorkers'
  | 'ensureNamespaceMeta' | 'getNamespaceMeta' | 'putSchedule' | 'getSchedule' | 'listSchedules' | 'deleteSchedule'
  | 'listDueSchedules' | 'fireSchedule';

/**
 * Test hooks around every operation. `before` throwing or delaying leaves state untouched;
 * `after` throwing means "the write was applied but the caller got an error" (unknown outcome).
 */
export interface FaultHooks {
  before?(op: StoreOp): void | Promise<void>;
  after?(op: StoreOp): void | Promise<void>;
}

/** The last finalising write of a deleted job, kept for `finalsTtl` so a repeat still gets its answer. */
export type Tombstone = {
  namespace: string;
  queue: string;
  id: string;
  seq: number;
  token: number;
  outcome: { kind: 'complete' | 'fail' | 'release'; state: JobState; runAt?: number };
  expiresAt: number;
};

/** A deep copy of everything the store holds, for tests. */
export type StoreSnapshot = { meta: Record<string, StoreMeta>; jobs: JobRecord[]; attempts: StoredAttempt[]; tombstones: Tombstone[]; schedules: ScheduleRecord[] };
