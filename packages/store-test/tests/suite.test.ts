import { readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemoryStore } from '@sureq/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { GROUPS } from '../src/groups/index.js';
import { BROKEN } from './broken/index.js';
import { runAgainst, type RunResult } from './helpers/run-against.js';

const memory = (opts: { clock?: () => number }) => new MemoryStore(opts);
const root = join(import.meta.dirname, '..');

describe('suite', { timeout: 600_000 }, () => {
  let full: RunResult;
  const rejections: unknown[] = [];
  beforeAll(async () => {
    const onRejection = (err: unknown) => void rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
      full = await runAgainst(memory, null);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  }, 600_000);

  it('suite: memory store passes every test', () => {
    expect(full.failed).toEqual([]);
    expect(full.harnessErrors).toEqual([]);
    expect(full.passed.length).toBeGreaterThan(100);
    expect(full.report.conformant).toBe(true);
    // no core queue was given, so its merge test is left out without costing conformance
    expect(full.report.skippedGroups).toContain('merge:core');
    // memory declares transactions and skipLocked, so those gates are not listed as skipped
    expect(full.report.skippedGroups).not.toContain('capabilities:transactions');
    expect(full.report.skippedGroups).not.toContain('capabilities:skipLocked');
    expect(full.report.modes).toEqual({ clock: 'real', lease: 'real', rest: 'fake' });
  });

  it('suite: no unhandled rejections during run', () => {
    expect(rejections).toEqual([]);
  });

  it('broken: noLeaseExpiry injects exactly one bug', async () => {
    const b = BROKEN.find((x) => x.name === 'noLeaseExpiry')!;
    let now = 1000;
    const store = b.make({ clock: () => now });
    await store.open();
    const s = { namespace: 'n', queue: 'q' };
    await store.add(s, [{ id: 'a', data: '', formatVersion: 1, maxAttempts: 3 }]);
    const { jobs } = await store.claim(s, { workerId: 'w', claimId: 'c', limit: 1, leaseMs: 1000 });
    now += 1001;
    const swept = await store.sweep(s, { limit: 10, maxCrashes: 3, failError: 'f', poisonError: 'p' });
    expect(swept.swept).toEqual([expect.objectContaining({ id: 'a', action: 'requeued', crashCount: 1 })]);
    expect((await store.get(s, 'a'))?.state).toBe('waiting');
    expect(jobs[0]?.token).toBeGreaterThan(0);
  });

  it('broken: every broken store contains exactly one injected bug', () => {
    const dir = join(root, 'tests/broken');
    for (const b of BROKEN) {
      const proto = Object.getPrototypeOf(b.make({}));
      expect(Object.getPrototypeOf(proto), `${b.name} extends MemoryStore directly`).toBe(MemoryStore.prototype);
      const own = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor').sort();
      expect(own, `${b.name} overrides exactly its declared methods`).toEqual(b.methods.filter((m) => m !== 'constructor').sort());
    }
    const files = readdirSync(dir).filter((f) => !['index.ts', 'inject.ts', 'fenced.ts'].includes(f));
    expect(files).toHaveLength(BROKEN.length);
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8').match(/\binject\(/g), `${f} has one inject call`).toHaveLength(1);
  });

  it('suite: group titles are string literals with the group prefix', () => {
    const dir = join(root, 'src/groups');
    // a group may also hold titles of other areas it checks
    const areas: Record<string, string[]> = { stats: ['metrics', 'age'], schedule: ['schedule-store', 'schedule-fire'] };
    const bad: string[] = [];
    let calls = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      const group = /name: '([^']+)',\s*mode:/.exec(text)?.[1] ?? f.replace(/-.*|\.ts$/g, '');
      for (const m of text.matchAll(/\bt\.(?:test|race)\(\s*(\S)/g)) {
        calls++;
        const rest = text.slice(m.index! + m[0].length - 1);
        const lit = /^(['"])((?:(?!\1).)*)\1\s*,/.exec(rest);
        if (!lit || ![group, ...(areas[group] ?? [])].some((a) => lit[2]!.startsWith(`${a}: `))) bad.push(`${f}: ${rest.slice(0, 60)}`);
      }
    }
    expect(calls).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  it('suite: runs under node:test, vitest and jest', async () => {
    const out = mkdtempSync(join(tmpdir(), 'sureq-smoke-'));
    const read = (name: string) => JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
    // every group skipped, as in the node and vitest smoke files: the run proves the runner wiring and the report
    const env = { ...process.env, SMOKE_REPORT_DIR: out, SMOKE_SKIP: GROUPS.map((g) => g.name).join(','), NODE_TEST_CONTEXT: undefined, VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined };
    const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: root, env, stdio: 'pipe' });
    run(process.execPath, ['--import', 'tsx', '--test', 'tests/smoke/node/smoke.test.ts']);
    expect(read('node').suite).toBe('1');
    run(process.execPath, [join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs'), 'run', '--config', 'tests/smoke/vitest/vitest.config.ts']);
    expect(read('vitest').suite).toBe('1');
    // jest is a devDependency, so this runs everywhere (locally and in CI); a missing jest fails here instead of skipping
    const jest = createRequire(import.meta.url).resolve('jest/bin/jest');
    run(process.execPath, [jest, '--rootDir', 'tests/smoke/jest']);
    expect(read('jest').suite).toBe('1');
  });
});

describe('suite: real-time stores', { timeout: 120_000 }, () => {
  it('suite: a store that ignores the injected clock is conformant with realTime', async () => {
    // the store keeps its own clock whatever ctx.clock says
    const own = () => new MemoryStore();
    const run = await runAgainst(own, (t) => t.startsWith('clock:') || t.startsWith('suite:'), { realTime: true });
    expect(run.failed).toEqual([]);
    expect(run.skipped).toContain('clock: store follows the injected test clock');
    expect(run.report.conformant).toBe(true);
  });
});
