import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryStore } from '@sureq/core';
import { GROUPS } from '../../src/groups/index.js';
import { ConformanceTimeoutError } from '../../src/register.js';
import { runGroups } from '../../src/run.js';
import type { ConformanceOptions, ConformanceReport } from '../../src/types.js';
import { collect } from './collect.js';

export interface RunResult {
  failed: string[];
  passed: string[];
  skipped: string[];
  /** Failed tests whose error is neither an assertion nor a timeout: the harness crashed instead of catching the bug. */
  harnessErrors: string[];
  /** Failed tests that ran out of time. */
  timeouts: string[];
  errors: Record<string, unknown>;
  report: ConformanceReport;
}

const dir = mkdtempSync(join(tmpdir(), 'sureq-run-'));
let runs = 0;

/** Run the whole suite against `make`'s stores; `only` limits which titles execute. */
export async function runAgainst(
  make: (opts: { clock?: () => number }) => MemoryStore,
  only: readonly string[] | ((title: string) => boolean) | null,
  over: Partial<ConformanceOptions> = {},
): Promise<RunResult> {
  const report = join(dir, `run-${++runs}.json`);
  const filter = only === null ? undefined : typeof only === 'function' ? only : (title: string) => only.includes(title);
  const out = await collect(
    (runner) =>
      runGroups(
        {
          name: 'memory',
          runner,
          report,
          createStore: async (ctx) => {
            const clock = ctx.clock;
            const store = make(clock ? { clock: () => clock.now() } : {});
            await store.open();
            return { store, cleanup: () => store.close() };
          },
          ...over,
        },
        GROUPS,
      ),
    filter,
  );
  const by = (o: string) => Object.keys(out.results).filter((t) => out.results[t] === o);
  const failed = by('fail');
  return {
    failed,
    passed: by('pass'),
    skipped: by('skip'),
    harnessErrors: failed.filter((t) => !(out.errors[t] instanceof assert.AssertionError || out.errors[t] instanceof ConformanceTimeoutError)),
    timeouts: failed.filter((t) => out.errors[t] instanceof ConformanceTimeoutError),
    errors: out.errors,
    report: JSON.parse(readFileSync(report, 'utf8')) as ConformanceReport,
  };
}
