import type { StoreCapabilities } from '@sureq/core';
import { FakeClock } from './clock.js';
import type { CapabilityGate, ConformanceGroup, GroupApi, TestOptions } from './groups/types.js';
import { makeEnv, newId, type GroupRun, type TestEnv } from './harness.js';
import type { ConformanceOptions, ConformanceReport, RunnerHooks, StoreHandle } from './types.js';

/** Options with every default applied. */
export type ResolvedOptions = Required<Omit<ConformanceOptions, 'runner' | 'core' | 'report'>> & { runner: RunnerHooks } & Pick<
  ConformanceOptions,
  'core' | 'report'
>;

export const GATED_SKIPS = ['transactions', 'skipLocked', 'notify', 'durable', 'shared'].map((f) => `capabilities:${f}`);
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Counts of one run, filled in while the tests execute. After `close` (the report is written) a test that
 * still finishes is ignored: the report already counted it as failed, as a test that never reported back.
 */
export class ReportCollector {
  passed = 0;
  failed = 0;
  skipped = 0;
  caps: StoreCapabilities | null = null;
  readonly skippedGroups = new Set<string>();
  modes: ConformanceReport['modes'] = { clock: 'fake', lease: 'fake', rest: 'fake' };
  #closed = false;
  pass(): void {
    if (!this.#closed) this.passed++;
  }
  fail(): void {
    if (!this.#closed) this.failed++;
  }
  close(): void {
    this.#closed = true;
  }
  /** Tests that began running; one that never reports back (killed by the runner's timeout) counts as failed. */
  started = 0;
  /** Groups whose store could not be created or opened; each counts as one failure, and their tests are not counted. */
  readonly brokenGroups: string[] = [];
  skip(group: string, gate?: string): void {
    this.skipped++;
    if (group === 'capabilities' && gate) this.skippedGroups.add(`capabilities:${gate}`);
  }
  /** Failures for the report: failed tests, tests that never finished, and groups that could not start. */
  failures(): number {
    return this.failed + (this.started - this.passed - this.failed) + this.brokenGroups.length;
  }
}

/** The harness's own check, run before the real groups. */
const suiteGroup: ConformanceGroup = {
  name: 'suite',
  mode: 'fake',
  register(t) {
    t.test('suite: durable store must provide reopen', async (env) => void (await env.reopen()), { requires: 'durable' });
  },
};

type Body = (env: TestEnv, iteration: number) => Promise<void>;

/** Register every active group with the runner; the returned collector fills in as tests run. */
export function registerAll(opts: ResolvedOptions, groups: readonly ConformanceGroup[]): ReportCollector {
  const collector = new ReportCollector();
  const real = (g: ConformanceGroup | undefined): 'real' | 'fake' => (opts.realTime || g?.mode === 'real' ? 'real' : 'fake');
  collector.modes = {
    clock: real(groups.find((g) => g.name === 'clock')),
    lease: real(groups.find((g) => g.name === 'lease')),
    rest: real(undefined),
  };
  for (const s of opts.skip) collector.skippedGroups.add(s);
  for (const group of [suiteGroup, ...groups]) {
    if (group.optIn && !opts.groups.includes(group.name)) continue;
    registerGroup(opts, group, collector);
  }
  return collector;
}

function registerGroup(opts: ResolvedOptions, group: ConformanceGroup, collector: ReportCollector): void {
  const { runner } = opts;
  const skipped = opts.skip.includes(group.name);
  let run: GroupRun | undefined;
  let createError: unknown;

  runner.describe(group.name, () => {
    if (!skipped) {
      runner.before(async () => {
        const clock = opts.realTime || group.mode === 'real' ? null : new FakeClock();
        try {
          const handle: StoreHandle = await opts.createStore({ clock, scopeId: newId() });
          await handle.store.open();
          collector.caps ??= handle.store.capabilities;
          run = { mode: clock ? 'fake' : 'real', handle, clock, ...pick(opts), createStore: opts.createStore };
        } catch (err) {
          createError = err;
          collector.brokenGroups.push(group.name);
          throw err;
        }
      });
      runner.after(async () => {
        await run?.handle.cleanup();
      });
    }
    const add = (title: string, body: Body, o: TestOptions, times: number | null): void => {
      if (o.core && !opts.core) {
        collector.skippedGroups.add(`${group.name}:core`);
        return;
      }
      runner.it(title, async (...args: unknown[]) => {
        const gate = skipReason(group, o, run, opts, skipped);
        if (gate !== false) {
          // a gate is recorded only when the flag was needed and missing; the "flag is false" variants skip when it is set
          collector.skip(group.name, o.requires ? (gate ?? undefined) : undefined);
          markSkipped(args[0]);
          return;
        }
        // a runner may run the tests of a group whose before hook failed; the broken group already counts once
        if (!run) throw createError;
        collector.started++;
        try {
          await withTimeout(runTest(run, body, times), (o.timeoutMs ?? DEFAULT_TIMEOUT_MS) * (run.mode === 'real' ? opts.timeScale : 1), title);
          collector.pass();
        } catch (err) {
          collector.fail();
          throw err;
        }
      });
    };
    const api: GroupApi = {
      test: (title, body, o = {}) => add(title, (env) => body(env), o, null),
      race: (title, body, o = {}) => add(title, body, o, opts.iterations),
    };
    group.register(api);
  });
}

const pick = (o: ResolvedOptions) => ({
  concurrency: o.concurrency,
  iterations: o.iterations,
  timeScale: o.timeScale,
  core: o.core,
});

/** `false` to run; else the capability that gated it (`null` when the whole group is skipped). */
function skipReason(
  group: ConformanceGroup,
  o: TestOptions,
  run: GroupRun | undefined,
  opts: Pick<ResolvedOptions, 'skip' | 'realTime'>,
  groupSkipped: boolean,
): CapabilityGate | null | false {
  if (groupSkipped) return null;
  // a store whose clock cannot be faked cannot follow one; nothing gated, so the run stays conformant
  if (o.fakeClock && opts.realTime) return null;
  const gate = o.requires ?? o.absent;
  if (!gate || !run) return false;
  const flag = run.handle.store.capabilities[gate];
  if (o.requires) return !flag || opts.skip.includes(`capabilities:${gate}`) ? gate : false;
  // a test for an absent flag always runs when the flag is absent: skip names only skip what a flag enables
  return flag ? gate : false;
}

/** vitest and node:test hand the test a context with `skip()`. */
function markSkipped(ctx: unknown): void {
  const skip = (ctx as { skip?: unknown } | undefined)?.skip;
  if (typeof skip === 'function') skip.call(ctx);
}

async function runTest(run: GroupRun, body: Body, times: number | null): Promise<void> {
  const { env, dispose } = makeEnv(run);
  let failed = false;
  try {
    for (let i = 0; i < (times ?? 1); i++) {
      try {
        await body(env, i);
      } catch (err) {
        // the error keeps its class, so a harness crash stays apart from an assertion; a non-Error is thrown as is
        if (times !== null && err instanceof Error) err.message = `iteration ${i}: ${err.message}`;
        throw err;
      }
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // A failed test still cleans up, but its own error is the one reported.
    await dispose().catch((err: unknown) => {
      if (!failed) throw err;
    });
  }
}

/** A test that did not finish in time: not an assertion, so it is never mistaken for a caught bug or a harness crash. */
export class ConformanceTimeoutError extends Error {
  override readonly name = 'ConformanceTimeoutError';
}

async function withTimeout(p: Promise<void>, ms: number, title: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConformanceTimeoutError(`${title}: timed out after ${ms} ms`)), ms);
  });
  try {
    await Promise.race([p, limit]);
  } finally {
    clearTimeout(timer);
  }
}
