import { join } from 'node:path';
import { MemoryStore } from '@sureq/core';
import { GROUPS } from '../../src/groups/index.js';
import { runStoreConformance } from '../../src/index.js';

/** Register the suite with every group skipped: enough to prove the runner wiring and the report. */
export function smoke(runnerName: string): void {
  runStoreConformance({
    name: `smoke-${runnerName}`,
    createStore: async () => {
      const store = new MemoryStore();
      return { store, cleanup: () => store.close() };
    },
    skip: GROUPS.map((g) => g.name),
    report: join(process.env['SMOKE_REPORT_DIR']!, `${runnerName}.json`),
  });
}
