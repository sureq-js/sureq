import { describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { deadLetters, finishExt, resolveRetention, sweepExt } from '../../src/retention/policy.js';
import type { JobRecord } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { spyStore } from '../helpers/spy-store.js';

type Rec = Pick<JobRecord, 'name' | 'keep' | 'uniqueWhile'>;
const job = (over: Partial<Rec> = {}): Rec => ({ name: null, keep: null, uniqueWhile: 'pending', ...over });
const cfg = (input: unknown, deadLetterOn = true) => {
  const r = resolveRetention(input, deadLetterOn);
  expect(r.issues).toEqual([]);
  return r.value;
};
const H = 3_600_000;
const D = 86_400_000;

/** The issue paths of the InvalidOptionError `fn` throws. */
function paths(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidOptionError);
    return (e as InvalidOptionError).issues.map((i) => i.path);
  }
  throw new Error('expected InvalidOptionError');
}

describe('retention policy', () => {
  it('retention: precedence is job, then name, then queue, then default', () => {
    const set = cfg({ completed: { age: '3h' }, byName: { a: { completed: { age: '2h' } } } });
    expect(finishExt(set, job({ name: 'a', keep: '{"completed":"1h"}' }), 'completed').retention).toEqual({ retainMs: H });
    expect(finishExt(set, job({ name: 'a' }), 'completed').retention).toEqual({ retainMs: 2 * H });
    expect(finishExt(set, job({ name: 'b' }), 'completed').retention).toEqual({ retainMs: 3 * H });
    // the default keeps the newest 1000 completed jobs: a count, so no retainUntil
    expect(finishExt(cfg(undefined), job(), 'completed')).toEqual({});
    expect(cfg(undefined).completed).toEqual({ count: 1000 });
  });

  it('retention: completed and failed policies are independent', () => {
    expect(finishExt(cfg(undefined), job({ keep: '{"completed":0}' }), 'failed')).toEqual({ retention: { retainMs: 14 * D } });
    expect(finishExt(cfg(undefined), job({ keep: '{"completed":0}' }), 'completed')).toEqual({ retention: { retainMs: 30_000 } });
  });

  it('retention: cancelled follows failed unless set', () => {
    expect(finishExt(cfg({ failed: { age: '2d' } }, false), job(), 'cancelled')).toEqual({ retention: { retainMs: 172_800_000 } });
    expect(finishExt(cfg({ failed: { age: '2d' }, cancelled: true }, false), job(), 'cancelled')).toEqual({});
    expect(finishExt(cfg(undefined), job(), 'cancelled')).toEqual({ retention: { retainMs: 14 * D } });
  });

  it('retention: queue failed 0 with deadLetter true throws InvalidOptionError', () => {
    expect(paths(() => new Queue('q', { logger: silent, retention: { failed: 0 } }))).toEqual(['retention.failed']);
    expect(() => new Queue('q', { logger: silent, retention: { failed: 0 }, deadLetter: false })).not.toThrow();
  });

  it('retention: a bare number on a job keep is refused, while a queue retention count still works', async () => {
    const { store, calls } = spyStore(new MemoryStore());
    const q = new Queue('q', { logger: silent, store });
    const before = calls.length;
    const err = await q.add(1, { keep: { completed: 1000 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOptionError);
    expect((err as InvalidOptionError).issues.map((i) => i.path)).toEqual(['keep.completed']);
    expect(calls.slice(before).filter((c) => c.op === 'add')).toEqual([]);
    // the same number on the queue is a count of jobs, and stays valid
    const q2 = new Queue('q2', { logger: silent, retention: { completed: 1000 } });
    await q2.close();
    await q.close();
  });

  it('retention: uniqueWhile retained with keep none throws InvalidOptionError', async () => {
    const { store, calls } = spyStore(new MemoryStore());
    const q = new Queue('q', { logger: silent, store });
    const before = calls.length;
    const err = await q.add(1, { uniqueWhile: 'retained', keep: { completed: 0 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOptionError);
    expect((err as InvalidOptionError).issues.map((i) => i.path)).toEqual(['keep.completed']);
    expect(calls.slice(before).filter((c) => c.op === 'add')).toEqual([]);
    await q.close();
    expect(finishExt(cfg(undefined), job({ uniqueWhile: 'retained' }), 'completed')).toEqual({ retention: { retainMs: 604_800_000 } });
    expect(finishExt(cfg({ byName: { a: { completed: { age: '1d' } } } }), job({ name: 'a', uniqueWhile: 'retained' }), 'completed'))
      .toEqual({ retention: { retainMs: 86_400_000 } });
  });

  it('retention: keep none sends the grace as retainMs, or discard without one', () => {
    const none = job({ keep: '{"completed":false}' });
    expect(finishExt(cfg(undefined), none, 'completed')).toEqual({ retention: { retainMs: 30_000 } });
    expect(finishExt(cfg({ resultGrace: 0 }), none, 'completed')).toEqual({ retention: { discard: true } });
    expect(finishExt(cfg({ completed: { count: 0 } }), job(), 'completed').retention).toEqual({ retainMs: 30_000 });
  });

  it('retention: a failed policy with dead letters on logs one warning naming deadLetter.keep', () => {
    const warn = vi.fn();
    const q = new Queue('q', { logger: { ...silent, warn }, retention: { failed: { age: '1d' } } });
    expect(warn.mock.calls.filter(([m]) => String(m).includes('deadLetter.keep'))).toHaveLength(1);
    void q.close();
  });

  it('retention: keeping failed jobs forever logs no dead-letter warning', () => {
    const warn = vi.fn();
    const q = new Queue('q', { logger: { ...silent, warn }, retention: { completed: true, failed: true, cancelled: true } });
    expect(warn).not.toHaveBeenCalled();
    void q.close();
  });

  it('retention: a job with its own failed keep is never dead-lettered', () => {
    expect(deadLetters(job(), true)).toBe(true);
    expect(deadLetters(job({ keep: '{"failed":"1h"}' }), true)).toBe(false);
    expect(deadLetters(job({ keep: '{"completed":0}' }), true)).toBe(true);
    expect(deadLetters(job(), false)).toBe(false);
    expect(deadLetters(job({ keep: 'not json' }), true)).toBe(true);
  });

  it('retention: invalid options name the offending option', async () => {
    const queue = (retention: unknown) => () => new Queue('q', { logger: silent, retention: retention as never });
    expect(paths(queue({ completed: -1 }))).toEqual(['retention.completed']);
    expect(paths(queue({ completed: { age: 'soon' } }))).toEqual(['retention.completed.age']);
    expect(paths(queue({ byName: { '': {} } }))).toEqual(['retention.byName']);
    expect(paths(queue({ pageSize: 0 }))).toEqual(['retention.pageSize']);
    const unknown = (() => {
      try {
        queue({ intervall: '1m' })();
      } catch (e) {
        return (e as InvalidOptionError).issues[0];
      }
      return undefined;
    })();
    expect(unknown).toMatchObject({ path: 'retention.intervall', code: 'unknown_option', suggestion: 'interval' });
    expect(paths(queue({ byName: { a: { complete: 1 } } }))).toEqual(['retention.byName.a.complete']);
    expect(paths(() => new Queue('q', { logger: silent, deadLetter: { keep: { count: 5 } } }))).toEqual(['deadLetter.keep.count']);
    expect(paths(queue({ completed: 1.5, failed: 'x', cancelled: { count: -1, ages: 1 } }))).toEqual(['retention.cancelled.ages', 'retention.cancelled.count', 'retention.completed', 'retention.failed']);
    expect(paths(queue({ byName: [] }))).toEqual(['retention.byName']);
    expect(paths(queue({ byName: { a: 1 } }))).toEqual(['retention.byName.a']);
    expect(paths(() => new Queue('q', { logger: silent, deadLetter: { keep: 0 } }))).toEqual(['deadLetter.keep']);
    const q = new Queue('q', { logger: silent });
    const keepPaths = async (keep: unknown) => ((await q.add(1, { keep: keep as never }).catch((e: unknown) => e)) as InvalidOptionError).issues.map((i) => i.path);
    expect(await keepPaths({ completed: { count: 5 } })).toEqual(['keep.completed.count']);
    expect(await keepPaths({ completed: {}, failed: [], cancelled: 'soon' })).toEqual(['keep.cancelled', 'keep.completed.age', 'keep.failed']);
    expect(await keepPaths('1h')).toEqual(['keep']);
    await q.close();
  });

  it('retention: resolution reads stored keep text or bytes and treats a broken one as absent', () => {
    const set = cfg({ completed: { count: 5, age: '2h' } });
    expect(finishExt(set, job(), 'completed')).toEqual({ retention: { retainMs: 2 * H } });
    expect(finishExt(set, job({ keep: new TextEncoder().encode('{"completed":"1h"}') }), 'completed')).toEqual({ retention: { retainMs: H } });
    expect(finishExt(set, job({ keep: '{"completed":{"count":1}}' }), 'completed')).toEqual({ retention: { retainMs: 2 * H } });
    expect(finishExt(cfg({ completed: true }), job({ uniqueWhile: 'retained' }), 'completed')).toEqual({});
    expect(resolveRetention({ completed: {} }, true).issues.map((i) => i.path)).toEqual(['retention.completed']);
    expect(sweepExt(cfg({ failed: 0 }, false))).toEqual({ retention: { retainMs: 30_000 } });
    expect(sweepExt(cfg({ failed: true }, false))).toEqual({});
    expect(sweepExt(cfg(undefined))).toEqual({ retention: { retainMs: 14 * D } });
    expect(resolveRetention({ failed: { age: '1d' } }, true).value.warning).toMatch(/deadLetter\.keep/);
    expect(resolveRetention({ failed: { age: '1d' } }, false).value.warning).toBeUndefined();
  });
});
