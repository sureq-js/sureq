import { GROUPS } from './groups/index.js';
import { runGroups } from './run.js';
import type { ConformanceOptions } from './types.js';

export type { ConformanceOptions, ConformanceReport, HarnessContext, RunnerHooks, StoreHandle, TestClock } from './types.js';
export { SUITE_VERSION } from './report.js';

/** Register the store conformance suite with the test runner; a contract violation is a test failure. */
export function runStoreConformance(options: ConformanceOptions): void {
  runGroups(options, GROUPS);
}
