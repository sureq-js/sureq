import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devDocsRoot, hasDevDocs } from '../helpers/dev-docs.js';

const loadDocs = () => {
  const dir = join(devDocsRoot, 'docs/features');
  return readdirSync(dir)
    .filter((f) => /^[A-Z]\d+-.*\.md$/.test(f))
    .map((f) => ({ file: f, id: f.split('-')[0]!, text: readFileSync(join(dir, f), 'utf8') }));
};
/** The release whose docs this gate checks; it moves with each release. */
const RELEASE = '1.0';
const isCurrentRelease = (text: string) => new RegExp(`\\|\\s*\\*\\*Release\\*\\*\\s*\\|\\s*${RELEASE.replace('.', '\\.')}\\b`).test(text);
/** An open question in a current-release doc must say what it is waiting for. Decided ones say so. */
const TAGGED = /\*\((tuning|waits for|can wait|decided)/;

// The planning docs exist only on development machines; on a clean clone this gate has nothing to read.
describe.runIf(hasDevDocs)('planning docs gate', () => {
  it('docs: no untagged open questions remain in the current release docs', () => {
    const untagged: string[] = [];
    for (const d of loadDocs().filter((x) => isCurrentRelease(x.text))) {
      const at = d.text.indexOf('## 12. Open questions');
      if (at < 0) continue;
      const section = d.text.slice(at).split(/\n## /)[0]!;
      for (const item of section.split('\n').filter((l) => /^\d+\./.test(l))) {
        if (!TAGGED.test(item)) untagged.push(`${d.file}: ${item.slice(0, 80)}`);
      }
    }
    expect(untagged).toEqual([]);
  });

  it('docs: every feature in the current release table has a doc for that release', () => {
    const docs = loadDocs();
    const roadmap = readFileSync(join(devDocsRoot, 'ROADMAP.md'), 'utf8');
    const start = roadmap.indexOf(`\n## ${RELEASE}\n`);
    const section = roadmap.slice(start, roadmap.indexOf('\n## ', start + 1));
    // One row per feature; a sub-feature row (such as how long an id stays taken) shares its parent's doc.
    const rows = [...section.matchAll(/^\| [A-Z]\d+[a-z]? \|.*\]\(docs\/features\/([^)]+\.md)\) \|$/gm)].map((m) => m[1]!);
    const listed = [...new Set(rows)];
    expect([rows.length, listed.length]).toEqual([1, 1]);
    for (const file of listed) {
      const doc = docs.find((d) => d.file === file);
      expect(doc, file).toBeDefined();
      expect(isCurrentRelease(doc!.text), `${file} names the current release`).toBe(true);
    }
    expect(docs.filter((d) => isCurrentRelease(d.text)).map((d) => d.file).sort()).toEqual([...listed].sort());
  });
});
