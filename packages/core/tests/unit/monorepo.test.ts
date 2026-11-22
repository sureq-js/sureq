import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const readJson = (p: string) => JSON.parse(readFileSync(join(repoRoot, p), 'utf8')) as Json;
const parts = (v: string) => v.split('-')[0]!.split('.').map(Number) as [number, number, number];
/** Whether `version` is in the caret range `^min` (same major, not lower); enough for the ranges used here. */
const caretAccepts = (range: string, version: string): boolean => {
  if (!range.startsWith('^')) return false;
  const [a, b, c] = parts(range.slice(1));
  const [x, y, z] = parts(version);
  return x === a && (y > b || (y === b && z >= c));
};

describe('monorepo', () => {
  it('pkg: root is private and declares the workspaces', () => {
    const root = readJson('package.json');
    expect(root['private']).toBe(true);
    expect(root['workspaces']).toEqual(['packages/*', 'examples/*']);
    expect(root['main']).toBeUndefined();
    expect(root['exports']).toBeUndefined();
    for (const s of ['build', 'typecheck', 'test', 'test:types', 'lint', 'coverage', 'test:dist', 'check:pkg']) {
      expect(root['scripts'][s], s).toBeTypeOf('string');
    }
  });

  it('pkg: test:gates runs the stress suite at 100k+ jobs across many pods, then chaos and shutdown', () => {
    expect(readJson('package.json')['scripts']['test:gates']).toBe('npm run test:gates --workspaces --if-present');
    const core = readJson('packages/core/package.json')['scripts'];
    const size = (key: string) => Number(new RegExp(`\\b${key}=(\\d+)`).exec(core['test:stress'])?.[1]);
    expect(size('SUREQ_STRESS_JOBS')).toBeGreaterThanOrEqual(100_000);
    expect(size('SUREQ_STRESS_PODS')).toBeGreaterThanOrEqual(10);
    expect(core['test:gates']).toMatch(/^npm run test:stress && vitest run .*tests\/chaos.*tests\/regression\/sigterm-shutdown/);
    const kit = readJson('packages/store-test/package.json')['scripts'];
    expect(kit['test:gates']).toContain('tests/broken.test.ts');
    // the memory store's conformance run, stress group included, lives in the kit
    expect(kit['test:gates']).toMatch(/^npm run test:stress && /);
    expect(kit['test:stress']).toContain('tests/memory-store.test.ts');
  });

  it.each(['core', 'store-test'])(
    'pkg: every package has the same shape (type module, sideEffects false, engines, exports, files dist, no runtime dependencies): %s',
    (dir) => {
      const p = readJson(`packages/${dir}/package.json`);
      expect(p['name']).toBe(`@sureq/${dir}`);
      expect(p['version']).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
      expect(p['type']).toBe('module');
      expect(p['sideEffects']).toBe(false);
      expect(p['engines'].node).toBe('>=22');
      expect(p['files']).toEqual(['dist']);
      expect(p['dependencies'] ?? {}).toEqual({});
      expect(p['exports']['.'].import.types).toBe('./dist/index.d.ts');
      expect(p['exports']['.'].require.types).toBe('./dist/index.d.cts');
      expect(p['exports']['./package.json']).toBeDefined();
      for (const f of ['LICENSE', 'README.md']) expect(existsSync(join(repoRoot, 'packages', dir, f)), f).toBe(true);
    },
  );

  it.each(['store-test'])('pkg: store-test lists core as a peer dependency: %s', (dir) => {
    const p = readJson(`packages/${dir}/package.json`);
    expect(p['peerDependencies']['@sureq/core']).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(p['dependencies']?.['@sureq/core']).toBeUndefined();
  });
  it('pkg: packages are versioned on their own; each core peer range accepts the current core version', () => {
    const core = readJson('packages/core/package.json');
    for (const dir of ['packages/store-test', 'examples/store-template']) {
      const p = readJson(`${dir}/package.json`);
      const range = p['peerDependencies']['@sureq/core'] as string;
      expect(caretAccepts(range, core['version']), `${dir} peer ${range} vs core ${core['version']}`).toBe(true);
      expect(p['dependencies'] ?? {}, dir).toEqual({});
    }
    expect(readJson('examples/store-template/package.json')['private']).toBe(true);
  });
});
