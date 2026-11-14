import { describe, expect, it } from 'vitest';
import { CtxFailSignal, createContext } from '../../src/worker/context.js';
import { InvalidOptionError, UnrecoverableError } from '../../src/errors/catalog.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import type { Job } from '../../src/job/job.js';

const job = { attempt: 1, maxAttempts: 3 } as Job;
const ctx = () => createContext(job, 'w', new AbortController().signal, 1, async () => {});
const swallow = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('ctx.fail', () => {
  it('unrecoverable: ctx.fail outcome stands when handler swallows the throw', () => {
    const c = ctx();
    const err = new TypeError('stop');
    expect(swallow(() => c.fail(err, { retry: false }))).toBeInstanceOf(CtxFailSignal);
    expect(c.getFailRecord()).toEqual({ err, retry: false });
  });

  it('unrecoverable: second ctx.fail call is ignored', () => {
    const c = ctx();
    const a = new TypeError('a');
    swallow(() => c.fail(a, { retry: false }));
    swallow(() => c.fail(new TypeError('b'), { retry: true }));
    expect(c.getFailRecord()).toEqual({ err: a, retry: false });
  });

  it('unrecoverable: fail without options records only the error', () => {
    const c = ctx();
    const err = new TypeError('x');
    expect(swallow(() => c.fail(err))).toBeInstanceOf(CtxFailSignal);
    const rec = c.getFailRecord()!;
    expect(rec).toEqual({ err });
    expect('retry' in rec).toBe(false);
  });

  it('unrecoverable: non-boolean retry throws InvalidOptionError and records nothing', () => {
    const c = ctx();
    const e = swallow(() => c.fail(new TypeError('x'), { retry: 'no' as never }));
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect((e as InvalidOptionError).issues[0]).toMatchObject({ path: 'retry', code: 'invalid_type' });
    expect(c.getFailRecord()).toBeUndefined();
  });

  it('unrecoverable: worker stores the ctx.fail error, even when the handler swallows the throw', async () => {
    const store = new MemoryStore();
    const q = new Queue('cf', { store, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const w = q.process((_job, c) => {
      try {
        c.fail(new TypeError('orig'), { retry: false });
      } catch {
        // swallowed on purpose
      }
      return 'value';
    });
    const failed = new Promise<{ reason: string }>((r) => w.once('failed', r as never));
    const { job } = await q.add(1, { maxAttempts: 3 });
    expect((await failed).reason).toBe('unrecoverable');
    const rec = (await stored(store, q.internals.scope, job.id))!;
    expect(rec).toMatchObject({ state: 'failed', error: { name: 'TypeError', message: 'orig' } });
    await q.close();
  });

  it('unrecoverable: an UnrecoverableError in the cause chain is reported as unrecoverable', async () => {
    const store = new MemoryStore();
    const q = new Queue('cf', { store, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const w = q.process(() => {
      throw new TypeError('outer', { cause: new UnrecoverableError('inner') });
    });
    const failed = new Promise<{ reason: string }>((r) => w.once('failed', r as never));
    await q.add(1);
    expect((await failed).reason).toBe('unrecoverable');
    await q.close();
  });

  it('unrecoverable: ctx.fail records a non-Error value as given', () => {
    const c = ctx();
    swallow(() => c.fail('a string', { retry: false }));
    expect(c.getFailRecord()).toEqual({ err: 'a string', retry: false });
  });
});
