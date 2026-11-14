import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ClaimRequest, ClaimResult, JobRecord, JobState, NewJob, Scope, Store, StoreCapabilities } from '@sureq/core';
import type { HarnessContext, StoreHandle, TestClock } from './types.js';

/** What a group test sees: one store, a unique namespace and helpers. */
export interface TestEnv {
  readonly mode: 'fake' | 'real';
  readonly store: Store;
  readonly caps: StoreCapabilities;
  readonly clock: TestClock | null;
  readonly concurrency: number;
  readonly iterations: number;
  readonly timeScale: number;
  /** The lease length tests use: 1000 ms times `timeScale`. */
  readonly leaseMs: number;
  /** `ConformanceOptions.core`: builds a core queue over a store in a scope; tests that need it run only when it is given. */
  readonly core: ((store: Store, scope: Scope) => unknown) | undefined;
  /** A scope in this test's namespace; no queue name gives a new unique queue. */
  scope(queue?: string, namespace?: string): Scope;
  /** `n` store objects on one backend when the store is shared, else `n` references to `store`. */
  pods(n?: number): Promise<Store[]>;
  /** Fake mode: advance the clock. Real mode: really wait. */
  elapse(ms: number): Promise<void>;
  job(over?: Partial<NewJob>): NewJob;
  addJobs(scope: Scope, n: number, over?: Partial<NewJob>): Promise<JobRecord[]>;
  claim(scope: Scope, over?: Partial<ClaimRequest>): Promise<ClaimResult>;
  /** Shift this process's `Date.now` and `performance.timeOrigin` by `ms` while `body` runs. */
  skewPodClock(ms: number, body: () => Promise<void>): Promise<void>;
  /** A new store object over the same data (`StoreHandle.reopen`). */
  reopen(): Promise<Store>;
  /** A store straight from `createStore`, not opened by the harness; the group's clock unless one is given. */
  freshStore(opts?: { clock?: TestClock | null }): Promise<Store>;
}

/** What the harness knows about one group run. */
export interface GroupRun {
  mode: 'fake' | 'real';
  handle: StoreHandle;
  clock: TestClock | null;
  createStore: (ctx: HarnessContext) => Promise<StoreHandle>;
  concurrency: number;
  iterations: number;
  timeScale: number;
  core?: ((store: Store, scope: Scope) => unknown) | undefined;
}

export const newId = (): string => randomUUID().replaceAll('-', '');

const ACTIVE_STATES: readonly JobState[] = ['active', 'waiting', 'delayed'];
const FINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled'];
const ZERO_COUNTS = { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 };

/** Build one test's environment; `dispose` removes every job the test left and closes extra stores. */
export function makeEnv(run: GroupRun): { env: TestEnv; dispose: () => Promise<void> } {
  const store = run.handle.store;
  const caps = store.capabilities;
  const scopeId = newId();
  const scopes = new Map<string, Scope>();
  const extra: StoreHandle[] = [];
  const pods = new Map<number, Store[]>();
  let queues = 0;

  const open = async (clock: TestClock | null): Promise<StoreHandle> => {
    const h = await run.createStore({ clock, scopeId: newId() });
    extra.push(h);
    return h;
  };

  const env: TestEnv = {
    mode: run.mode,
    store,
    caps,
    clock: run.clock,
    concurrency: run.concurrency,
    iterations: run.iterations,
    timeScale: run.timeScale,
    leaseMs: 1000 * run.timeScale,
    core: run.core,
    scope(queue, namespace) {
      const s = { namespace: namespace === undefined ? `conf-${scopeId}` : `conf-${scopeId}-${namespace}`, queue: queue ?? `q${++queues}` };
      scopes.set(`${s.namespace}\u0000${s.queue}`, s);
      return s;
    },
    async pods(n = run.concurrency) {
      if (!caps.shared) return Array.from({ length: n }, () => store);
      // one set per size for the whole test: race iterations reuse it instead of opening n stores each time
      const cached = pods.get(n);
      if (cached) return cached;
      const out: Store[] = [];
      for (let i = 0; i < n; i++) {
        const h = await open(run.clock);
        await h.store.open();
        out.push(h.store);
      }
      pods.set(n, out);
      return out;
    },
    async elapse(ms) {
      if (run.clock) run.clock.advance(ms);
      else await sleep(ms);
    },
    job(over = {}) {
      return { id: newId(), data: '{}', formatVersion: 1, maxAttempts: 3, ...over };
    },
    async addJobs(scope, n, over = {}) {
      const outcomes = await store.add(scope, Array.from({ length: n }, () => env.job(over)));
      return outcomes.map((o) => {
        assert.equal(o.status, 'added', 'addJobs: every job is added');
        return (o as { job: JobRecord }).job;
      });
    },
    claim(scope, over = {}) {
      return store.claim(scope, { workerId: 'w1', limit: 1, leaseMs: env.leaseMs, claimId: newId(), ...over });
    },
    async skewPodClock(ms, body) {
      const realNow = Date.now;
      const origin = performance.timeOrigin;
      Date.now = () => realNow() + ms;
      Object.defineProperty(performance, 'timeOrigin', { value: origin + ms, configurable: true });
      try {
        await body();
      } finally {
        Date.now = realNow;
        delete (performance as { timeOrigin?: number }).timeOrigin;
      }
    },
    async reopen() {
      assert.ok(run.handle.reopen, 'the store declares durable, so StoreHandle.reopen must be provided');
      return run.handle.reopen();
    },
    async freshStore(opts = {}) {
      return (await open(opts.clock === undefined ? run.clock : opts.clock)).store;
    },
  };

  const dispose = async (): Promise<void> => {
    try {
      for (const scope of scopes.values()) await drain(store, scope, caps.limits.maxClaimLimit);
    } finally {
      for (const h of extra.splice(0)) await h.cleanup();
    }
  };
  return { env, dispose };
}

/** Cancel what is pending, remove everything, then check the scope is empty. */
async function drain(store: Store, scope: Scope, page: number): Promise<void> {
  const sweepStates = async (states: readonly JobState[], op: (id: string) => Promise<unknown>): Promise<void> => {
    for (const state of states) {
      let last = '';
      for (;;) {
        const jobs = await store.list(scope, { state, offset: 0, limit: page, order: 'asc' });
        const key = jobs.map((j) => j.id).join(',');
        if (jobs.length === 0 || key === last) break; // no progress: the leftover check reports it
        last = key;
        await Promise.all(jobs.map((j) => op(j.id)));
      }
    }
  };
  // A store that drops writes needs more than one round.
  for (let round = 0; round < 5; round++) {
    await sweepStates(ACTIVE_STATES, (id) => store.cancel(scope, { id }));
    await sweepStates(FINAL_STATES, (id) => store.remove(scope, { id }));
    const counts = await store.counts(scope);
    if (Object.values(counts).every((n) => n === 0)) return;
  }
  assert.deepEqual({ ...(await store.counts(scope)) }, ZERO_COUNTS, `test left jobs behind in ${scope.namespace}/${scope.queue}`);
}
