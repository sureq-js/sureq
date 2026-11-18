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

  it('repo: the publish workflow runs only on a release tag, from the approval environment, and requests an OIDC token', () => {
    const yml = read('.github/workflows/publish.yml');
    const on = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(yml)?.[1] ?? '';
    expect(on).toMatch(/^  push:\n    tags:\n      - 'v\*'$/m);
    expect(on).not.toMatch(/workflow_dispatch/);
    expect(yml).toMatch(/^    environment: npm-publish$/m);
    expect(yml).toMatch(/^\s+id-token: write$/m);
    expect(yml).toMatch(/--provenance/);
  });

  it('repo: the publish workflow publishes a prerelease under the next tag, never latest', () => {
    const yml = read('.github/workflows/publish.yml');
    expect(yml).toContain(`version=$(node -p "require('./packages/core/package.json').version")`);
    // run the workflow's own case block, the way the step runs it
    const block = /^\s*(case "\$version" in\n[\s\S]*?\n\s*esac)$/m.exec(yml)?.[1];
    expect(block).toBeDefined();
    // GITHUB_OUTPUT is a file, as on a runner; /dev/stdout cannot be reopened on Linux, where a child's stdout is a socket
    const tagFor = (version: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'sureq-tag-'));
      try {
        const out = join(dir, 'output');
        writeFileSync(out, '');
        spawnSync('sh', ['-c', block!], { encoding: 'utf8', env: { ...process.env, version, GITHUB_OUTPUT: out } });
        return readFileSync(out, 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(tagFor('1.0.0-rc.1')).toBe('tag=next\n');
    expect(tagFor('1.0.0')).toBe('tag=latest\n');
    // the tag is shared, so the step before install refuses packages whose versions differ
    const check = /^\s*(node -e "\n[\s\S]*?package versions differ[\s\S]*?\n\s*")$/m.exec(yml)?.[1];
    expect(check).toBeDefined();
    expect(yml.indexOf(check!)).toBeLessThan(yml.indexOf('npm ci'));
    expect(spawnSync('sh', ['-c', check!], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    const skewed = mkdtempSync(join(tmpdir(), 'sureq-versions-'));
    try {
      for (const [dir, version] of [['core', '1.0.0-rc.1'], ['store-test', '1.0.0']]) {
        mkdirSync(join(skewed, 'packages', dir!), { recursive: true });
        writeFileSync(join(skewed, 'packages', dir!, 'package.json'), JSON.stringify({ version }));
      }
      const r = spawnSync('sh', ['-c', check!], { cwd: skewed, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('package versions differ');
    } finally {
      rmSync(skewed, { recursive: true, force: true });
    }
    const publishes = yml.split('\n').filter((l) => /\bnpm publish\b/.test(l));
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) expect(line).toContain('--tag ${{ steps.dist-tag.outputs.tag }}');
  });
});
