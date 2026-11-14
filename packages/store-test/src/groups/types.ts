import type { TestEnv } from '../harness.js';

export type CapabilityGate = 'transactions' | 'skipLocked' | 'notify' | 'durable' | 'shared';

export interface TestOptions {
  /** Run only when the flag is true; otherwise counted skipped. */
  requires?: CapabilityGate;
  /** Run only when the flag is false. */
  absent?: CapabilityGate;
  /** Needs `ConformanceOptions.core`; without it the test is left out and `<group>:core` is listed in `skippedGroups`. */
  core?: true;
  /** Needs a store that follows an injected clock; skipped under `realTime` without costing conformance. */
  fakeClock?: true;
  /** Per-test time limit; multiplied by `timeScale` in real mode. */
  timeoutMs?: number;
}

export interface GroupApi {
  test(title: string, body: (env: TestEnv) => Promise<void>, opts?: TestOptions): void;
  race(title: string, body: (env: TestEnv, iteration: number) => Promise<void>, opts?: TestOptions): void;
}

export interface ConformanceGroup {
  /** 'contract', 'claim', ...; titles start with an area name and a colon, normally this one. */
  readonly name: string;
  /** 'real' makes the group's store use its real clock (`createStore` gets `clock: null`). */
  readonly mode: 'fake' | 'real';
  /** Runs only when named in `options.groups`. */
  readonly optIn?: boolean;
  register(t: GroupApi): void;
}
