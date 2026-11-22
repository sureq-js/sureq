import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devDocsRoot, hasDevDocs, repoRoot, workspaceDirs } from '../helpers/dev-docs.js';

const files = (dir: string, ext: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === 'node_modules' || name === 'dist') return [];
        return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
      });
/** Every TypeScript file under each workspace's `src` and `tests`. */
const code = (...parts: Array<'src' | 'tests'>): string[] => workspaceDirs().flatMap((dir) => parts.flatMap((p) => files(join(dir, p), '.ts')));
const rel = (f: string) => f.slice(repoRoot.length + 1);

/** Comments (line and block) and test-title literals of one file. */
const TITLE = /\b(?:it|test|describe|race)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\))?)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const codeText = (text: string): string[] => [
  ...[...text.matchAll(/(?<![:'"`\\])\/\/(.*)$/gm)].map((m) => m[1]!),
  ...[...text.matchAll(/\/\*([\s\S]*?)\*\//g)].map((m) => m[1]!),
  ...[...text.matchAll(TITLE)].map((m) => m[2]!),
];
/** Feature ids from the first column of the roadmap tables, read only where the planning docs exist. */
const featureIds = (): RegExp | null => {
  if (!hasDevDocs) return null;
  const ids = [...readFileSync(join(devDocsRoot, 'ROADMAP.md'), 'utf8').matchAll(/^\| ([A-Z]\d+[a-z]?) \|/gm)].map((m) => m[1]!);
  return new RegExp(`\\b(?:${[...new Set(ids)].join('|')})\\b`);
};

// Built from parts so this file does not match itself.
const FOCUS = new RegExp(['\\b(it|test|describe)\\.(skip|todo|only)\\b', '\\bx(it|describe)\\(', '\\bfit\\(', '\\bfdescribe\\('].join('|'));

describe('test hygiene', () => {
  it('hygiene: no skipped, todo or only tests', () => {
    const offenders = code('src', 'tests').filter((f) => FOCUS.test(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('hygiene: no v8 ignore without a reason', () => {
    const ignores = code('src').flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => /\/\*\s*(v8|c8) ignore/.test(line))
        .map((line) => ({ file: rel(f), line: line.trim() })),
    );
    expect(ignores.filter((i) => !/ignore[^*]*--\s*\S/.test(i.line))).toEqual([]);
    expect(ignores.length).toBeLessThanOrEqual(5);
  });

  it('hygiene: no feature ids or section references in comments and test titles', () => {
    const ids = featureIds();
    const found = code('src', 'tests').flatMap((f) =>
      codeText(readFileSync(f, 'utf8'))
        .filter((t) => /§|\b(?:release|version) 0\.\d/i.test(t) || (ids?.test(t) ?? false))
        .map((t) => `${rel(f)}: ${t.trim().slice(0, 100)}`),
    );
    expect(found).toEqual([]);
  });
});

describe('repository hygiene', () => {
  const read = (path: string): string => (existsSync(join(repoRoot, path)) ? readFileSync(join(repoRoot, path), 'utf8') : '');

  it('repo: SECURITY.md, CONTRIBUTING.md and a deprecation policy exist', () => {
    const security = read('SECURITY.md');
    expect(read('CONTRIBUTING.md').trim()).not.toBe('');
    expect(security).toMatch(/privately/i);
    // The private channel is named, and no placeholder is left.
    expect(security).toContain('Report a vulnerability');
    expect(security).not.toMatch(/OWNER:|has not been set up/);
    const readme = read('packages/core/README.md');
    expect(readme).toMatch(/semver/i);
    expect(readme).toMatch(/deprecat/i);
  });

  it('repo: published packages name the GitHub repository, and their READMEs link only to files in it', () => {
    const REPO = 'https://github.com/sureq-js/sureq';
    for (const pkg of ['core', 'store-test']) {
      const json = JSON.parse(read(`packages/${pkg}/package.json`)) as Record<string, unknown>;
      expect(json.repository, pkg).toEqual({ type: 'git', url: `git+${REPO}.git`, directory: `packages/${pkg}` });
      expect(json.bugs, pkg).toEqual({ url: `${REPO}/issues` });
      // npm shows only the package folder, so a link that leaves it must be a full URL
      const readme = read(`packages/${pkg}/README.md`);
      expect(readme, pkg).not.toMatch(/\]\(\.\.\//);
      for (const [, kind, path] of readme.matchAll(/\]\(https:\/\/github\.com\/sureq-js\/sureq\/(blob|tree)\/main\/([^)#\s]+)/g)) {
        expect(existsSync(join(repoRoot, path!)), `${pkg}: ${kind}/main/${path}`).toBe(true);
      }
    }
  });

  it('repo: every public declaration and member has a doc comment, so editors show it on hover', () => {
    // api:check keeps the reports equal to the built types, so a member added without /** */ shows up here as "(undocumented)".
    for (const report of ['etc/core.api.md', 'etc/core-producer.api.md', 'etc/store-test.api.md']) {
      const text = read(report);
      expect(text, report).not.toBe('');
      const lines = text.split('\n');
      const missing = lines.flatMap((l, i) => (l.includes('(undocumented)') ? [lines[i + 1]!.trim()] : []));
      expect(missing, report).toEqual([]);
    }
  });

  it('repo: the publish workflow runs only on a package release tag, from the approval environment, and requests an OIDC token', () => {
    const yml = read('.github/workflows/publish.yml');
    const on = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(yml)?.[1] ?? '';
    expect(on).toMatch(/^  push:\n    tags:\n      - '@sureq\/\*@\*'$/m);
    expect(on).not.toMatch(/workflow_dispatch/);
    expect(yml).toMatch(/^    environment: npm-publish$/m);
    expect(yml).toMatch(/^\s+id-token: write$/m);
    expect(yml).toMatch(/--provenance/);
    // one package per run: the one the tag names, under the dist-tag the tag check derived
    const publishes = yml.split('\n').filter((l) => /\bnpm publish\b/.test(l));
    expect(publishes).toHaveLength(1);
    expect(publishes[0]).toContain('--tag ${{ steps.pkg.outputs.dist_tag }}');
    expect(publishes[0]).toContain('-w ${{ steps.pkg.outputs.name }}');
    expect(yml.indexOf('id: pkg')).toBeLessThan(yml.indexOf('npm ci'));
  });

  it('repo: the publish tag check accepts only a public package at its version on main; a prerelease goes under next', () => {
    const yml = read('.github/workflows/publish.yml');
    // the tag-check step's own script, dedented, run the way the runner runs it
    const step = /^ {8}id: pkg\n[\s\S]*?^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(yml)?.[1];
    expect(step).toBeDefined();
    const script = step!.replace(/^ {10}/gm, '');
    const repo = mkdtempSync(join(tmpdir(), 'sureq-publish-'));
    try {
      const pkg = (dir: string, json: object) => {
        mkdirSync(join(repo, 'packages', dir), { recursive: true });
        writeFileSync(join(repo, 'packages', dir, 'package.json'), JSON.stringify(json));
      };
      pkg('core', { name: '@sureq/core', version: '1.0.2' });
      pkg('store-test', { name: '@sureq/store-test', version: '1.0.1' });
      pkg('internal', { name: '@sureq/internal', version: '1.0.0', private: true });
      pkg('rc', { name: '@sureq/rc', version: '1.1.0-rc.1' });
      // a stand-in git: `merge-base --is-ancestor` answers with ON_MAIN's status
      const bin = join(repo, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit "${ON_MAIN:-0}"\n', { mode: 0o755 });
      const run = (tag: string, onMain = 0) => {
        const out = join(repo, `output-${Math.random()}`);
        writeFileSync(out, '');
        const r = spawnSync('sh', ['-c', script], {
          cwd: repo, encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env['PATH']}`, TAG: tag, ON_MAIN: String(onMain), GITHUB_OUTPUT: out },
        });
        return { status: r.status, output: readFileSync(out, 'utf8'), log: r.stdout + r.stderr };
      };
      expect(run('@sureq/core@1.0.2')).toMatchObject({ status: 0, output: 'name=@sureq/core\ndist_tag=latest\n' });
      expect(run('@sureq/store-test@1.0.1')).toMatchObject({ status: 0, output: 'name=@sureq/store-test\ndist_tag=latest\n' });
      expect(run('@sureq/rc@1.1.0-rc.1')).toMatchObject({ status: 0, output: 'name=@sureq/rc\ndist_tag=next\n' });
      expect(run('@sureq/core@1.0.3')).toMatchObject({ status: 1, output: '' });
      expect(run('@sureq/core@1.0.3').log).toContain('does not match');
      expect(run('@sureq/nope@1.0.0').log).toContain('names no package');
      expect(run('@sureq/internal@1.0.0').log).toContain('is private');
      expect(run('@sureq/core@1.0.2', 1)).toMatchObject({ status: 1, output: '' });
      expect(run('@sureq/core@1.0.2', 1).log).toContain('not point at a commit on main');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
