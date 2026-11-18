import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { PRODUCER_KEYS, batchWorkerOptionsSchema, queueSchema, resolveQueueOptions, workerOptionsSchema } from '../../src/queue/options.js';
import { NESTED, literalMismatches, parseTables, type Row } from '../helpers/doc-tables.js';
import { repoRoot } from '../helpers/dev-docs.js';

/**
 * The option tables of the user docs against the code: every option the code takes is documented, every documented
 * option exists, and every default written as a literal (`'25s'`, `1000`, `true`) is the code's default. Defaults
 * written as prose ("none", "the queue's") are not checked.
 */

const REFERENCE = join(repoRoot, 'user-docs/03-reference');
const PAGES = ['01-queue.md', '04-worker-options.md', '05-batch-worker.md', '09-producer.md'];
const all = PAGES.flatMap((page) => parseTables(page, REFERENCE));
const on = (page: string, nested = false) => all.filter((r) => r.file === page && (r.section in NESTED) === nested);
const names = (rs: Row[]) => rs.map((r) => r.name).sort();
const fields = (schema: { fields: object }) => Object.keys(schema.fields);
/** Test seams, never documented. */
const INTERNAL = new Set(['random']);
const options = (keys: Iterable<string>) => [...keys].filter((k) => !INTERNAL.has(k)).sort();

describe('docs: option tables match the code', () => {
  it('docs: the option tables were found', () => {
    for (const page of PAGES) expect(all.filter((r) => r.file === page).length, page).toBeGreaterThan(3);
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
    const { wrong, checked } = literalMismatches(all, (r) => r.file);
    expect(wrong).toEqual([]);
    // a table format the parser no longer reads would otherwise pass with nothing compared
    expect(checked).toBeGreaterThanOrEqual(60);
  });
});
