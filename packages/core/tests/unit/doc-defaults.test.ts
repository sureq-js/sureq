import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import {
  POLL_DEFAULTS, PRODUCER_KEYS, batchWorkerOptionsSchema, queueSchema, resolveLeases, resolveProducerOptions, resolveQueueOptions,
  workerOptionsSchema,
} from '../../src/queue/options.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { parseDuration } from '../../src/util/duration.js';
import { validate } from '../../src/util/validate.js';
import { DEFAULT_TIMEOUT_GRACE_MS } from '../../src/worker/timeout.js';
import { repoRoot } from '../helpers/dev-docs.js';

/**
 * The option tables of the user docs against the code: every option the code takes is documented, every documented
 * option exists, and every default written as a literal (`'25s'`, `1000`, `true`) is the code's default. Defaults
 * written as prose ("none", "the queue's") are not checked.
 */

type Row = { page: string; section: string; name: string; def: string };

/** The rows of every `| Name | Type | Default | Meaning |` table on a reference page, with the heading above each. */
function rows(page: string): Row[] {
  const out: Row[] = [];
  let section = '';
  let header: string[] | null = null;
  for (const line of readFileSync(join(repoRoot, 'user-docs/03-reference', page), 'utf8').split('\n')) {
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
    out.push({ page, section, name: cells[0]!.replace(/`/g, ''), def: cells[2]! });
  }
  return out;
}

/** The default cell as a value when it is one literal, optionally followed by `ms` or a note in brackets; else undefined. */
function literal(def: string): { value: unknown } | undefined {
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
// Defaults the resolvers apply later than option parsing, from the same constants the code reads.
const late = {
  ...POLL_DEFAULTS, leaseDuration: resolveLeases({}, {}, []).leaseMsFor(null), timeoutGrace: DEFAULT_TIMEOUT_GRACE_MS,
  shutdownTimeout: queue.shutdownTimeout, shutdownAbortGrace: queue.shutdownAbortGrace,
};
const { retention } = queue;
/** The code's defaults behind each page's tables; nested option objects by the heading their table sits under. */
const NESTED: Record<string, Record<string, unknown>> = {
  reconnect: queue.reconnect,
  // history is on by default, so the resolved value is its settings, not false
  history: { maxRecordsPerJob: (queue.history as { max: number }).max },
  deadLetter: { warnAbove: queue.deadLetter.warnAbove },
  retention: { interval: retention.intervalMs, pageSize: retention.pageSize, resultGrace: retention.resultGraceMs, retainedAge: retention.retainedAgeMs },
  scheduler: queue.scheduler,
};
const defaultsFor = (r: Row): Record<string, unknown> => {
  if (r.page === '01-queue.md') return NESTED[r.section] ?? { ...late, ...queue };
  if (r.page === '09-producer.md') return producer as unknown as Record<string, unknown>;
  if (r.page === '05-batch-worker.md') return batch as unknown as Record<string, unknown>;
  return { ...late, ...worker };
};

const PAGES = ['01-queue.md', '04-worker-options.md', '05-batch-worker.md', '09-producer.md'];
const all = PAGES.flatMap(rows);
const on = (page: string, nested = false) => all.filter((r) => r.page === page && (r.section in NESTED) === nested);
const names = (rs: Row[]) => rs.map((r) => r.name).sort();
const fields = (schema: { fields: object }) => Object.keys(schema.fields);
/** Test seams, never documented. */
const INTERNAL = new Set(['random']);
const options = (keys: Iterable<string>) => [...keys].filter((k) => !INTERNAL.has(k)).sort();

describe('docs: option tables match the code', () => {
  it('docs: the option tables were found', () => {
    for (const page of PAGES) expect(all.filter((r) => r.page === page).length, page).toBeGreaterThan(3);
  });

  it('docs: queue, producer, worker and batch worker options are each documented once', () => {
    const workerKeys = fields(workerOptionsSchema);
    expect(names(on('01-queue.md'))).toEqual(options(fields(queueSchema)));
    expect(names(on('09-producer.md'))).toEqual(options(PRODUCER_KEYS));
    expect(names(on('04-worker-options.md'))).toEqual(options(workerKeys));
    expect(names(on('05-batch-worker.md'))).toEqual(options(fields(batchWorkerOptionsSchema).filter((k) => !workerKeys.includes(k))));
  });

  it('docs: every documented nested queue option exists', () => {
    const unknown = on('01-queue.md', true).filter((r) => {
      try {
        resolveQueueOptions('q', { [r.section]: { [r.name]: Symbol('probe') } });
        return false;
      } catch (e) {
        if (!(e instanceof InvalidOptionError)) throw e;
        return e.issues.some((i) => i.code === 'unknown_option' && i.path === `${r.section}.${r.name}`);
      }
    });
    expect(unknown.map((r) => `${r.section}.${r.name}`)).toEqual([]);
  });

  it('docs: every literal default is the default in the code', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const r of all) {
      const doc = literal(r.def);
      if (!doc) continue;
      checked++;
      const defaults = defaultsFor(r);
      const where = `${r.page} (${r.section}) ${r.name}`;
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
    expect(wrong).toEqual([]);
    // a table format the parser no longer reads would otherwise pass with nothing compared
    expect(checked).toBeGreaterThanOrEqual(60);
  });
});
