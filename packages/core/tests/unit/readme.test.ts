import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hasDevDocs, repoRoot } from '../helpers/dev-docs.js';

const root = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const readRepo = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

describe('README and CHANGELOG', () => {
  it('readme: getting started snippet equals the tested fixture', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Getting started'));
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    const fixture = read('tests/fixtures/getting-started.ts');
    const snippet = fixture.slice(fixture.indexOf('// --- snippet start') + '// --- snippet start'.length, fixture.indexOf('// --- snippet end'));
    expect(block?.trim()).toBe(snippet.trim());
  });

  it('readme: guarantees follow getting started and list what is and is not promised', () => {
    const readme = read('README.md');
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings[headings.indexOf('Getting started') + 1]).toBe('Guarantees');
    const section = readme.slice(readme.indexOf('## Guarantees'), readme.indexOf('\n## ', readme.indexOf('## Guarantees') + 1));
    for (const g of ['At least once', 'Stored before `add` resolves', 'One owner at a time', 'No stale writes', 'Bounded recovery', 'One clock']) {
      expect(section, g).toContain(`| **${g}** |`);
    }
    expect(section).toContain('Not promised');
    expect(section).toContain('**Exactly-once effects.**');
    expect(section).toContain('**Durability with the built-in store.**');
  });

  it('readme: health probe snippet equals the tested fixture', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Health checks'));
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    const fixture = read('tests/fixtures/health-probe.ts');
    const snippet = fixture.slice(fixture.indexOf('// --- snippet start') + '// --- snippet start'.length, fixture.indexOf('// --- snippet end'));
    expect(block?.trim()).toBe(snippet.trim());
  });

  it('readme: schedule timing sample equals the type-checked fixture', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Schedule timing: cron and every'));
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    const fixture = read('tests/fixtures/schedule-preview.ts');
    const snippet = fixture.slice(fixture.indexOf('// --- snippet start') + '// --- snippet start'.length, fixture.indexOf('// --- snippet end'));
    expect(block?.trim()).toBe(snippet.trim());
  });

  it('readme: schedules sample equals the type-checked fixture', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Schedules\n'));
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    const fixture = read('tests/fixtures/schedules.ts');
    const snippet = fixture.slice(fixture.indexOf('// --- snippet start') + '// --- snippet start'.length, fixture.indexOf('// --- snippet end'));
    expect(block?.trim()).toBe(snippet.trim());
  });

  it('readme: metrics and alerts sample equals the type-checked fixture', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Metrics and alerts'));
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    const fixture = read('tests/fixtures/metrics-alerts.ts');
    const snippet = fixture.slice(fixture.indexOf('// --- snippet start') + '// --- snippet start'.length, fixture.indexOf('// --- snippet end'));
    expect(block?.trim()).toBe(snippet.trim());
  });

  it('readme: producer sample equals the type-checked fixture', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Producer-only processes'));
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    const fixture = read('tests/fixtures/producer.ts');
    const snippet = fixture.slice(fixture.indexOf('// --- snippet start') + '// --- snippet start'.length, fixture.indexOf('// --- snippet end'));
    expect(block?.trim()).toBe(snippet.trim());
  });

  it('readme: getting started fixture runs', async () => {
    const logs: unknown[][] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args));
    try {
      await import('../fixtures/getting-started.js');
    } finally {
      log.mockRestore();
    }
    const lines = logs.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    expect(lines.filter((l) => l.endsWith('failed: unrecoverable'))).toHaveLength(1);
    expect(lines.filter((l) => l.endsWith('sent {"sent":true}'))).toHaveLength(2);
    expect(logs.at(-1)![0]).toMatchObject({ completed: 2, failed: 1, waiting: 0, delayed: 0, active: 0, blocked: 0 });
  }, 15_000);

  it.runIf(hasDevDocs)('readme: retry strategy table matches the backoff doc', () => {
    const e5 = readRepo('docs/features/E5-backoff.md');
    const table = e5.slice(e5.indexOf('| What you write |'));
    const cells = table
      .split('\n')
      .slice(2, 7)
      .map((row) => row.split('|')[1]!.trim());
    expect(cells).toHaveLength(5);
    const readme = read('README.md');
    for (const cell of cells) expect(readme, cell).toContain(cell);
  });

  it('changelog: has an entry for the package version and links no private docs', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    const changelog = readRepo('packages/core/CHANGELOG.md');
    expect(changelog).toContain(`## ${version} `);
    for (const text of [changelog, read('README.md')]) expect(text).not.toMatch(/ROADMAP|FEATURES\.md|(?<![\w-])docs\//);
  });
});
