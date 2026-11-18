import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';
import { readSkill, skillFiles } from '../helpers/skill-files.js';

/** The bodies of a skill file's ` ```ts ` blocks, found with the same regex as the guide test. */
const tsSamples = (file: string): string[] => [...readSkill(file).matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((m) => m[1]!);

/** The recipe samples that need no database: their first line is `// runs: memory`. */
const memorySamples = (): string[] => tsSamples('references/recipes.md').filter((s) => s.startsWith('// runs: memory\n'));

const tsc = join(repoRoot, 'node_modules/.bin/tsc');
const typeRoots = [join(repoRoot, 'node_modules/@types')];
const text = (f: string): string => readFileSync(f, 'utf8');

/** A fresh temp folder, by its real path (on macOS tmpdir() is a symlink), removed after the test. */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs `tsc -p` on a tsconfig and returns its error lines. */
function runTsc(dir: string): { status: number | null; errors: string[] } {
  const r = spawnSync(tsc, ['-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: dir, encoding: 'utf8' });
  expect(r.error).toBeUndefined();
  return { status: r.status, errors: `${r.stdout}${r.stderr}`.split('\n').filter((line) => /error TS\d+/.test(line)) };
}

/** Runs `node file`, resolving with the exit code (null on a timeout) and the output. */
function runNode(file: string, cwd: string, timeout: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [file], { cwd, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' && !err.killed ? err.code : null;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

describe('skill: samples', () => {
  /*
   * Which TypeScript compiles the samples: only the one installed in the repository, never a second one fetched here.
   * The skill promises TypeScript 5.0, 6.0 and latest. CI's `types` job installs 5.0 and latest (matrix in
   * .github/workflows/ci.yml) and then runs `npm run test:types` and `npm run typecheck`; this file runs in `npm test`
   * (and in CI's `npm run coverage`), not in `test:types`, which only collects tests/types/**\/*.test-d.ts.
   * So until that job also runs this file, the samples are compiled on the installed version alone.
   */
  it('skill: the sample compile check uses the installed TypeScript, 5.0 or later', () => {
    const r = spawnSync(tsc, ['--version'], { encoding: 'utf8' });
    expect(r.error).toBeUndefined();
    const installed = (JSON.parse(text(join(repoRoot, 'node_modules/typescript/package.json'))) as { version: string }).version;
    expect(r.stdout.trim()).toBe(`Version ${installed}`);
    expect(Number(installed.split('.')[0]), `TypeScript ${installed} is older than 5.0`).toBeGreaterThanOrEqual(5);
  });

  // a full type-check of core from source: seconds alone, longer under coverage beside other test files
  it('skill: every ts sample compiles with the docs compile options', { timeout: 60_000 }, () => {
    const dir = tempDir('skill-samples-');
    const samples: string[] = [];
    for (const file of skillFiles) {
      for (const body of tsSamples(file)) {
        const path = join(dir, `sample${samples.length}.ts`);
        writeFileSync(path, body);
        samples.push(path);
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(9);
    // The same options as the guide test in packages/store-test/tests/guide.test.ts.
    const compilerOptions = {
      strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022',
      noEmit: true, skipLibCheck: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, types: ['node'],
      typeRoots,
      paths: {
        '@sureq/core': [join(repoRoot, 'packages/core/src/index.ts')],
        '@sureq/core/producer': [join(repoRoot, 'packages/core/src/producer.ts')],
        '@sureq/store-test': [join(repoRoot, 'packages/store-test/src/index.ts')],
      },
    };
    // Each sample is its own module: give it an export so top-level names do not collide.
    for (const path of samples) if (!/^(import|export) /m.test(text(path))) writeFileSync(path, `${text(path)}\nexport {};\n`);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: samples }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const { status, errors } = runTsc(dir);
    expect(errors.filter((line) => /(^|[\\/])sample\d+\.ts\(/.test(line))).toEqual([]);
    // An error with no file location (an unknown option, a bad tsconfig) means the check did not run.
    expect(errors.filter((line) => !/^\S[^(]*\(\d+,\d+\): error TS/.test(line))).toEqual([]);
    expect([0, 1, 2]).toContain(status);
  });

  it('skill: recipes that need no database run to completion', { timeout: 180_000 }, async () => {
    const samples = memorySamples();
    expect(samples.length).toBeGreaterThan(0);
    // The samples run against the built package, as a user installs it.
    if (!existsSync(join(repoRoot, 'packages/core/dist/index.js'))) {
      const build = spawnSync('npm', ['run', 'build', '-w', '@sureq/core'], { cwd: repoRoot, encoding: 'utf8' });
      expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
    }
    const dir = tempDir('skill-recipes-');
    // node_modules points at the repo's, so `@sureq/core` resolves to the workspace package and its dist.
    symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const files = samples.map((body, i) => {
      const path = join(dir, `recipe${i}.mts`);
      writeFileSync(path, body);
      return path;
    });
    const compilerOptions = {
      strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022',
      skipLibCheck: true, types: ['node'], typeRoots, rootDir: dir, outDir: join(dir, 'out'),
    };
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files }));
    const { status, errors } = runTsc(dir);
    expect(errors).toEqual([]);
    expect(status).toBe(0);
    // Each recipe closes what it opens, so node exits by itself; top-level await keeps it running until then.
    const runs = await Promise.all(files.map((_, i) => runNode(join(dir, 'out', `recipe${i}.mjs`), dir, 20_000)));
    runs.forEach((run, i) => expect(run.code, `recipe ${i} exits 0 within 20 seconds:\n${samples[i]}\n${run.output}`).toBe(0));
  });

  it('skill: recipes.md has 9 recipes', () => {
    const recipes = readSkill('references/recipes.md').match(/^### /gm) ?? [];
    expect(recipes).toHaveLength(9);
    expect(tsSamples('references/recipes.md')).toHaveLength(9);
  });
});
