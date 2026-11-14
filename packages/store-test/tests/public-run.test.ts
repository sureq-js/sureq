import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityError, MemoryStore, Queue, defineCapabilities, type AddOutcome, type NewJob, type Scope } from '@sureq/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStoreConformance } from '../src/index.js';
import type { ConformanceReport, RunnerHooks } from '../src/types.js';

/** The memory store declaring no transactions and no notify: the flag-false tests run against it. */
class PlainStore extends MemoryStore {
  override readonly capabilities = defineCapabilities({ transactions: false, skipLocked: true, notify: false, ttl: false, durable: false, shared: false });
  override add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    if (opts?.atomic) return Promise.reject(new CapabilityError('transactions', 'atomic add needs transactions'));
    return super.add(scope, jobs);
  }
}

const report = join(mkdtempSync(join(tmpdir(), 'sureq-public-run-')), 'report.json');
// The report is written by the suite's top-level after hook; hold it back so the check below can read it.
let depth = 0;
let writeReport: () => Promise<void> | void = () => undefined;
const runner: RunnerHooks = {
  describe: (name, fn) =>
    describe(`plain ${name}`, () => {
      depth++;
      fn();
      depth--;
    }),
  it,
  before: beforeAll,
  after: (fn) => (depth > 0 ? afterAll(fn) : void (writeReport = fn)),
};

process.env['SUREQ_STRESS_JOBS'] ??= '500';
runStoreConformance({
  name: 'plain',
  runner,
  iterations: 6,
  groups: ['stress'],
  report,
  createStore: async (ctx) => {
    const store = new PlainStore(ctx.clock ? { clock: () => ctx.clock!.now() } : {});
    return { store, cleanup: () => store.close() };
  },
  core: (store, { namespace, queue }) => new Queue(queue, { store, namespace, logger: false }),
});

describe('suite: public run', () => {
  it('suite: a store without transactions or notify passes the flag-false tests, the core merge race and the stress group', async () => {
    await writeReport();
    const r = JSON.parse(await readFile(report, 'utf8')) as ConformanceReport;
    expect(r.failed).toBe(0);
    expect(r.conformant).toBe(true);
    expect(r.skippedGroups).toEqual(expect.arrayContaining(['capabilities:transactions', 'capabilities:notify']));
    expect(r.skippedGroups).not.toContain('merge:core');
  });
});
