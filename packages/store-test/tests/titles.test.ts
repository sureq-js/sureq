import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '../src/groups');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const source = (f: string) => readFileSync(join(dir, f), 'utf8');
const literals = (text: string) => [...text.matchAll(/\bt\.(?:test|race)\(\s*(['"])((?:(?!\1).)+)\1/g)].map((m) => m[2]!);
const planned: string[] = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/titles.json'), 'utf8'));

describe('titles', () => {
  it('suite: every planned conformance title exists in a group file', () => {
    const registered = new Set(files.flatMap((f) => literals(source(f))));
    expect(planned.filter((t) => !registered.has(t))).toEqual([]);
    expect(planned).toHaveLength(258);
  });

  it('suite: planned counts per group match', () => {
    const counts: Record<string, number> = {};
    for (const f of files) {
      for (const title of literals(source(f))) {
        const group = title.slice(0, title.indexOf(': '));
        counts[group] = (counts[group] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({
      contract: 49, capabilities: 9, claim: 26, lease: 12, 'lease-config': 2, fencing: 14, progress: 5, sweep: 14, poison: 5, release: 5, batch: 9,
      cancel: 8, gpause: 6, clock: 9, dedup: 13, singleton: 10, idem: 2, merge: 4, meta: 8, history: 12, dlq: 13, stress: 2, metrics: 2, age: 4, stats: 2,
      'schedule-store': 5, 'schedule-fire': 13, workers: 6, admin: 13, retention: 13,
    });
  });
});
