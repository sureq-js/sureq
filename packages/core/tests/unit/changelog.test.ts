import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';

const version = (JSON.parse(readFileSync(join(repoRoot, 'packages/core/package.json'), 'utf8')) as { version: string }).version;
const changelog = readFileSync(join(repoRoot, 'packages/core/CHANGELOG.md'), 'utf8');

/** The section for `v`, from its heading up to the next one. */
const entryOf = (v: string): string => {
  const start = changelog.indexOf(`\n## ${v} - `);
  expect(start, v).toBeGreaterThan(0);
  return changelog.slice(start + 1, changelog.indexOf('\n## ', start + 1));
};
/** The bullets under one bold heading, up to the next heading. */
const area = (entry: string, name: string) =>
  entry.split(`**${name}**\n`)[1]?.split(/\n\n|\n\*\*/)[0]?.split('\n').filter((l) => l.startsWith('- ')) ?? [];

describe('changelog', () => {
  it('changelog: every published package has its own changelog with its version, listed in the root index', () => {
    const index = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    for (const dir of readdirSync(join(repoRoot, 'packages'))) {
      const pkgFile = join(repoRoot, 'packages', dir, 'package.json');
      if (!existsSync(pkgFile)) continue;
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name: string; version: string; private?: boolean };
      if (pkg.private) continue;
      const own = join(repoRoot, 'packages', dir, 'CHANGELOG.md');
      expect(existsSync(own), own).toBe(true);
      expect(readFileSync(own, 'utf8'), pkg.name).toContain(`\n## ${pkg.version} - `);
      expect(index, pkg.name).toContain(`packages/${dir}/CHANGELOG.md`);
    }
  });

  it('changelog: the current entry is headed by the package version and every group in it lists changes', () => {
    const entry = entryOf(version);
    expect(entry.split('\n')[0]).toMatch(/^## \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)? - (\d{4}-\d{2}-\d{2}|unreleased)$/);
    const groups = [...entry.matchAll(/^\*\*(.+)\*\*$/gm)].map((m) => m[1]!);
    expect(groups.length).toBeGreaterThan(0);
    for (const name of groups) expect(area(entry, name).length, name).toBeGreaterThan(0);
    expect(changelog.match(/\b[A-Z]\d{1,2}[a-z]?\b|§/g) ?? []).toEqual([]);
  });
});
