import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';
import { PRODUCER_NAMES, PUBLIC_NAMES } from '../public-names.js';

const root = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
const esmPath = join(root, 'dist/index.js');
const cjsPath = join(root, 'dist/index.cjs');
const producerEsm = join(root, 'dist/producer.js');
const producerCjs = join(root, 'dist/producer.cjs');

type Entry = { import: { types: string; default: string }; require: { types: string; default: string } };
/** The names each subpath must expose; a subpath missing here fails the loops below. */
const NAMES: Record<string, readonly string[]> = { '.': PUBLIC_NAMES, './producer': PRODUCER_NAMES };
/** Every subpath of `exports` but `./package.json`, with its built files. */
const subpaths = Object.entries(pkg['exports'] as Record<string, Entry | string>)
  .filter((e): e is [string, Entry] => e[0] !== './package.json')
  .map(([key, entry]) => ({ key, entry, esm: join(root, entry.import.default), cjs: join(root, entry.require.default) }));
const names = (key: string): string[] => {
  expect(NAMES[key], `public names of ${key}`).toBeDefined();
  return [...NAMES[key]!].sort();
};

/** A temp project whose node_modules/@sureq/core is a symlink to the repo root. */
const tempProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sureq-pkg-'));
  mkdirSync(join(dir, 'node_modules/@sureq'), { recursive: true });
  symlinkSync(root, join(dir, 'node_modules/@sureq/core'), 'dir');
  return dir;
};
const node = (cwd: string, code: string): string =>
  execFileSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8' });

const srcFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });

describe('pkg', () => {
  it('pkg: PUBLIC_NAMES lists every export of src/index.ts', async () => {
    expect(Object.keys(await import('../../src/index.js')).sort()).toEqual([...PUBLIC_NAMES].sort());
  });

  it('pkg: dependencies object is empty', () => {
    expect(pkg['dependencies']).toEqual({});
  });

  it('pkg: export names of ESM and CJS builds are identical', async () => {
    expect(subpaths.map((s) => s.key)).toEqual(['.', './producer']);
    for (const { key, esm, cjs } of subpaths) {
      const fromEsm = Object.keys(await import(pathToFileURL(esm).href)).sort();
      const fromCjs = Object.keys(createRequire(import.meta.url)(cjs) as object).sort();
      expect(fromEsm, key).toEqual(fromCjs);
    }
  });

  it('pkg: ESM import exposes the documented public names', async () => {
    for (const { key, esm } of subpaths) expect(Object.keys(await import(pathToFileURL(esm).href)).sort(), key).toEqual(names(key));
  });

  it('pkg: CJS require exposes the same names', () => {
    for (const { key, cjs } of subpaths) expect(Object.keys(createRequire(import.meta.url)(cjs) as object).sort(), key).toEqual(names(key));
  });

  it('pkg: producer subpath exposes the same names from ESM and CJS', async () => {
    expect(Object.keys(await import('../../src/producer.js')).sort()).toEqual([...PRODUCER_NAMES].sort());
    expect(Object.keys(await import(pathToFileURL(producerEsm).href)).sort()).toEqual([...PRODUCER_NAMES].sort());
    expect(Object.keys(createRequire(import.meta.url)(producerCjs) as object).sort()).toEqual([...PRODUCER_NAMES].sort());
  });

  it("pkg: errors from the producer entry are the main entry's classes", async () => {
    const [p, m] = await Promise.all([import(pathToFileURL(producerEsm).href), import(pathToFileURL(esmPath).href)]) as Array<Record<string, unknown>>;
    const req = createRequire(import.meta.url);
    const [pc, mc] = [req(producerCjs), req(cjsPath)] as Array<Record<string, unknown>>;
    for (const name of PRODUCER_NAMES.filter((n) => n !== 'Producer')) {
      expect(p![name], name).toBe(m![name]);
      expect(pc![name], name).toBe(mc![name]);
    }
    expect(p!['Producer']).toBe(m!['Producer']);
    expect(pc!['Producer']).toBe(mc!['Producer']);
  });

  it('pkg: no any in exported declarations', () => {
    for (const file of subpaths.flatMap((s) => [s.entry.import.types, s.entry.require.types])) {
      // Comments may say "any"; only the `any` type is banned.
      const code = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/\bany\b/);
    }
  });

  it('pkg: only exports entries are importable', () => {
    const dir = tempProject();
    const out = node(
      dir,
      `for (const f of ['index', 'producer']) {
         import('@sureq/core/dist/' + f + '.js').then(() => console.log('imported'), e => console.log(e.code));
         try { require('@sureq/core/dist/' + f + '.cjs'); console.log('required') } catch (e) { console.log(e.code) }
       }`,
    );
    expect(out.trim().split('\n')).toEqual(Array(4).fill('ERR_PACKAGE_PATH_NOT_EXPORTED'));
  }, 30_000);

  it('pkg: pack contents are limited to dist, README, LICENSE, package.json', () => {
    const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })) as Array<{
      files: Array<{ path: string }>;
    }>;
    const paths = report!.files.map((f) => f.path);
    expect(paths).toContain('package.json');
    for (const p of paths) expect(['package.json', 'README.md', 'LICENSE'].includes(p) || p.startsWith('dist/')).toBe(true);
  }, 30_000);

  it('pkg: no source uses an API newer than Node 22.0 without a fallback', () => {
    const deny = ['Promise.try', 'RegExp.escape', 'Iterator.from', 'Float16Array', '.union(', '.intersection(', '.difference(', '.symmetricDifference('];
    for (const file of srcFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const api of deny) expect(text.includes(api), `${file} uses ${api}`).toBe(false);
    }
  });

  it.each([
    ['node16', 'node16'],
    ['nodenext', 'nodenext'],
    ['esnext', 'bundler'],
  ])('pkg: types resolve under node16, nodenext and bundler resolution (%s/%s)', (module, moduleResolution) => {
    const dir = tempProject();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'es2022', module, moduleResolution, strict: true, noEmit: true, skipLibCheck: false }, files: ['main.ts'] }),
    );
    writeFileSync(join(dir, 'main.ts'), subpaths.map((s) => `import {} from '@sureq/core${s.key.slice(1)}';\n`).join(''));
    expect(() => execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', dir], { encoding: 'utf8' })).not.toThrow();
  }, 60_000);

  it('pkg: CI runs Node 22 and 24 and the dist suite', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    for (const needle of ['22', '24', 'test:dist', 'check:pkg', "typescript: ['5.0', 'latest']"]) expect(ci).toContain(needle);
  });

  it('pkg: publint and attw report no errors', () => {
    expect(() => execFileSync(process.execPath, [join(repoRoot, 'scripts/check-pkg.mjs')], { cwd: root, encoding: 'utf8' })).not.toThrow();
  }, 120_000);
});
