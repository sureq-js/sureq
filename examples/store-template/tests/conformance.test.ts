import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStoreConformance, type ConformanceReport, type RunnerHooks } from '@sureq/store-test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplateStore, ToyBackend } from '../src/index.js';

const dir = await mkdtemp(join(tmpdir(), 'store-template-'));
const reportFile = join(dir, 'report.json');

// The suite writes its report in a hook that runs after the last test of the file. The checks below need the
// report, so this runner holds that one hook back (the one registered outside any describe) and runs it first.
let depth = 0;
let writeReport: () => Promise<void> | void = () => undefined;
const runner: RunnerHooks = {
  describe: (name, fn) =>
    describe(name, () => {
      depth++;
      fn();
      depth--;
    }),
  it,
  before: beforeAll,
  after: (fn) => (depth > 0 ? afterAll(fn) : void (writeReport = fn)),
};

runStoreConformance({
  name: 'store-template',
  runner,
  concurrency: 20,
  // The toy store scans every job per call, so the 100k-job claim test (500 jobs per iteration) would take minutes.
  iterations: 20,
  report: reportFile,
  createStore: async (ctx) => {
    // One journal file per store object; the backend reads the injected clock when the suite gives one.
    const journalFile = join(dir, `${ctx.scopeId}.jsonl`);
    const open = () => {
      const backend = new ToyBackend({ journalFile, ...(ctx.clock && { clock: ctx.clock }) });
      return createTemplateStore({ backend });
    };
    return {
      store: open(),
      reopen: async () => open(),
      cleanup: () => rm(journalFile, { force: true }),
    };
  },
});

// These tests are registered after the suite's groups, so they run after every group test.
describe('template: report', () => {
  const read = async (): Promise<ConformanceReport> => {
    await writeReport();
    return JSON.parse(await readFile(reportFile, 'utf8')) as ConformanceReport;
  };

  it('template: passes the full conformance suite in fake mode', async () => {
    const report = await read();
    expect(report.failed).toBe(0);
    expect(report.conformant).toBe(true);
    expect(report.modes).toEqual({ clock: 'real', lease: 'real', rest: 'fake' });
    expect(report.concurrency).toBe(20);
  });

  it('template: passes gated groups for its declared capabilities (transactions, skipLocked, durable)', async () => {
    const { capabilities, skippedGroups, conformant } = await read();
    expect(conformant).toBe(true);
    // The tests that need notify or shared are skipped because the template does not declare them.
    expect(skippedGroups).toContain('capabilities:notify');
    expect(skippedGroups).toContain('capabilities:shared');
    for (const gated of ['transactions', 'skipLocked', 'durable']) expect(skippedGroups).not.toContain(`capabilities:${gated}`);
    expect(capabilities).toMatchObject({ transactions: true, skipLocked: true, durable: true, notify: false, shared: false });
  });
});
