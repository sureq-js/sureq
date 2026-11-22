import { InvalidOptionError } from '@sureq/core';
import type { RunnerHooks } from './types.js';

type Fn = (name: string, fn: () => unknown) => void;
type Hook = (fn: () => unknown) => void;

/** The runner whose globals are present: Jest, Vitest (with globals) or node:test. */
export function detectRunner(): RunnerHooks {
  const g = globalThis as Record<string, unknown>;
  // Jest sets JEST_WORKER_ID in every worker; its `jest` object is injected into each test file's scope, so it is
  // not on globalThis when this library runs. A global `jest` is still accepted where a setup puts one there.
  const jest = Boolean(process.env['JEST_WORKER_ID']) || g['jest'] !== undefined;
  if ((jest || process.env['VITEST']) && typeof g['describe'] === 'function') {
    return {
      describe: (name, fn) => (g['describe'] as Fn)(name, fn),
      it: (name, fn) => (g['it'] as Fn)(name, fn),
      before: (fn) => (g['beforeAll'] as Hook)(fn),
      after: (fn) => (g['afterAll'] as Hook)(fn),
    };
  }
  if (process.env['NODE_TEST_CONTEXT']) {
    const t = process.getBuiltinModule('node:test');
    return { describe: t.describe, it: t.it, before: t.before, after: t.after } as unknown as RunnerHooks;
  }
  throw new InvalidOptionError('runStoreConformance', [
    {
      path: 'runner',
      code: 'missing_option',
      message: 'no test runner detected; pass runner: { describe, it, before, after }',
    },
  ]);
}
