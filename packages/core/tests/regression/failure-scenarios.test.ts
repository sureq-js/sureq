import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devDocsRoot, hasDevDocs } from '../helpers/dev-docs.js';

const DIR = import.meta.dirname;

/**
 * Every failure scenario of the planning notes, by the start of its row. A row is owned when every feature
 * that answers it is built; an owned row lists the regression tests that pin it, an unowned row says why not.
 */
const SCENARIOS: Array<{ startsWith: string; owned: boolean; names: string[]; why?: string }> = [
  { startsWith: 'A new or restarted pod takes over batches', owned: true, names: ['regression: restarted pod does not claim or touch active jobs with live leases'] },
  {
    startsWith: "A crashed pod's work stays locked",
    owned: true,
    names: [
      "regression: killed worker's job is recovered by another live pod without restart",
      "regression: crashed worker's jobs are claimable by another live pod within leaseDuration plus sweepInterval",
    ],
  },
  {
    startsWith: 'A worker paused by GC',
    owned: true,
    names: ["regression: stale complete after reclaim is rejected and only the new owner's result is stored", 'regression: stale completion after reclaim shows two attempts'],
  },
  {
    startsWith: 'Pod clocks disagree',
    owned: true,
    names: ['regression: two pods with clocks ±1h apart never double-claim and recover on schedule', 'regression: pod clocks disagree schedule fires once at store time'],
  },
  {
    startsWith: 'Retry counts, counters or result handles are lost',
    owned: true,
    names: [
      'regression: attempt and crashCount survive reopen and pod move',
      'regression: progress survives a pod move and is readable from another queue instance',
      'regression: state counts are identical before and after a pod is killed and replaced',
    ],
  },
  { startsWith: 'A retry limit that is off by one', owned: false, names: [], why: 'pinned by the earlier release index' },
  {
    startsWith: 'A timeout marks a job failed',
    owned: true,
    names: ['regression: timeout aborts the signal and only fails the job after the grace; abandoned work cannot commit'],
  },
  {
    startsWith: 'Cancelling or failing one task fails its whole batch',
    owned: true,
    names: ['regression: batch-result: failing one task does not fail its batch', 'regression: batch-cancel: cancelling one task does not fail its batch'],
  },
  {
    startsWith: 'Cancelling a queued job leaves counts wrong',
    owned: true,
    names: [
      'regression: cancel keeps counts correct and fires drained',
      'regression: batch-cancel: drained fires after cancelling held jobs',
      'regression: counts and drained are correct after drain and clean',
    ],
  },
  {
    startsWith: 'Shutdown leaves corrupted state',
    owned: true,
    names: ['regression: SIGTERM leaves no lease held and active jobs finish or are released within shutdownTimeout'],
  },
  { startsWith: 'A throwing handler loses a concurrency slot', owned: true, names: ['regression: throwing handler and failing claim both free their slot'] },
  {
    startsWith: 'A merge or filter drops a job silently',
    owned: true,
    names: [
      'regression: merge: every merged or ignored add reports its outcome and fires duplicate',
      'regression: singleton conflicts return added false with an action and fire duplicate',
      'regression: every duplicate path returns added false with an action and fires duplicate',
      'regression: filter: rejected add is never silent',
    ],
  },
  {
    startsWith: 'Jobs accepted but buffered in memory',
    owned: true,
    names: [
      'regression: add resolves only after the store acknowledged the write',
      'regression: add is never acknowledged before persistence, including during an outage',
      'regression: batch: buffered jobs survive a crash',
      'regression: producer killed right after add resolves does not lose the job',
    ],
  },
  { startsWith: "Pausing doesn't stop the timeout clock", owned: true, names: ['regression: pause and resume emit events and isPaused reflects them'] },
  { startsWith: 'Priority ordering costs a full re-sort', owned: false, names: [], why: 'needs migrations, not built yet' },
  { startsWith: 'Several pods race on schema creation', owned: false, names: [], why: 'migrations are not built yet' },
  {
    startsWith: 'No history',
    owned: true,
    names: [
      'regression: finished jobs keep their attempt trail',
      'regression: finished jobs are kept per the default policy and removed only by a stated rule',
      'regression: failed job is still visible with error and history',
    ],
  },
  {
    startsWith: 'A job that crashes the worker crash-loops',
    owned: true,
    names: ['regression: a job that kills its worker is failed after maxCrashes, not retried forever', 'regression: poison pill ends in the DLQ and does not crash-loop'],
  },
  {
    startsWith: 'A permanent error is retried',
    owned: true,
    names: ['unrecoverable: regression permanent error runs the handler exactly once', 'regression: UnrecoverableError goes to the DLQ after one attempt'],
  },
  { startsWith: 'Idle workers hammer the database', owned: true, names: ['regression: idle workers back off and stay under the claim-rate budget'] },
  { startsWith: 'A schedule fires twice', owned: true, names: ['regression: a schedule fires each tick once when the firing pod dies mid-fire'] },
  { startsWith: 'A schedule misses ticks', owned: true, names: ['regression: after downtime of many periods a schedule fires one catch-up job, then resumes'] },
  { startsWith: 'A daylight-saving change', owned: true, names: ['regression: a daylight-saving change neither skips nor doubles a cron run'] },
  {
    startsWith: 'A `complete` succeeds but its response is lost',
    owned: true,
    names: ['regression: a complete whose response was lost is repeated with the same token and neither reruns the job nor burns an attempt'],
  },
  { startsWith: 'Finished jobs pile up forever', owned: true, names: ['regression: finished jobs beyond the default retention are removed and do not pile up'] },
  {
    startsWith: 'A handler ignores its abort signal',
    owned: true,
    names: ['regression: a handler that ignores the abort signal is failed after the grace and its slot is freed'],
  },
  { startsWith: 'The pod running the sweeper dies', owned: true, names: ['regression: when the pod that was sweeping dies, another live pod reclaims the expired lease'] },
  {
    startsWith: "The store's clock jumps",
    owned: true,
    names: ['regression: a forward jump of the store clock requeues active jobs and fences the stale workers'],
  },
  {
    startsWith: 'A rolling deploy runs old and new pods',
    owned: true,
    names: [
      'fmtver: regression every record carries formatVersion',
      'regression: old and new pods share a store through a rolling replace with no lost or double-run jobs',
      'regression: older pod refuses to start against a newer store',
    ],
  },
  { startsWith: 'Jobs queued before a deploy reach a handler', owned: false, names: [], why: 'data versioning is not built yet' },
  { startsWith: 'A cron run is still going', owned: true, names: ['regression: overlap: cron run still going when next tick fires does not pile up'] },
  {
    startsWith: 'Synchronous CPU work blocks the heartbeat',
    owned: true,
    names: [
      'regression: blocked heartbeat loses the lease, job reruns, stale result is rejected',
      'regression: blocking the event loop past the lease runs the job twice and only the second run commits',
    ],
  },
  { startsWith: 'A failed job silently blocks every later job', owned: false, names: [], why: 'ordered keys are not built yet' },
  { startsWith: '`addBulk` half-succeeds', owned: false, names: [], why: 'pinned by the earlier release index' },
  { startsWith: 'A job name with no handler waits forever', owned: true, names: ['regression: job with no worker raises an age alert'] },
  { startsWith: 'Low-priority jobs never run', owned: false, names: [], why: 'starvation protection is not built yet' },
  { startsWith: 'A huge result breaks the completion write', owned: false, names: [], why: 'pinned by the earlier release index' },
  { startsWith: "An error's cause and custom fields are lost", owned: false, names: [], why: 'pinned by the earlier release index' },
];

/** The first column of the failure-scenario table. */
const scenarioRows = (): string[] => {
  const text = readFileSync(join(devDocsRoot, 'FEATURES.md'), 'utf8');
  const start = text.indexOf('\n## 4.');
  const section = text.slice(start, text.indexOf('\n## ', start + 1));
  return [...section.matchAll(/^\| (.+?) \| .* \|$/gm)].map((m) => m[1]!).filter((c) => c !== 'Scenario' && !c.startsWith('---'));
};

// The planning notes exist only on development machines; on a clean clone this check has nothing to read.
describe.runIf(hasDevDocs)('failure scenarios', () => {
  it('regression: every failure scenario in the planning notes is mapped', () => {
    const rows = scenarioRows();
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => !SCENARIOS.some((s) => r.startsWith(s.startsWith))), 'rows with no entry').toEqual([]);
    expect(SCENARIOS.filter((s) => !rows.some((r) => r.startsWith(s.startsWith))).map((s) => s.startsWith), 'entries matching no row').toEqual([]);
    for (const s of SCENARIOS) expect(s.owned ? s.names.length > 0 : s.names.length === 0 && !!s.why, s.startsWith).toBe(true);

    const code = readdirSync(DIR)
      .filter((f) => f.endsWith('.test.ts') && f !== 'index.test.ts' && f !== 'failure-scenarios.test.ts')
      .map((f) => readFileSync(join(DIR, f), 'utf8'))
      .join('\n');
    const missing = SCENARIOS.flatMap((s) => s.names).filter((n) => !code.includes(`'${n}'`) && !code.includes(`"${n}"`));
    expect(missing).toEqual([]);
  });
});
