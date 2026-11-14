import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devDocsRoot, hasDevDocs, repoTestFiles } from '../helpers/dev-docs.js';

/** The built releases whose feature docs are linted; append one per release. */
const RELEASES = ['0.2', '0.3', '1.0'];

/** Spec titles that are checked some other way, each with the reason. */
const EXEMPT: Record<string, string> = {
  'guide: a new engineer builds a passing second adapter from the guide alone': 'a manual check, recorded once',
  'suite: runs under node:test, vitest and jest': 'the three runner smoke projects check it, under that title in the suite tests',
  'runtime: core suite passes on Bun': 'deferred to a later release; the feature doc lists it outside this release',
  'runtime: core suite passes on Deno': 'deferred to a later release; the feature doc lists it outside this release',
  'polling: 10 idle workers for 60 s make no more than (10 × 60 / pollMax × 1.3) claim calls': 'a benchmark, not a test',
};
/** A spec title naming a feature id, section or release must be rewritten in plain words in code. */
const ID_TOKEN = /\b[A-Z]\d{1,2}[a-z]?\b|§|\bR\d/;
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The feature docs linked from the release tables of the roadmap, without repeats. */
const releaseDocs = (): string[] => {
  const roadmap = readFileSync(join(devDocsRoot, 'ROADMAP.md'), 'utf8');
  const linked = RELEASES.flatMap((release) => {
    const start = roadmap.indexOf(`\n## ${release}\n`);
    const section = roadmap.slice(start, roadmap.indexOf('\n## ', start + 1));
    return [...section.matchAll(/\]\((docs\/features\/[^)]+\.md)\)/g)].map((m) => m[1]!);
  });
  return [...new Set(linked)];
};

/** Every `area: text` span in each doc's test-case section; `area` is a prefix some doc starts a bullet with. */
const specTitles = (docs: string[]): Array<{ doc: string; title: string }> => {
  const texts = docs.map((d) => ({ doc: d, text: readFileSync(join(devDocsRoot, d), 'utf8') }));
  const areas = new Set(texts.flatMap(({ text }) => [...text.matchAll(/^\s*- `([a-z][\w-]*): /gm)].map((m) => m[1]!)));
  return texts.flatMap(({ doc, text }) => {
    const start = text.indexOf('\n## 10.');
    if (start < 0) return [];
    const end = text.indexOf('\n## ', start + 1);
    const section = text.slice(start, end < 0 ? undefined : end);
    return section.split('\n').flatMap((line) => {
      // a test that needs a feature of a release not built yet is not required yet
      const from = /\*\(from ([^)]+)\)\*\s*$/.exec(line);
      if (from && !RELEASES.includes(from[1]!)) return [];
      return [...line.matchAll(/`([a-z][\w-]*): ([^`]+)`/g)]
        .filter((m) => areas.has(m[1]!) && !/\.\.\.|…/.test(m[2]!))
        .map((m) => ({ doc, title: collapse(`${m[1]}: ${m[2]}`) }));
    });
  });
};

/** The title literal of every test call (`it`, `test`, a group's `t.test` / `t.race`, `it.each(...)`, `it.runIf(...)`). */
const CALL = /\b(?:it|test|race)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\))?)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const codeTitles = (): Set<string> => {
  const titles = new Set<string>();
  for (const file of repoTestFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(CALL)) {
      if (m[1] === '`' && m[2]!.includes('${')) continue;
      // it.each titles end with their format part: "(%s)" or ": %s"
      const title = m[2]!.replace(/\\(.)/g, '$1').replace(/(\s*\(%[sdifjoO#].*\)|:\s*%[sdifjoO#].*)$/, '');
      titles.add(collapse(title));
    }
  }
  return titles;
};

/** The title rewrites of every built release, a later release winning. */
const rewrites = (): Record<string, string> =>
  Object.assign(
    {},
    ...RELEASES.map((release) => join(devDocsRoot, 'docs/superpowers/plans', release, 'title-rewrites.json'))
      .filter((file) => existsSync(file))
      .map((file) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>),
  );

// The planning docs exist only on development machines; on a clean clone this lint has nothing to read.
describe.runIf(hasDevDocs)('doc test names', () => {
  it('docs: every test named in the current release feature docs exists in the code', () => {
    const docs = releaseDocs();
    expect(docs).toHaveLength(45);
    const renamed = rewrites();
    const code = codeTitles();
    const missing: string[] = [];
    for (const { doc, title } of specTitles(docs)) {
      if (title in EXEMPT) continue;
      const rewrite = renamed[title];
      if (ID_TOKEN.test(title) && rewrite === undefined) missing.push(`${doc}: ${title} (add a rewrite)`);
      else if (!code.has(rewrite ?? title)) missing.push(`${doc}: ${rewrite ?? title}`);
    }
    expect(missing).toEqual([]);
  });
});
