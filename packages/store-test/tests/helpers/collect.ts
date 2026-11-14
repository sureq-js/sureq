import type { RunnerHooks } from '../../src/types.js';

type Fn = () => Promise<void> | void;
interface Suite {
  name: string;
  tests: { title: string; fn: (ctx: { skip(): void }) => Promise<void> | void }[];
  before: Fn[];
  after: Fn[];
  children: Suite[];
}
export type Outcome = 'pass' | 'fail' | 'skip';
export interface Collected {
  results: Record<string, Outcome>;
  errors: Record<string, unknown>;
  hookErrors: unknown[];
}

/**
 * A recording runner: `describe` bodies run at once; then each suite runs its `before` hooks, its tests in
 * order and its `after` hooks. `only` limits which tests run (suites with none selected are not started).
 */
export async function collect(register: (runner: RunnerHooks) => void, only?: (title: string) => boolean): Promise<Collected> {
  const root: Suite = { name: '', tests: [], before: [], after: [], children: [] };
  let current = root;
  const runner: RunnerHooks = {
    describe(name, fn) {
      const parent = current;
      const s: Suite = { name, tests: [], before: [], after: [], children: [] };
      parent.children.push(s);
      current = s;
      try {
        fn();
      } finally {
        current = parent;
      }
    },
    it: (title, fn) => void current.tests.push({ title, fn: fn as Suite['tests'][number]['fn'] }),
    before: (fn) => void current.before.push(fn),
    after: (fn) => void current.after.push(fn),
  };
  register(runner);
  const out: Collected = { results: {}, errors: {}, hookErrors: [] };
  const selected = (s: Suite): boolean => s.tests.some((t) => !only || only(t.title)) || s.children.some(selected);

  const runSuite = async (s: Suite): Promise<void> => {
    let hookFailed: unknown;
    try {
      for (const h of s.before) await h();
    } catch (err) {
      hookFailed = err ?? new Error('before hook failed');
      out.hookErrors.push(err);
    }
    for (const t of s.tests) {
      if (only && !only(t.title)) continue;
      if (hookFailed !== undefined) {
        out.results[t.title] = 'fail';
        out.errors[t.title] = hookFailed;
        continue;
      }
      let skipped = false;
      try {
        await t.fn({ skip: () => void (skipped = true) });
        out.results[t.title] = skipped ? 'skip' : 'pass';
      } catch (err) {
        out.results[t.title] = 'fail';
        out.errors[t.title] = err;
      }
    }
    for (const c of s.children) if (selected(c)) await runSuite(c);
    for (const h of s.after) {
      try {
        await h();
      } catch (err) {
        out.hookErrors.push(err);
      }
    }
  };
  await runSuite(root);
  return out;
}
