import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import {
  POLL_DEFAULTS, resolveJobOptions, resolveLeases, resolveProducerOptions, resolveQueueOptions, batchWorkerOptionsSchema,
  workerOptionsSchema,
} from '../../src/queue/options.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { parseDuration } from '../../src/util/duration.js';
import { validate } from '../../src/util/validate.js';
import { DEFAULT_TIMEOUT_GRACE_MS } from '../../src/worker/timeout.js';
import { repoRoot } from './dev-docs.js';

/**
 * Reads the option tables of a Markdown page (`| Name | Type | Default | Meaning |`) and checks their literal defaults
 * against the code. Used by the user-docs reference check and by the skill's options check.
 */

/** One table row: the file as given, the heading above the table, the option name and the default cell. */
export type Row = { file: string; section: string; name: string; def: string };

/** The rows of every `| Name | Type | Default | Meaning |` table in `file`, a path relative to `root` (or absolute). */
export function parseTables(file: string, root: string = repoRoot): Row[] {
  const out: Row[] = [];
  let section = '';
  let header: string[] | null = null;
  for (const line of readFileSync(resolve(root, file), 'utf8').split('\n')) {
    const heading = /^#+ (.*)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      header = null;
      continue;
    }
    if (!line.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line.trim().split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (header === null) {
      header = cells;
      continue;
    }
    if (/^[|\-: ]+$/.test(line.trim()) || header[0] !== 'Name' || header[2] !== 'Default') continue;
    out.push({ file, section, name: cells[0]!.replace(/`/g, ''), def: cells[2]! });
  }
  return out;
}

/** The default cell as a value when it is one literal, optionally followed by `ms` or a note in brackets; else undefined. */
export function literal(def: string): { value: unknown } | undefined {
  const m = /^`([^`]+)`(?: ms)?(?: \([^)]*\))?$/.exec(def);
  if (!m) return undefined;
  const text = m[1]!;
  if (/^'[^']*'$/.test(text)) return { value: text.slice(1, -1) };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

const queue = resolveQueueOptions('q', {});
const producer = resolveProducerOptions('p', { store: new MemoryStore() });
const worker = validate('w', {}, workerOptionsSchema);
const batch = validate('b', { batchSize: 2 }, batchWorkerOptionsSchema);
const job = resolveJobOptions({}, {}, 0);
// Defaults the resolvers apply later than option parsing, from the same constants the code reads.
const late = {
  ...POLL_DEFAULTS, leaseDuration: resolveLeases({}, {}, []).leaseMsFor(null), timeoutGrace: DEFAULT_TIMEOUT_GRACE_MS,
  shutdownTimeout: queue.shutdownTimeout, shutdownAbortGrace: queue.shutdownAbortGrace,
};
const { retention } = queue;
/** The code's defaults behind the queue page's nested tables, by the heading their table sits under. */
export const NESTED: Record<string, Record<string, unknown>> = {
  reconnect: queue.reconnect,
  // history is on by default, so the resolved value is its settings, not false
  history: { maxRecordsPerJob: (queue.history as { max: number }).max },
  deadLetter: { warnAbove: queue.deadLetter.warnAbove },
  retention: { interval: retention.intervalMs, pageSize: retention.pageSize, resultGrace: retention.resultGraceMs, retainedAge: retention.retainedAgeMs },
  scheduler: queue.scheduler,
};

/** The code's defaults behind a table on a `user-docs/03-reference` page, given the page and the table's heading. */
export function defaultsFor(page: string, section: string): Record<string, unknown> {
  if (page === '01-queue.md') return NESTED[section] ?? { ...late, ...queue };
  if (page === '09-producer.md') return producer as unknown as Record<string, unknown>;
  if (page === '05-batch-worker.md') return batch as unknown as Record<string, unknown>;
  if (page === '02-job-options.md') return { maxAttempts: job.maxAttempts, priority: job.priority, first: job.first, delay: job.delayMs };
  return { ...late, ...worker };
}

/**
 * Compares every literal default of `rows` with the code's default. `pageOf` names the reference page whose defaults
 * a row is checked against. Returns the mismatches and how many rows had a literal default.
 */
export function literalMismatches(rows: Row[], pageOf: (r: Row) => string): { wrong: string[]; checked: number } {
  const wrong: string[] = [];
  let checked = 0;
  for (const r of rows) {
    const doc = literal(r.def);
    if (!doc) continue;
    checked++;
    const defaults = defaultsFor(pageOf(r), r.section);
    const where = `${r.file} (${r.section}) ${r.name}`;
    if (!(r.name in defaults)) {
      wrong.push(`${where}: documents ${r.def}, but this test does not know where the code keeps that default`);
      continue;
    }
    const code = defaults[r.name];
    const value = typeof code === 'number' && typeof doc.value === 'string' ? parseDuration(doc.value as never, r.name) : doc.value;
    try {
      expect(value).toEqual(code);
    } catch {
      wrong.push(`${where}: the docs say ${r.def}, the code says ${JSON.stringify(code)}`);
    }
  }
  return { wrong, checked };
}
