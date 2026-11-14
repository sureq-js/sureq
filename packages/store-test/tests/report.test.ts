import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCapabilities, MemoryStore, STORE_CONTRACT_VERSION } from '@sureq/core';
import { describe, expect, it } from 'vitest';
import type { ConformanceGroup } from '../src/groups/types.js';
import { SUITE_VERSION } from '../src/index.js';
import { ReportCollector } from '../src/register.js';
import { runGroups } from '../src/run.js';
import type { ConformanceOptions, ConformanceReport, HarnessContext } from '../src/types.js';
import { collect } from './helpers/collect.js';
import { memoryFactory } from './helpers/options.js';
import { runAgainst } from './helpers/run-against.js';

const dir = mkdtempSync(join(tmpdir(), 'sureq-report-'));
let n = 0;

const probe: ConformanceGroup = {
  name: 'probe',
  mode: 'fake',
  register(t) {
    t.test('probe: pass', async () => {});
    t.test('probe: fail', async () => expect(1).toBe(2));
    t.test('probe: gated', async () => {}, { requires: 'durable' });
  },
};
const green: ConformanceGroup = { name: 'clock', mode: 'real', register: (t) => t.test('clock: ok', async () => {}) };
const lease: ConformanceGroup = { name: 'lease', mode: 'real', register: (t) => t.test('lease: ok', async () => {}) };

async function run(over: Partial<ConformanceOptions>, groups: ConformanceGroup[]) {
  const report = join(dir, `r${++n}.json`);
  const out = await collect((runner) =>
    runGroups({ name: 'probe-store', createStore: memoryFactory().createStore, runner, report, ...over }, groups),
  );
  return { out, report: JSON.parse(readFileSync(report, 'utf8')) as ConformanceReport };
}

describe('report', () => {
  it('suite: report json has counts, mode, capabilities and suite version', async () => {
    const { report } = await run({}, [probe]);
    expect(Object.keys(report).sort()).toEqual(
      ['suite', 'contractVersion', 'store', 'capabilities', 'passed', 'failed', 'skipped', 'skippedGroups', 'conformant', 'mode', 'modes', 'concurrency'].sort(),
    );
    expect(report.suite).toBe(SUITE_VERSION);
    expect(report.contractVersion).toBe(STORE_CONTRACT_VERSION);
    expect(report.store).toBe('probe-store');
    expect(report.capabilities).toEqual(new MemoryStore().capabilities);
    // the harness's durable check is gated too, so two tests are skipped
    expect({ passed: report.passed, failed: report.failed, skipped: report.skipped }).toEqual({ passed: 1, failed: 1, skipped: 2 });
    expect(report.mode).toBe('fake');
    expect(report.modes).toEqual({ clock: 'fake', lease: 'fake', rest: 'fake' });
    expect(report.conformant).toBe(false);
  });

  it('suite: skipping a non-gated group sets conformant false', async () => {
    const bad = await run({ skip: ['claim'] }, [green, lease]);
    expect(bad.report.skippedGroups).toContain('claim');
    expect(bad.report.conformant).toBe(false);
    const ok = await run({ skip: ['capabilities:notify'] }, [green, lease]);
    expect(ok.report.skippedGroups).toEqual(['capabilities:notify']);
    expect(ok.report.modes).toEqual({ clock: 'real', lease: 'real', rest: 'fake' });
    expect(ok.report.conformant).toBe(true);
  });

  it('suite: concurrency below ten is not conformant', async () => {
    const { report } = await run({ concurrency: 5 }, [green, lease]);
    expect(report.failed).toBe(0);
    expect(report.concurrency).toBe(5);
    expect(report.conformant).toBe(false);
  });

  it('suite: a broken group counts once, also under a runner that still runs its tests', async () => {
    const boom = new TypeError('boom');
    let calls = 0;
    // the suite group's store opens; the probe group's store fails
    const createStore = async (ctx: HarnessContext) => (++calls === 2 ? Promise.reject(boom) : memoryFactory().createStore(ctx));
    const report = join(dir, `r${++n}.json`);
    // like Jest, run the tests even though the before hook failed
    await collect((r) =>
      runGroups({ name: 'x', createStore, report, runner: { ...r, before: (fn) => r.before(() => Promise.resolve(fn()).catch(() => {})) } }, [
        { name: 'probe', mode: 'fake', register: (t) => ['a', 'b', 'c'].forEach((x) => t.test(`probe: ${x}`, async () => {})) },
      ]),
    );
    expect((JSON.parse(readFileSync(report, 'utf8')) as ConformanceReport).failed).toBe(1);
  });

  it('suite: a test that finishes after the report is written is ignored', () => {
    const c = new ReportCollector();
    c.started = 2;
    c.pass();
    c.close();
    c.pass();
    c.fail();
    expect({ passed: c.passed, failed: c.failed, failures: c.failures() }).toEqual({ passed: 1, failed: 0, failures: 1 });
  });

  it('suite: a false capability flag skips its gated test against a real store and lists it', async () => {
    expect(new MemoryStore().capabilities.durable).toBe(false);
    const title = 'capabilities: durable true — reopen keeps acknowledged writes';
    const r = await runAgainst((o) => new MemoryStore(o), [title]);
    expect(r.skipped).toEqual([title]);
    expect(r.report.skippedGroups).toContain('capabilities:durable');
    expect(r.report.failed).toBe(0);
  });

  it('suite: the renew and sweep race passes with fewer than three iterations', async () => {
    const title = 'lease: renew and sweep race — exactly one wins';
    for (const iterations of [1, 2]) expect((await runAgainst((o) => new MemoryStore(o), [title], { iterations })).passed).toEqual([title]);
  });

  it('suite: durable store must provide reopen', async () => {
    class Durable extends MemoryStore {
      override readonly capabilities = defineCapabilities({ ...new MemoryStore().capabilities, durable: true });
    }
    const createStore = async (_ctx: HarnessContext) => {
      const store = new Durable();
      return { store, cleanup: async () => {} };
    };
    const { out } = await run({ createStore }, [green]);
    expect(out.results['suite: durable store must provide reopen']).toBe('fail');
    expect(String((out.errors['suite: durable store must provide reopen'] as Error).message)).toContain('reopen');
  });

  it('suite: unknown options throw with the closest name', () => {
    expect(() => runGroups({ name: 'x', createStore: memoryFactory().createStore, concurency: 3 } as ConformanceOptions, [])).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTION', issues: [expect.objectContaining({ path: 'concurency', suggestion: 'concurrency' })] }),
    );
  });

  it('suite: an unknown group name throws with the closest group, instead of running nothing extra', () => {
    const stress: ConformanceGroup = { name: 'stress', mode: 'fake', optIn: true, register: () => {} };
    const runner = { describe: () => {}, it: () => {}, before: () => {}, after: () => {} };
    const opts = (groups: unknown) => ({ name: 'x', createStore: memoryFactory().createStore, groups, runner }) as ConformanceOptions;
    expect(() => runGroups(opts(['stres']), [green, stress])).toThrow(
      expect.objectContaining({
        code: 'INVALID_OPTION',
        issues: [expect.objectContaining({ path: 'groups[0]', code: 'invalid_value', suggestion: 'stress', message: 'unknown group "stres"; the opt-in groups are: stress' })],
      }),
    );
    expect(() => runGroups(opts('stress'), [green, stress])).toThrow(expect.objectContaining({ issues: [expect.objectContaining({ path: 'groups', code: 'invalid_type' })] }));
    expect(() => runGroups(opts(['stress', 'clock']), [green, stress])).not.toThrow();
  });
});
