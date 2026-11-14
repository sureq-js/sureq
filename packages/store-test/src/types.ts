import type { Scope, Store, StoreCapabilities } from '@sureq/core';

/** The store's clock under test: the suite moves it to expire leases and reach due times. */
export interface TestClock {
  /** The current fake time, in epoch ms. */
  now(): number;
  /** Move the clock forward by `ms`. */
  advance(ms: number): void;
}

/** What `createStore` gets: the clock to use (`null` means the store's real clock) and a unique id. */
export interface HarnessContext {
  /** The clock the store must read; `null` means the store uses its real clock. */
  clock: TestClock | null;
  /** A unique id for this call, to keep stores of different tests apart. */
  scopeId: string;
}

/** What `createStore` returns. `reopen` is required when the store declares `durable`. */
export interface StoreHandle {
  /** The store under test. */
  store: Store;
  /** A new store object over the same data, as after a restart. Required when the store declares `durable`. */
  reopen?: () => Promise<Store>;
  /** Drop what this store created. Called when the group ends. */
  cleanup: () => Promise<void>;
}

/** The test runner functions the suite registers with. */
export interface RunnerHooks {
  /** Your runner's `describe`. */
  describe: (name: string, fn: () => void) => void;
  /** Your runner's `it` or `test`. */
  it: (name: string, fn: () => Promise<void> | void) => void;
  /** Your runner's `before` or `beforeAll`. */
  before: (fn: () => Promise<void> | void) => void;
  /** Your runner's `after` or `afterAll`. */
  after: (fn: () => Promise<void> | void) => void;
}

/** Options for `runStoreConformance`. */
export interface ConformanceOptions {
  /** The store's name, written to the report. */
  name: string;
  /** Called once per group (and once per extra pod or fresh store a test asks for). */
  createStore(ctx: HarnessContext): Promise<StoreHandle>;
  /** Defaults to the detected node:test, Vitest or Jest globals. */
  runner?: RunnerHooks;
  /** Simulated pods in race tests (default 20; at least 10 to be conformant). */
  concurrency?: number;
  /** Repeats per race test (default 200). */
  iterations?: number;
  /** Multiplies every real wait (default 1). */
  timeScale?: number;
  /** Groups to skip; only `capabilities:<flag>` names keep the run conformant. */
  skip?: string[];
  /** Extra opt-in groups to run; a name that is not a group throws `InvalidOptionError`. */
  groups?: string[];
  /** Run every group on the store's real clock (for stores whose clock cannot be faked). */
  realTime?: boolean;
  /** Builds a core queue over the store in the given scope (its namespace and queue name), for tests that need core's own loops. */
  core?: (store: Store, scope: Scope) => unknown;
  /** Path of the JSON report to write. */
  report?: string;
}

/** The JSON report written to the `report` path. */
export interface ConformanceReport {
  /** The suite version, `SUITE_VERSION`. */
  suite: string;
  /** The contract version of the `@sureq/core` the suite ran against, not the store's. */
  contractVersion: number;
  /** The `name` option. */
  store: string;
  /** The store's declared capabilities, or null when the run never read them. */
  capabilities: StoreCapabilities | null;
  /** Tests that passed. */
  passed: number;
  /** Tests that failed. */
  failed: number;
  /** Tests that were skipped. */
  skipped: number;
  /** Groups that did not run. */
  skippedGroups: string[];
  /** True only when nothing failed, no group other than a `capabilities:` gate was skipped, `concurrency` is at least 10, and the `clock` and `lease` groups ran in real time. */
  conformant: boolean;
  /** The clock mode of the run. */
  mode: 'fake' | 'real';
  /** The mode each part actually ran in. */
  modes: { clock: 'real' | 'fake'; lease: 'real' | 'fake'; rest: 'real' | 'fake' };
  /** Simulated pods in race tests. */
  concurrency: number;
}
