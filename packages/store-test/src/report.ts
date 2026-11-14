import { writeFile } from 'node:fs/promises';
import { STORE_CONTRACT_VERSION, type StoreCapabilities } from '@sureq/core';
import type { ConformanceReport } from './types.js';

/** The conformance suite's own version, written to the report; it grows when tests are added. */
export const SUITE_VERSION: string = '1';

export function buildReport(input: {
  name: string;
  caps: StoreCapabilities | null;
  passed: number;
  failed: number;
  skipped: number;
  skippedGroups: string[];
  mode: 'fake' | 'real';
  modes: ConformanceReport['modes'];
  concurrency: number;
  skippedNonGated: string[];
}): ConformanceReport {
  const { modes, concurrency } = input;
  return {
    suite: SUITE_VERSION,
    contractVersion: STORE_CONTRACT_VERSION,
    store: input.name,
    capabilities: input.caps,
    passed: input.passed,
    failed: input.failed,
    skipped: input.skipped,
    skippedGroups: input.skippedGroups,
    conformant:
      input.failed === 0 && input.skippedNonGated.length === 0 && concurrency >= 10 && modes.clock === 'real' && modes.lease === 'real',
    mode: input.mode,
    modes,
    concurrency,
  };
}

export async function writeReport(path: string, r: ConformanceReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(r, null, 2)}\n`);
}
