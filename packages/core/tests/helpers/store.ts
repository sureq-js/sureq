import type { AddOutcome, ClaimRequest, JobCounts, JobRecord, NewJob, Scope, Store } from '../../src/store/contract.js';
import { expect } from 'vitest';
import { parsePayload, payloadText } from '../../src/job/job.js';
import type { SerializedError } from '../../src/serialize/error.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { effective } from '../../src/store/memory/transitions.js';

/** A hand-driven clock: set `c.t`. */
export const fakeClock = (start = 1000) => {
  const c = { t: start };
  return { c, clock: () => c.t };
};

export const SCOPE: Scope = { namespace: 'n', queue: 'q' };
export const ZERO: JobCounts = { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 };

let jobs = 0;
/** A contract job with a fresh id `j<n>`. */
export const newJob = (over: Partial<NewJob> = {}): NewJob => ({ id: `j${++jobs}`, data: '{"n":1}', formatVersion: 1, maxAttempts: 3, ...over });

/** The records of an add whose every outcome must be `added`. */
export const added = (outcomes: AddOutcome[]): JobRecord[] =>
  outcomes.map((o) => {
    expect(o.status).toBe('added');
    return (o as { job: JobRecord }).job;
  });

let claims = 0;
/** A claim request with a fresh `claimId`, so repeats never collide. */
export const claimReq = (over: Partial<ClaimRequest> = {}): ClaimRequest => ({
  workerId: 'w1', limit: 10, leaseMs: 30_000, claimId: `c${++claims}`, ...over,
});

/** Claim with a fresh `claimId`; the claimed records. */
export const claimJobs = async (store: Store, scope: Scope, over: Partial<ClaimRequest> = {}): Promise<JobRecord[]> =>
  (await store.claim(scope, claimReq(over))).jobs;

type Decoded = Omit<JobRecord, 'data' | 'result' | 'error' | 'backoff'> & {
  data: string;
  result: string | null;
  error: SerializedError | null;
  backoff: unknown;
};
/** A stored record with text payloads and its JSON `error` and `backoff` decoded; `null` when absent. */
export async function stored(store: Store, scope: Scope, id: string): Promise<Decoded | null> {
  const rec = await store.get(scope, id);
  return rec && {
    ...rec, data: payloadText(rec.data), result: rec.result === null ? null : payloadText(rec.result),
    error: parsePayload(rec.error) as SerializedError | null, backoff: parsePayload(rec.backoff),
  };
}

/** A new MemoryStore, already open. */
export async function openStore(opts?: ConstructorParameters<typeof MemoryStore>[0]): Promise<MemoryStore> {
  const store = new MemoryStore(opts);
  await store.open();
  return store;
}

const STATE_LIST = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const;

/** `counts` equals the paged `list` totals and a recount of `dump()` by effective state (history records, `id#seq`, are not counted). */
export async function expectConsistent(store: MemoryStore): Promise<void> {
  const counts = await store.counts(SCOPE);
  const now = await store.now();
  const recount = Object.fromEntries(STATE_LIST.map((s) => [s, 0]));
  for (const rec of store.dump().jobs) if (!rec.id.includes('#')) recount[effective(rec, now)]!++;
  for (const state of STATE_LIST) {
    let total = 0;
    for (let offset = 0; ; offset += 100) {
      const page = await store.list(SCOPE, { state, offset, limit: 100, order: 'asc' });
      total += page.length;
      if (page.length < 100) break;
    }
    expect(total, state).toBe(counts[state]);
    expect(recount[state], state).toBe(counts[state]);
  }
}
