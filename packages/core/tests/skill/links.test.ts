import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';
import { readSkill, skillFiles, skillRoot } from '../helpers/skill-files.js';

/** Markdown text with fenced code blocks removed, so code is not read as links. */
const prose = (text: string): string => text.replace(/^```[\s\S]*?^```/gm, '');

/** The relative link targets in a skill file: no scheme, no protocol-relative URL. */
const relativeLinks = (file: string): string[] =>
  [...prose(readSkill(file)).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((m) => m[1] ?? '')
    .filter((target) => target !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//'));

/** GitHub's heading slug: lowercase, punctuation removed, spaces to hyphens. */
const slug = (heading: string): string =>
  heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

/** The anchors a Markdown file's headings produce, with GitHub's `-1`, `-2` suffixes for repeats. */
const anchors = (path: string): Set<string> => {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const m of prose(readFileSync(path, 'utf8')).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1] ?? '');
    const count = seen.get(base) ?? 0;
    result.add(count === 0 ? base : `${base}-${count}`);
    seen.set(base, count + 1);
  }
  return result;
};

/** Every relative link in the skill, resolved: the source file, the target path and its anchor. */
const links = skillFiles.flatMap((file) =>
  relativeLinks(file).map((target) => {
    const [path = '', anchor] = target.split('#');
    const source = join(skillRoot, file);
    const resolved = path === '' ? source : join(dirname(source), decodeURIComponent(path));
    return { file, target, resolved, anchor };
  }),
);

describe('skill: links', () => {
  it('skill: the skill has relative links to check', () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it('skill: every relative link points to an existing file or folder', () => {
    const broken = links
      .filter((l) => !existsSync(l.resolved))
      .map((l) => `${l.file}: ${l.target} (${relative(repoRoot, l.resolved)})`);
    expect(broken).toEqual([]);
  });

  it('skill: every anchor a link names exists as a heading in its target', () => {
    const broken = links
      .filter((l) => l.anchor !== undefined && l.anchor !== '')
      .filter((l) => existsSync(l.resolved) && statSync(l.resolved).isFile())
      .filter((l) => !anchors(l.resolved).has(decodeURIComponent(l.anchor ?? '').toLowerCase()))
      .map((l) => `${l.file}: ${l.target}`);
    expect(broken).toEqual([]);
  });
});
