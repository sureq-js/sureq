import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NESTED, literalMismatches, parseTables, type Row } from '../helpers/doc-tables.js';
import { repoRoot } from '../helpers/dev-docs.js';
import { readSkill, skillRoot } from '../helpers/skill-files.js';

/**
 * The skill's options reference against the user-docs reference and the code: a default the skill shows is the one
 * the reference page shows, and every literal default is the code's default.
 */

const FILE = 'references/options.md';
/** Each section of options.md and the reference page its rows come from. */
const PAGE_OF: Record<string, string> = {
  Queue: '01-queue.md',
  'Worker (process)': '04-worker-options.md',
  'Batch worker (processBatch)': '05-batch-worker.md',
  'Job (add)': '02-job-options.md',
  Producer: '09-producer.md',
};
const REFERENCE = join(repoRoot, 'user-docs/03-reference');

const skillRows = (): Row[] => parseTables(FILE, skillRoot);
const pageOf = (r: Row): string => {
  const page = PAGE_OF[r.section];
  if (page === undefined) throw new Error(`${FILE}: the table under "${r.section}" belongs to no known section`);
  return page;
};
/** The rows of a reference page that document the options of the object itself, not of a nested option. */
const referenceRows = (page: string): Row[] =>
  parseTables(page, REFERENCE).filter((r) => !(page === '01-queue.md' && r.section in NESTED) && r.section !== 'Job defaults');

describe('skill: options reference', () => {
  it('skill: options.md documents every option the reference documents, with the same default', () => {
    const rows = skillRows();
    const wrong: string[] = [];
    let matched = 0;
    for (const r of rows) {
      const ref = referenceRows(pageOf(r)).find((x) => x.name === r.name);
      if (!ref) continue;
      matched++;
      if (ref.def !== r.def) wrong.push(`${r.section} ${r.name}: options.md says ${r.def}, ${ref.file} says ${ref.def}`);
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
    // every option options.md shows is one the reference documents for the same object
    expect(matched).toBe(rows.length);
  });

  it('skill: every literal default in options.md equals the code\'s default', () => {
    const { wrong, checked } = literalMismatches(skillRows(), pageOf);
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it('skill: options.md has the required tables', () => {
    const headings = readSkill(FILE).split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
    for (const section of Object.keys(PAGE_OF)) expect(headings, section).toContain(section);
    const sections = new Set(skillRows().map((r) => r.section));
    for (const section of Object.keys(PAGE_OF)) expect(sections.has(section), `a table under ${section}`).toBe(true);
  });
});
