import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

const here = import.meta.dirname;
const repo = resolve(here, '../../..');
// The adapter-author guide is the user-docs page; the package README links to it.
const files = {
  guide: join(repo, 'user-docs/04-stores/02-writing-your-own.md'),
  readme: join(repo, 'packages/store-test/README.md'),
  template: join(repo, 'examples/store-template/README.md'),
  root: join(repo, 'README.md'),
};
const groupsDir = join(here, '../src/groups');
const text = (f: string): string => readFileSync(f, 'utf8');
const guideText = text(files.guide);

const METHODS = [
  'open', 'close', 'now', 'add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'get', 'list', 'counts',
  'setPaused', 'isPaused', 'stats', 'getAttempts', 'clean', 'obliterate', 'redrive', 'setProgress', 'registerWorker', 'heartbeatWorker',
  'unregisterWorker', 'listWorkers', 'purgeWorkers', 'ensureNamespaceMeta', 'getNamespaceMeta', 'putSchedule', 'getSchedule',
  'listSchedules', 'deleteSchedule', 'listDueSchedules', 'fireSchedule',
] as const;

/** The text of the guide's `## title` section, up to the next `## ` heading. */
function section(title: string): string {
  const start = guideText.indexOf(`\n## ${title}\n`);
  expect(start, `section ${title} exists`).toBeGreaterThanOrEqual(0);
  const next = guideText.indexOf('\n## ', start + 1);
  return guideText.slice(start, next === -1 ? undefined : next);
}

const groupFiles = readdirSync(groupsDir).filter((f) => f.endsWith('.ts'));
const groupSource = groupFiles.map((f) => text(join(groupsDir, f))).join('\n');
const groupNames = new Set([...groupSource.matchAll(/\bname: '([\w-]+)'/g)].map((m) => m[1]!));
const suiteTitles = new Set([...groupSource.matchAll(/(['"])((?:(?!\1).)+)\1/g)].map((m) => m[2]!));

describe('guide', () => {
  it('guide: contains all its sections in order', () => {
    const titles = [...guideText.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(titles).toEqual([
      'Before you start', 'The six primitives', 'How each operation maps to a database', 'Build order', 'Atomicity checklist',
      'Common mistakes', 'Capabilities', 'The template', 'Running the suite', 'Publishing', 'When the contract changes', 'Getting help',
    ]);
    // the template cannot show isolation mistakes, so the suite must also run against the real database
    expect(section('The template')).toMatch(/(?=[\s\S]*\bisolation\b)(?=[\s\S]*\btemplate\b)/i);
    expect(section('Running the suite')).toMatch(/(?=[\s\S]*\bisolation\b)(?=[\s\S]*\breal database\b)/i);
  });

  it('guide: the package README points to the guide instead of repeating it', () => {
    const readme = text(files.readme);
    expect(readme).toContain('(https://github.com/sureq-js/sureq/blob/main/user-docs/04-stores/02-writing-your-own.md)');
    expect(readme).not.toMatch(/^### /m);
  });

  it("guide: every method appears in the guide's atomicity checklist", () => {
    const rows = section('Atomicity checklist').split('\n').filter((l) => l.startsWith('|'));
    for (const method of METHODS) expect(rows.some((r) => r.startsWith(`| \`${method}\` |`)), `row for ${method}`).toBe(true);
  });

  it('guide: every build-order step names conformance groups that exist in the suite', () => {
    const steps = section('Build order').split('\n').filter((l) => /^\| \d+ \|/.test(l));
    expect(steps).toHaveLength(8);
    const capabilities = text(join(groupsDir, 'capabilities.ts'));
    for (const step of steps) {
      const tokens = [...step.matchAll(/`([a-z-]+):([a-zA-Z]*)`/g)];
      expect(tokens.length, step).toBeGreaterThan(0);
      for (const [, group, flag] of tokens) {
        expect(groupNames.has(group!), `group ${group} exists`).toBe(true);
        if (flag) expect(capabilities, `flag ${flag}`).toContain(`'${flag}'`);
      }
    }
  });

  it('guide: every "common mistake" names a test title that exists in the suite', () => {
    const titles = [...section('Common mistakes').matchAll(/`((?:contract|claim|fencing|clock|dedup|sweep|lease|release|cancel|gpause|poison|singleton|idem|merge): [^`]+)`/g)].map((m) => m[1]!);
    expect(titles.length).toBeGreaterThanOrEqual(10);
    for (const title of titles) expect(suiteTitles.has(title), `suite has "${title}"`).toBe(true);
  });

  // a full type-check of core from source: seconds alone, longer under coverage beside other test files
  it('guide: code samples compile', { timeout: 30_000 }, () => {
    // the real path: on macOS tmpdir() is a symlink, and tsc would print sample paths relative to the other spelling
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guide-samples-')));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const samples: string[] = [];
    for (const file of [files.guide, files.template]) {
      for (const m of text(file).matchAll(/^```ts\n([\s\S]*?)^```/gm)) {
        const path = join(dir, `sample${samples.length}.ts`);
        writeFileSync(path, m[1]!);
        samples.push(path);
      }
    }
    expect(samples.length).toBeGreaterThanOrEqual(3);
    const compilerOptions = {
      strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022',
      noEmit: true, skipLibCheck: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, types: ['node'],
      typeRoots: [join(repo, 'node_modules/@types')],
      paths: { '@sureq/core': [join(repo, 'packages/core/src/index.ts')], '@sureq/store-test': [join(repo, 'packages/store-test/src/index.ts')] },
    };
    // Each sample is its own module: give it an export so top-level names do not collide.
    for (const path of samples) if (!/^(import|export) /m.test(text(path))) writeFileSync(path, `${text(path)}\nexport {};\n`);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: samples }));
    // The samples are ES modules, as the docs tell users to set up; without this, older TypeScript reads them as CommonJS.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    // The tsc command, not the compiler API: TypeScript 7 ships no JavaScript API, and the command is the same in 5, 6 and 7.
    const r = spawnSync(join(repo, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: dir, encoding: 'utf8' });
    expect(r.error).toBeUndefined();
    const errors = `${r.stdout}${r.stderr}`.split('\n').filter((line) => /error TS\d+/.test(line));
    // Report only the samples' own errors, as before: core's sources are checked by its own typecheck.
    expect(errors.filter((line) => /(^|[\\/])sample\d+\.ts\(/.test(line))).toEqual([]);
    // An error with no file location (an unknown option, a bad tsconfig) means the check did not run.
    expect(errors.filter((line) => !/^\S[^(]*\(\d+,\d+\): error TS/.test(line))).toEqual([]);
    // tsc ran to the end: it exits 0, or 1 or 2 with file errors only
    expect([0, 1, 2]).toContain(r.status);
  });

  it('guide: relative links resolve', () => {
    for (const file of Object.values(files)) {
      const links = [...text(file).matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!);
      for (const link of links) expect(existsSync(resolve(dirname(file), link)), `${file}: ${link}`).toBe(true);
    }
  });
});
