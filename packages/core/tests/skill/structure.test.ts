import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';
import { readSkill, skillFiles, skillRoot } from '../helpers/skill-files.js';

/** The frontmatter lines of SKILL.md, between the first two `---` lines. */
const frontmatter = (): string[] => {
  const lines = readSkill('SKILL.md').split('\n');
  const end = lines.indexOf('---', 1);
  return end > 0 ? lines.slice(1, end) : [];
};

/** The value of a `key: value` line in the frontmatter, at any indent. */
const field = (key: string): string | undefined => {
  const line = frontmatter().find((l) => l.trimStart().startsWith(`${key}:`));
  return line?.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
};

describe('skill: structure', () => {
  it('skill: SKILL.md starts with frontmatter whose name is "sureq"', () => {
    expect(readSkill('SKILL.md').split('\n')[0]).toBe('---');
    expect(field('name')).toBe('sureq');
  });

  it('skill: description is 40 to 400 characters and names the trigger words', () => {
    const description = field('description') ?? '';
    expect(description.length).toBeGreaterThanOrEqual(40);
    expect(description.length).toBeLessThanOrEqual(400);
    for (const word of ['queue', 'job', 'worker']) expect(description).toContain(word);
  });

  it('skill: metadata.version equals the package version', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/core/package.json'), 'utf8')) as { version: string };
    expect(frontmatter()).toContain('metadata:');
    expect(field('version')).toBe(pkg.version);
  });

  it('skill: the four files exist', () => {
    expect(skillFiles).toHaveLength(4);
    for (const file of skillFiles) expect(existsSync(join(skillRoot, file)), file).toBe(true);
  });

  it('skill: SKILL.md stays under 300 lines', () => {
    expect(readSkill('SKILL.md').split('\n').length).toBeLessThan(300);
  });
});
