import { InvalidOptionError, type ConfigIssue } from '@sureq/core';
import type { ConformanceGroup } from './groups/types.js';
import { buildReport, writeReport } from './report.js';
import { GATED_SKIPS, registerAll, type ResolvedOptions } from './register.js';
import { detectRunner } from './runner.js';
import type { ConformanceOptions } from './types.js';

const KEYS = ['name', 'createStore', 'runner', 'concurrency', 'iterations', 'timeScale', 'skip', 'groups', 'realTime', 'core', 'report'];

/** Register `groups` with the test runner and, when asked, write the report after the last test. */
export function runGroups(options: ConformanceOptions, groups: readonly ConformanceGroup[]): void {
  const opts = resolve(options, groups);
  const collector = registerAll(opts, groups);
  const { report } = opts;
  if (report === undefined) return;
  opts.runner.after(async () => {
    collector.close();
    await writeReport(
      report,
      buildReport({
        name: opts.name,
        caps: collector.caps,
        passed: collector.passed,
        failed: collector.failures(),
        skipped: collector.skipped,
        skippedGroups: [...collector.skippedGroups],
        mode: opts.realTime ? 'real' : 'fake',
        modes: collector.modes,
        concurrency: opts.concurrency,
        skippedNonGated: opts.skip.filter((s) => !GATED_SKIPS.includes(s)),
      }),
    );
  });
}

function resolve(o: ConformanceOptions, groups: readonly ConformanceGroup[]): ResolvedOptions {
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(o ?? {})) {
    if (!KEYS.includes(key)) issues.push({ path: key, code: 'unknown_option', message: `unknown option ${key}`, suggestion: closest(key, KEYS) });
  }
  if (typeof o?.name !== 'string') issues.push({ path: 'name', code: 'missing_option', message: 'name must be a string' });
  if (typeof o?.createStore !== 'function') issues.push({ path: 'createStore', code: 'missing_option', message: 'createStore must be a function' });
  for (const key of ['concurrency', 'iterations'] as const) {
    const v = o?.[key];
    if (v !== undefined && !(Number.isInteger(v) && v >= 1)) issues.push({ path: key, code: 'out_of_range', message: `${key} must be a positive integer` });
  }
  if (o?.timeScale !== undefined && !(o.timeScale > 0)) issues.push({ path: 'timeScale', code: 'out_of_range', message: 'timeScale must be above 0' });
  if (o?.groups !== undefined) {
    // A misspelt group would quietly run nothing extra, so every name must be a real group.
    const names = groups.map((g) => g.name);
    const optIn = groups.filter((g) => g.optIn).map((g) => g.name);
    if (!Array.isArray(o.groups)) issues.push({ path: 'groups', code: 'invalid_type', message: 'groups must be an array of group names' });
    else
      o.groups.forEach((name, i) => {
        if (typeof name === 'string' && names.includes(name)) return;
        const suggestion = typeof name === 'string' && names.length > 0 ? closest(name, names) : undefined;
        issues.push({
          path: `groups[${i}]`, code: 'invalid_value', message: `unknown group ${JSON.stringify(name)}; the opt-in groups are: ${optIn.join(', ') || 'none'}`,
          ...(suggestion !== undefined && { suggestion }),
        });
      });
  }
  if (issues.length > 0) throw new InvalidOptionError('runStoreConformance', issues);
  return {
    name: o.name,
    createStore: o.createStore,
    runner: o.runner ?? detectRunner(),
    concurrency: o.concurrency ?? 20,
    iterations: o.iterations ?? 200,
    timeScale: o.timeScale ?? 1,
    skip: o.skip ?? [],
    groups: o.groups ?? [],
    realTime: o.realTime ?? false,
    ...(o.core && { core: o.core }),
    ...(o.report !== undefined && { report: o.report }),
  };
}

/** The name in `known` with the fewest edits from `key`. */
function closest(key: string, known: readonly string[]): string {
  const dist = (a: string, b: string): number => {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length]!;
  };
  return known.reduce((best, k) => (dist(key, k) < dist(key, best) ? k : best));
}
