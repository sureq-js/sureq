import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('.', import.meta.url));

/** Failure scenarios → the named regression test that pins each. */
const OWNED: Array<[name: string, file: string]> = [
  ['regression: state counts are identical before and after a pod is killed and replaced', 'metrics-pod-move.test.ts'],
  ['regression: job with no worker raises an age alert', 'age-alert-no-worker.test.ts'],
  ['attempts: regression retry limit is not off by one', 'retry-limit.test.ts'],
  ['attempts: regression retry count survives crash and pod move', 'retry-count-pod-move.test.ts'],
  ['counts: remove of a queued job keeps counts exact and drained fires', 'remove-drained.test.ts'],
  ['storeerr: regression throwing handler does not lose a slot', 'storeerr-slot.test.ts'],
  ['unrecoverable: regression permanent error runs the handler exactly once', 'permanent-error.test.ts'],
  ['bulk: half-success is reported per input and caller can tell which jobs were added', 'addbulk-half-success.test.ts'],
  ['resultsize: huge result with a size-limited fault store ends failed with ResultTooLargeError, never stuck active', 'huge-result.test.ts'],
  ['errser: regression cause and custom fields survive a store round trip', 'errser-roundtrip.test.ts'],
  ['add: every resolved add is present in the store after a simulated crash', 'add-durability.test.ts'],
  ['fmtver: regression every record carries formatVersion', 'format-version.test.ts'],
  ['regression: restarted pod does not claim or touch active jobs with live leases', 'sweeper.test.ts'],
  ["regression: killed worker's job is recovered by another live pod without restart", 'sweeper.test.ts'],
  ["regression: crashed worker's jobs are claimable by another live pod within leaseDuration plus sweepInterval", 'sweeper.test.ts'],
  ["regression: stale complete after reclaim is rejected and only the new owner's result is stored", 'stale-complete.test.ts'],
  ['regression: two pods with clocks ±1h apart never double-claim and recover on schedule', 'clock-skew.test.ts'],
  ['regression: attempt and crashCount survive reopen and pod move', 'attempt-crash-count.test.ts'],
  ['regression: timeout aborts the signal and only fails the job after the grace; abandoned work cannot commit', 'timeout.test.ts'],
  ['regression: a handler that ignores the abort signal is failed after the grace and its slot is freed', 'abandoned-slot.test.ts'],
  ['regression: cancel keeps counts correct and fires drained', 'cancel-drained.test.ts'],
  ['regression: SIGTERM leaves no lease held and active jobs finish or are released within shutdownTimeout', 'sigterm-shutdown.test.ts'],
  ['regression: throwing handler and failing claim both free their slot', 'claim-failure-slot.test.ts'],
  ['regression: merge: every merged or ignored add reports its outcome and fires duplicate', 'duplicates-never-silent.test.ts'],
  ['regression: singleton conflicts return added false with an action and fire duplicate', 'duplicates-never-silent.test.ts'],
  ['regression: every duplicate path returns added false with an action and fires duplicate', 'duplicates-never-silent.test.ts'],
  ['regression: add resolves only after the store acknowledged the write', 'add-acknowledged.test.ts'],
  ['regression: add is never acknowledged before persistence, including during an outage', 'add-acknowledged.test.ts'],
  ['regression: pause and resume emit events and isPaused reflects them', 'pause-events.test.ts'],
  ['regression: a job that kills its worker is failed after maxCrashes, not retried forever', 'sweeper.test.ts'],
  ['regression: idle workers back off and stay under the claim-rate budget', 'idle-polling-budget.test.ts'],
  ['regression: a complete whose response was lost is repeated with the same token and neither reruns the job nor burns an attempt', 'lost-response.test.ts'],
  ['regression: when the pod that was sweeping dies, another live pod reclaims the expired lease', 'sweeper-pod-dies.test.ts'],
  ['regression: a forward jump of the store clock requeues active jobs and fences the stale workers', 'store-clock-jump.test.ts'],
  ['regression: blocked heartbeat loses the lease, job reruns, stale result is rejected', 'blocked-heartbeat.test.ts'],
  ['regression: blocking the event loop past the lease runs the job twice and only the second run commits', 'blocked-heartbeat.test.ts'],
  ['regression: filter: rejected add is never silent', 'filter-never-silent.test.ts'],
  ['regression: poison pill ends in the DLQ and does not crash-loop', 'dead-letter.test.ts'],
  ['regression: UnrecoverableError goes to the DLQ after one attempt', 'dead-letter.test.ts'],
  ['regression: failed job is still visible with error and history', 'dead-letter.test.ts'],
  ['regression: producer killed right after add resolves does not lose the job', 'producer-crash.test.ts'],
  ['regression: finished jobs beyond the default retention are removed and do not pile up', 'retention-default.test.ts'],
  ['regression: finished jobs are kept per the default policy and removed only by a stated rule', 'retention-default.test.ts'],
  ['regression: a daylight-saving change neither skips nor doubles a cron run', 'cron-dst.test.ts'],
  ['regression: old and new pods share a store through a rolling replace with no lost or double-run jobs', 'rolling-replace.test.ts'],
  ['regression: finished jobs keep their attempt trail', 'attempt-trail.test.ts'],
  ['regression: stale completion after reclaim shows two attempts', 'attempt-trail.test.ts'],
  ['regression: older pod refuses to start against a newer store', 'rolling-replace.test.ts'],
  ['regression: pod clocks disagree schedule fires once at store time', 'schedule-clock-skew.test.ts'],
  ['regression: overlap: cron run still going when next tick fires does not pile up', 'schedule-overlap.test.ts'],
  ['regression: a schedule fires each tick once when the firing pod dies mid-fire', 'schedule-failover.test.ts'],
  ['regression: after downtime of many periods a schedule fires one catch-up job, then resumes', 'schedule-failover.test.ts'],
  ['regression: batch-result: failing one task does not fail its batch', 'batch-siblings.test.ts'],
  ['regression: batch-cancel: cancelling one task does not fail its batch', 'batch-siblings.test.ts'],
  ['regression: batch-cancel: drained fires after cancelling held jobs', 'batch-cancel-drained.test.ts'],
  ['regression: batch: buffered jobs survive a crash', 'batch-crash.test.ts'],
  ['regression: progress survives a pod move and is readable from another queue instance', 'progress-pod-move.test.ts'],
  ['regression: counts and drained are correct after drain and clean', 'admin-drained.test.ts'],
];
/** Other regression and gate files kept in this folder. */
const EXTRA: Array<[name: string, file: string]> = [
  ['concurrency: regression throwing handler does not lose a slot', 'throwing-handler-slot.test.ts'],
  ['names: pod without a handler for X leaves X jobs waiting and does not fail them', 'names-missing-handler.test.ts'],
  ['hygiene: no skipped, todo or only tests', 'hygiene.test.ts'],
  ['regression: killed pod is gone from getWorkers while its leases are swept by lease expiry, not by the registry', 'workers-killed-pod.test.ts'],
  ['docs: no untagged open questions remain in the current release docs', 'open-questions.test.ts'],
  ['regression: every failure scenario in the planning notes is mapped', 'failure-scenarios.test.ts'],
  ['docs: every test named in the current release feature docs exists in the code', 'doc-test-names.test.ts'],
  ['regression: a lost claim response neither loses the job nor spends an attempt', 'lost-claim-response.test.ts'],
  ['lease: a job running three lease durations with heartbeats is never swept', 'long-job-keeps-lease.test.ts'],
  ['regression: a pod with a dead claim loop reports live false so the platform restarts it', 'dead-loop-live-false.test.ts'],
  ['sweeper: a hung sweep surfaces a stalled warning in health', 'hung-store-call.test.ts'],
  ['worker: an add landing during an empty claim is picked up without waiting a full poll', 'lost-wakeup.test.ts'],
  ['worker: close deadline counts from the close call even with a claim in flight', 'close-deadline.test.ts'],
  ['events: a zero-delay retry reports waiting', 'zero-delay-retry.test.ts'],
  ['serialize: a circular value error cause does not contain property names', 'serialization-cause.test.ts'],
];

describe('regression index', () => {
  it('regression: every known failure scenario has a named test', () => {
    expect(OWNED).toHaveLength(58);
    for (const [name, file] of [...OWNED, ...EXTRA]) {
      const text = readFileSync(DIR + file, 'utf8');
      // A title with an apostrophe is written in double quotes.
      expect(text.includes(`'${name}'`) || text.includes(`"${name}"`), `${file} names "${name}"`).toBe(true);
    }
    const listed = new Set([...OWNED, ...EXTRA].map(([, f]) => f));
    const present = readdirSync(DIR).filter((f) => f.endsWith('.test.ts') && f !== 'index.test.ts');
    expect(present.filter((f) => !listed.has(f)), 'regression files missing from the index').toEqual([]);
  });

  it('regression: names are unique across the folder', () => {
    // The index files quote the names they check, so they are left out.
    const quoting = new Set(['index.test.ts', 'failure-scenarios.test.ts']);
    const names = readdirSync(DIR)
      .filter((f) => f.endsWith('.ts') && !quoting.has(f))
      .flatMap((f) => [...readFileSync(DIR + f, 'utf8').matchAll(/(['"])(regression: .*?)\1/g)].map((m) => m[2]!));
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});
