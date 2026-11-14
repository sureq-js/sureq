import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

describe('package', () => {
  it('suite: package has zero runtime dependencies and peers on core', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.peerDependencies['@sureq/core']).toBe('^1.0.0-rc.1');
  });

  it('suite: sources never import Queue or Worker', () => {
    const imports = files(join(root, 'src')).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"][^'"]+['"]/g)].map((m) => m[0]),
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((l) => /\b(Queue|Worker)\b/.test(l) || /(queue|worker)\//.test(l))).toEqual([]);
  });
});
