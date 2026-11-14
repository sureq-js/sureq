import { InvalidOptionError } from '@sureq/core';
import type { RunnerHooks } from './types.js';

type Fn = (name: string, fn: () => unknown) => void;
type Hook = (fn: () => unknown) => void;

/** The runner whose globals are present: Jest, Vitest (with globals) or node:test. */
export function detectRunner(): RunnerHooks {
  const g = globalThis as Record<string, unknown>;
  if (g['jest'] !== undefined || (process.env['VITEST'] && typeof g['describe'] === 'function')) {
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
