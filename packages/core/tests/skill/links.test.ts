import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';
import { readSkill, skillFiles, skillRoot } from '../helpers/skill-files.js';

/**
 * The installed skill is the `skills/sureq` folder copied on its own, so a link out of it must be absolute.
 * A link to this repository uses the form user-docs already uses: `blob/main/<file>` or `tree/main/<folder>`.
 */
const REPO_URL = /^https:\/\/github\.com\/sureq-js\/sureq\/(blob|tree)\/main\/([^#]+)(?:#(.*))?$/;

/** Markdown text with fenced code blocks removed, so code is not read as links. */
const prose = (text: string): string => text.replace(/^```[\s\S]*?^```/gm, '');

/** Every link target in a skill file. */
const targets = (file: string): string[] =>
  [...prose(readSkill(file)).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1] ?? '').filter((target) => target !== '');

const isUrl = (target: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');

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

interface Link {
  file: string;
  target: string;
  resolved: string;
  anchor: string | undefined;
  /** `file` or `folder` for a repository URL (blob or tree); undefined for a relative link. */
  kind?: 'file' | 'folder';
}

/** Relative links, resolved against the skill file. */
const relativeLinks: Link[] = skillFiles.flatMap((file) =>
  targets(file)
    .filter((target) => !isUrl(target))
    .map((target) => {
      const [path = '', anchor] = target.split('#');
      const source = join(skillRoot, file);
      const resolved = path === '' ? source : join(dirname(source), decodeURIComponent(path));
      return { file, target, resolved, anchor };
    }),
);

/** Links to this repository on GitHub, mapped back to the repository file; other URLs are external and skipped. */
const repoLinks: Link[] = skillFiles.flatMap((file) =>
  targets(file).flatMap((target) => {
    const m = REPO_URL.exec(target);
    if (!m) return [];
    const link: Link = { file, target, resolved: join(repoRoot, decodeURIComponent(m[2] ?? '')), anchor: m[3], kind: m[1] === 'blob' ? 'file' : 'folder' };
    return [link];
  }),
);

const allLinks = [...relativeLinks, ...repoLinks];

describe('skill: links', () => {
  it('skill: the skill has relative and repository links to check', () => {
    expect(relativeLinks.length).toBeGreaterThan(0);
    expect(repoLinks.length).toBeGreaterThan(0);
  });

  it('skill: every relative link stays inside the skill folder, so it still resolves once installed', () => {
    const outside = relativeLinks
      .filter((l) => l.resolved !== skillRoot && !l.resolved.startsWith(skillRoot + sep))
      .map((l) => `${l.file}: ${l.target} (use https://github.com/sureq-js/sureq/blob/main/<path>)`);
    expect(outside).toEqual([]);
  });

  it('skill: every link to this repository uses the main branch form', () => {
    const odd = skillFiles.flatMap((file) =>
      targets(file)
        .filter((t) => /^https?:\/\/github\.com\/sureq-js\/sureq\//i.test(t) && !REPO_URL.test(t))
        .map((t) => `${file}: ${t}`),
    );
    expect(odd).toEqual([]);
  });

  it('skill: every link points to an existing file or folder in the repository', () => {
    const broken = allLinks
      .filter((l) => !existsSync(l.resolved))
      .map((l) => `${l.file}: ${l.target} (${relative(repoRoot, l.resolved)})`);
    expect(broken).toEqual([]);
  });

  it('skill: a blob URL names a file and a tree URL names a folder', () => {
    const wrong = repoLinks
      .filter((l) => existsSync(l.resolved))
      .filter((l) => statSync(l.resolved).isFile() !== (l.kind === 'file'))
      .map((l) => `${l.file}: ${l.target}`);
    expect(wrong).toEqual([]);
  });

  it('skill: every anchor a link names exists as a heading in its target', () => {
    const broken = allLinks
      .filter((l) => l.anchor !== undefined && l.anchor !== '')
      .filter((l) => existsSync(l.resolved) && statSync(l.resolved).isFile())
      .filter((l) => !anchors(l.resolved).has(decodeURIComponent(l.anchor ?? '').toLowerCase()))
      .map((l) => `${l.file}: ${l.target}`);
    expect(broken).toEqual([]);
  });
});
