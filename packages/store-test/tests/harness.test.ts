import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCapabilities, MemoryStore, Queue, type Store } from '@sureq/core';
import { describe, expect, it } from 'vitest';
import type { ConformanceGroup } from '../src/groups/types.js';
import { ConformanceTimeoutError, registerAll } from '../src/register.js';
import { runGroups } from '../src/run.js';
import type { ConformanceReport, HarnessContext } from '../src/types.js';
import { collect } from './helpers/collect.js';
import { runAgainst } from './helpers/run-against.js';
import { memoryFactory, resolved, ZERO, type Scope } from './helpers/options.js';

const group = (name: string, register: ConformanceGroup['register'], extra: Partial<ConformanceGroup> = {}): ConformanceGroup => ({
  name, mode: 'fake', register, ...extra,
});

describe('harness', () => {
  it('suite: tests use unique namespaces and leave none behind', async () => {
    const f = memoryFactory();
    const scopes: Scope[] = [];
    const probe = group('probe', (t) => {
      for (const n of [1, 2, 3, 4, 5]) {
        t.test(`probe: ${n}`, async (env) => {
          const s = env.scope();
          scopes.push(s);
          const [a, b, c] = await env.addJobs(s, 3, n === 5 ? { delayMs: 1000 } : {});
          await env.claim(s);
          if (n > 2) await env.store.cancel(s, { id: b!.id });
          if (n > 3) await env.store.cancel(s, { id: c!.id });
          expect(a).toBeDefined();
        });
      }
    });
    const out = await collect((r) => registerAll(resolved(r, { createStore: f.createStore }), [probe]));
    expect(Object.values(out.results)).toEqual(['skip', 'pass', 'pass', 'pass', 'pass', 'pass']);
    const names = scopes.map((s) => s.namespace);
    expect(new Set(names).size).toBe(5);
    for (const n of names) expect(n.startsWith('conf-')).toBe(true);
    const store = f.stores[1]!;
    for (const s of scopes) expect(await store.counts(s)).toEqual(ZERO);
  });

  it('suite: race tests run all iterations and fail if any iteration fails', async () => {
    let passing = 0;
    let failing = 0;
    const probe = group('probe', (t) => {
      t.race('probe: passes', async (env) => {
        env.scope();
        passing++;
      });
      t.race('probe: fails', async (_env, i) => {
        failing++;
        if (i === 4) expect(i).toBe(-1);
      });
    });
    const out = await collect((r) => registerAll(resolved(r, { iterations: 7 }), [probe]));
    expect(passing).toBe(7);
    expect(out.results['probe: passes']).toBe('pass');
    expect(out.results['probe: fails']).toBe('fail');
    expect(failing).toBe(5);
    expect(String((out.errors['probe: fails'] as Error).message)).toContain('iteration 4');
  });

  it('suite: a race keeps the class of what an iteration threw, and a timeout is its own error', async () => {
    const thrown = { not: 'an Error' };
    const probe = group('probe', (t) => {
      t.race('probe: crashes', async (_env, i) => {
        if (i === 1) throw thrown;
      });
      t.race('probe: type error', async () => {
        throw new TypeError('bug in the suite');
      });
      t.test('probe: hangs', () => new Promise<void>(() => {}), { timeoutMs: 5 });
    });
    const out = await collect((r) => registerAll(resolved(r, { iterations: 3 }), [probe]));
    expect(out.errors['probe: crashes']).toBe(thrown);
    expect(out.errors['probe: type error']).toBeInstanceOf(TypeError);
    expect((out.errors['probe: type error'] as Error).message).toBe('iteration 0: bug in the suite');
    expect(out.errors['probe: hangs']).toBeInstanceOf(ConformanceTimeoutError);
    expect(out.errors['probe: hangs']).not.toBeInstanceOf(assert.AssertionError);
  });

  it('suite: the core merge race runs in a namespace of its own, which the harness cleans up', async () => {
    const stores: MemoryStore[] = [];
    const title = 'merge: 50 concurrent merges into one waiting job keep every payload';
    const core = (store: Store, scope?: Scope) => new Queue(scope?.queue ?? 'merge', { store, logger: false, ...(scope && { namespace: scope.namespace }) });
    const make = (o: { clock?: () => number }) => {
      const st = new MemoryStore(o);
      stores.push(st);
      return st;
    };
    const r = await runAgainst(make, [title], { core, iterations: 2 });
    expect(r.passed).toEqual([title]);
    const used = stores.flatMap((st) => Object.keys(st.dump().meta));
    expect(used.length).toBeGreaterThan(0);
    for (const ns of used) expect(ns).toMatch(/^conf-/);
    expect(stores.flatMap((st) => st.dump().jobs.filter((j) => used.includes(j.namespace)))).toEqual([]);
  });

  it('suite: clock and lease groups run in real-time mode even in a fake run', async () => {
    for (const realTime of [false, true]) {
      const f = memoryFactory();
      const noop = (name: string) => (t: Parameters<ConformanceGroup['register']>[0]) => t.test(`${name}: x`, async () => {});
      const groups = [group('clock', noop('clock'), { mode: 'real' }), group('lease', noop('lease'), { mode: 'real' }), group('other', noop('other'))];
      const out = await collect((r) => registerAll(resolved(r, { createStore: f.createStore, realTime }), groups));
      expect(out.results['other: x']).toBe('pass');
      // the first context belongs to the harness's own suite group
      const [clock, lease, other] = f.contexts.slice(1);
      expect(clock!.clock).toBeNull();
      expect(lease!.clock).toBeNull();
      if (realTime) expect(other!.clock).toBeNull();
      else expect(typeof other!.clock!.now()).toBe('number');
    }
  });

  it('suite: createStore failure fails the whole run', async () => {
    const boom = new TypeError('boom');
    const probe = group('probe', (t) => t.test('probe: x', async () => {}));
    const out = await collect((r) => registerAll(resolved(r, { createStore: async () => Promise.reject(boom) }), [probe]));
    expect(out.hookErrors[0]).toBe(boom);
    expect(Object.values(out.results)).not.toContain('pass');
    expect(out.results['probe: x']).toBe('fail');
    // the report counts the group that could not start, so the run is not conformant
    const report = join(mkdtempSync(join(tmpdir(), 'sureq-harness-')), 'r.json');
    const clockOk = group('clock', (t) => t.test('clock: ok', async () => {}), { mode: 'real' });
    let calls = 0;
    const flaky = async (ctx: HarnessContext) => (++calls === 3 ? Promise.reject(boom) : memoryFactory().createStore(ctx));
    await collect((runner) => runGroups({ name: 'x', createStore: flaky, runner, report }, [clockOk, group('lease', (t) => t.test('lease: ok', async () => {}), { mode: 'real' })]));
    const r = JSON.parse(readFileSync(report, 'utf8')) as ConformanceReport;
    expect(r.failed).toBeGreaterThan(0);
    expect(r.conformant).toBe(false);
  });

  it('suite: a test the runner abandons counts as failed in the report', async () => {
    const report = join(mkdtempSync(join(tmpdir(), 'sureq-harness-')), 'r.json');
    const hang = group('clock', (t) => t.test('clock: hangs', () => new Promise<void>(() => {})), { mode: 'real' });
    const ok = group('lease', (t) => t.test('lease: ok', async () => {}), { mode: 'real' });
    // a runner that gives up on the hanging test without waiting, as a runner timeout does
    await collect((r) =>
      runGroups({ name: 'x', createStore: memoryFactory().createStore, report, runner: { ...r, it: (n, fn) => r.it(n, n === 'clock: hangs' ? () => void fn() : fn) } }, [hang, ok]),
    );
    await new Promise((res) => setTimeout(res, 10));
    const out = JSON.parse(readFileSync(report, 'utf8')) as ConformanceReport;
    expect(out.passed).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.conformant).toBe(false);
  });

  it('suite: skipping a capability skips only tests that need it, never tests for its absence', async () => {
    class NoTx extends MemoryStore {
      override readonly capabilities = defineCapabilities({ ...new MemoryStore().capabilities, transactions: false });
    }
    const createStore = async () => {
      const store = new NoTx();
      return { store, cleanup: async () => {} };
    };
    const probe = group('capabilities', (t) => {
      t.test('capabilities: needs', async () => {}, { requires: 'transactions' });
      t.test('capabilities: absent', async () => {}, { absent: 'transactions' });
    });
    const out = await collect((r) => registerAll(resolved(r, { createStore, skip: ['capabilities:transactions'] }), [probe]));
    expect(out.results['capabilities: needs']).toBe('skip');
    expect(out.results['capabilities: absent']).toBe('pass');
  });

  it('suite: a shared store opens a bounded number of pods during a race', async () => {
    class Shared extends MemoryStore {
      override readonly capabilities = defineCapabilities({ ...new MemoryStore().capabilities, shared: true });
    }
    let open = 0;
    let peak = 0;
    const createStore = async () => {
      const store = new Shared();
      peak = Math.max(peak, ++open);
      return { store, cleanup: async () => void open-- };
    };
    const probe = group('probe', (t) =>
      t.race('probe: pods', async (env) => {
        const pods = await env.pods(5);
        expect(new Set(pods).size).toBe(5);
      }),
    );
    const out = await collect((r) => registerAll(resolved(r, { createStore, iterations: 50 }), [probe]));
    expect(out.results['probe: pods']).toBe('pass');
    // the suite group's store, the probe group's store and one set of five pods
    expect(peak).toBeLessThanOrEqual(7);
    expect(open).toBe(0);
  });

  it('suite: optIn group runs only when named in groups', async () => {
    const probe = group('probe', (t) => t.test('probe: x', async () => {}), { optIn: true });
    const off = await collect((r) => registerAll(resolved(r), [probe]));
    expect(off.results['probe: x']).toBeUndefined();
    const on = await collect((r) => registerAll(resolved(r, { groups: ['probe'] }), [probe]));
    expect(on.results['probe: x']).toBe('pass');
  });

  it('suite: gated tests are skipped by capability and counted', async () => {
    const probe = group('probe', (t) => t.test('probe: durable', async () => {}, { requires: 'durable' }));
    let collector: ReturnType<typeof registerAll> | undefined;
    const out = await collect((r) => void (collector = registerAll(resolved(r), [probe])));
    expect(out.results['probe: durable']).toBe('skip');
    // the harness's durable reopen check is gated the same way
    expect(collector!.skipped).toBe(2);
    expect(collector!.passed).toBe(0);
  });
});
