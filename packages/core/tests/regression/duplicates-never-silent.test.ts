import { describe, expect, it } from 'vitest';
import { DuplicateJobError } from '../../src/errors/catalog.js';
import type { Job } from '../../src/job/job.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { claimJobs } from '../helpers/store.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const merge = (e: Readonly<Job<Record<string, number>>>, i: Readonly<Record<string, number>>) => ({ ...e.data, ...i });

function setup() {
  const store = new MemoryStore();
  const q = new Queue<Record<string, number>>('q', { store, logger: silent });
  const events: Array<{ action: string; by: string }> = [];
  q.on('duplicate', (e) => void events.push(e));
  return { store, q, events, scope: q.internals.scope };
}

describe('duplicates are never silent', () => {
  it('regression: every duplicate path returns added false with an action and fires duplicate', async () => {
    const { store, q, events, scope } = setup();
    await q.add({ a: 1 }, { id: 'act' });
    expect((await claimJobs(store, scope, { limit: 1 }))[0]!.id).toBe('act');
    await q.add({ a: 1 }, { id: 'w', singletonKey: 'k' });
    const results = [
      await q.add({ b: 1 }, { id: 'w' }),
      await q.add({ b: 2 }, { id: 'w', onDuplicate: 'replace' }),
      await q.add({ b: 3 }, { id: 'w', onDuplicate: merge }),
      await q.add({ b: 4 }, { id: 'act' }),
      await q.add({ b: 5 }, { id: 'other', singletonKey: 'k' }),
    ];
    for (const r of results) {
      expect(r.added).toBe(false);
      expect(r.duplicate?.action).toMatch(/^(ignored|replaced|merged)$/);
    }
    expect(events).toHaveLength(results.length);
    await expect(q.add({ c: 1 }, { id: 'w', onDuplicate: 'reject' })).rejects.toThrow(DuplicateJobError);
    expect(events).toHaveLength(results.length + 1);
    expect(events.at(-1)).toMatchObject({ action: 'rejected' });
  });

  it('regression: merge: every merged or ignored add reports its outcome and fires duplicate', async () => {
    const { store, q, events, scope } = setup();
    await q.add({ a: 1 }, { id: 'm' });
    const merged = await q.add({ b: 2 }, { id: 'm', onDuplicate: merge });
    await claimJobs(store, scope);
    const ignored = await q.add({ c: 3 }, { id: 'm', onDuplicate: merge });
    expect([merged.duplicate?.action, ignored.duplicate?.action]).toEqual(['merged', 'ignored']);
    expect(ignored.duplicate?.existingState).toBe('active');
    expect(events.map((e) => e.action)).toEqual(['merged', 'ignored']);
  });

  it('regression: singleton conflicts return added false with an action and fire duplicate', async () => {
    const { q, events } = setup();
    await q.add({ a: 1 }, { singletonKey: 'k' });
    for (const onDuplicate of ['ignore', 'replace', merge] as const) {
      const r = await q.add({ b: 1 }, { singletonKey: 'k', onDuplicate });
      expect(r).toMatchObject({ added: false, duplicate: { action: 'ignored', by: 'singletonKey' } });
    }
    await expect(q.add({ b: 1 }, { singletonKey: 'k', onDuplicate: 'reject' })).rejects.toThrow(DuplicateJobError);
    expect(events.map((e) => `${e.action}/${e.by}`)).toEqual([
      'ignored/singletonKey', 'ignored/singletonKey', 'ignored/singletonKey', 'rejected/singletonKey',
    ]);
  });
});
