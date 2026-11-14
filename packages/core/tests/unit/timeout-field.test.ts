import { describe, expect, it } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { parsePayload } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';

const setup = () => {
  const store = new MemoryStore();
  const queue = new Queue('t', { store, logger: silent });
  const timeoutOf = async (id: string) => (await store.get(queue.internals.scope, id))!.timeout;
  return { queue, timeoutOf };
};

describe('per-add timeout field', () => {
  it('timeout: add stores the per-add timeout and grace on the record', async () => {
    const { queue, timeoutOf } = setup();
    const both = await queue.add(1, { timeout: '2s', timeoutGrace: 100 });
    expect(parsePayload(await timeoutOf(both.job.id))).toEqual({ timeoutMs: 2000, graceMs: 100 });
    const one = await queue.add(1, { timeout: 1000 });
    expect(parsePayload(await timeoutOf(one.job.id))).toEqual({ timeoutMs: 1000 });
    const grace = await queue.add(1, { timeoutGrace: 0 });
    expect(parsePayload(await timeoutOf(grace.job.id))).toEqual({ graceMs: 0 });
    const none = await queue.add(1);
    expect(await timeoutOf(none.job.id)).toBeNull();
    const [bulk] = await queue.addBulk([{ data: 1, opts: { timeout: 5 } }]);
    expect(bulk!.ok && parsePayload(await timeoutOf(bulk!.job.id))).toEqual({ timeoutMs: 5 });
  });

  const invalid: [string, Record<string, unknown>][] = [
    ['timeout', { timeout: 0 }],
    ['timeout', { timeout: 1.5 }],
    ['timeout', { timeout: 'abc' }],
    ['timeoutGrace', { timeoutGrace: -1 }],
  ];

  it.each(invalid)('timeout: invalid %s on add or an addBulk item throws InvalidOptionError at that path (%o)', async (path, opts) => {
    const { queue } = setup();
    const err = await queue.add(1, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOptionError);
    expect((err as InvalidOptionError).issues.map((i) => i.path)).toEqual([path]);
    const [item] = await queue.addBulk([{ data: 1, opts }]);
    expect(item!.ok).toBe(false);
    const bulkErr = (item as { error: unknown }).error;
    expect(bulkErr).toBeInstanceOf(InvalidOptionError);
    expect((bulkErr as InvalidOptionError).issues.map((i) => i.path)).toEqual([path]);
  });
});
