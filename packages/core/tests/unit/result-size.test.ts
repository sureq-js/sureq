import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { stored } from '../helpers/store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const queues: Queue[] = [];

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 1000 })));
});

describe('result size limit', () => {
  it('resultsize: invalid maxResultBytes throws InvalidOptionError at construction', () => {
    const store = new MemoryStore();
    for (const maxResultBytes of [0, -1, 1.5, NaN, '1mb', Number.MAX_SAFE_INTEGER + 1]) {
      try {
        new Queue('q', { store, logger: silent, maxResultBytes: maxResultBytes as never });
        expect.unreachable(String(maxResultBytes));
      } catch (e) {
        expect(e, String(maxResultBytes)).toBeInstanceOf(InvalidOptionError);
        expect((e as InvalidOptionError).issues[0]!.path).toBe('maxResultBytes');
      }
    }
    expect(new Queue('q', { store, logger: silent, maxResultBytes: 262_144 }).internals.maxResultBytes).toBe(262_144);
    expect(new Queue('q', { store, logger: silent }).internals.maxResultBytes).toBe(1_048_576);
  });

  /** One job whose handler returns `value` on a queue with `maxResultBytes: limit`. */
  const runOne = async (value: unknown, limit = 100, addOpts: Record<string, unknown> = {}) => {
    const store = new MemoryStore();
    const q = new Queue('rs', { store, logger: silent, maxResultBytes: limit });
    queues.push(q);
    const complete = vi.spyOn(store, 'complete');
    let calls = 0;
    const w = q.process(() => (calls++, value));
    const retrying = vi.fn();
    w.on('retrying', retrying);
    const ended = new Promise<{ kind: 'completed' | 'failed'; payload: Record<string, unknown> }>((r) => {
      w.once('completed', (p) => r({ kind: 'completed', payload: p as never }));
      w.once('failed', (p) => r({ kind: 'failed', payload: p as never }));
    });
    const { job } = await q.add('data', addOpts);
    const end = await ended;
    const rec = (await stored(store, q.internals.scope, job.id))!;
    return { q, w, end, rec, complete, retrying, calls: () => calls };
  };

  it('resultsize: result at the limit completes', async () => {
    const { end } = await runOne('a'.repeat(98));
    expect(end.kind).toBe('completed');
  });

  it('resultsize: result over the limit fails the attempt with ResultTooLargeError', async () => {
    const { end, rec } = await runOne('a'.repeat(99));
    expect(end.kind).toBe('failed');
    expect(rec.state).toBe('failed');
    expect(rec.error).toMatchObject({ name: 'ResultTooLargeError', code: 'RESULT_TOO_LARGE' });
  });

  it('resultsize: complete is never called with an oversized result', async () => {
    const { complete } = await runOne('a'.repeat(500));
    expect(complete).not.toHaveBeenCalled();
  });

  it('resultsize: oversized result is not retried even with attempts left', async () => {
    const { rec, retrying, calls } = await runOne('a'.repeat(500), 100, { maxAttempts: 3 });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls()).toBe(1);
    expect(retrying).not.toHaveBeenCalled();
    expect(rec).toMatchObject({ state: 'failed', attempt: 1 });
  });

  it('resultsize: failed job error carries size and limit, not the value', async () => {
    const { rec } = await runOne('SENTINEL-' + 'z'.repeat(200));
    const err = rec.error!;
    expect(err.message).toContain('211');
    expect(err.message).toContain('100');
    expect(JSON.stringify(err)).not.toContain('SENTINEL');
    expect(err.props).toMatchObject({ size: 211, limit: 100 });
  });

  it('resultsize: undefined result is within any limit', async () => {
    expect((await runOne(undefined, 1)).end.kind).toBe('completed');
  });

  it('resultsize: size measured in utf-8 bytes of serialized form', async () => {
    expect((await runOne('é'.repeat(50))).end.kind).toBe('failed'); // 2 + 100 bytes
    expect((await runOne('a'.repeat(50))).end.kind).toBe('completed'); // 52 bytes
  });

  it('resultsize: failed job stores the ResultTooLargeError (name, code, size, limit) in failedReason and emits failed with reason unrecoverable, never retrying', async () => {
    const { end, rec, retrying } = await runOne('a'.repeat(500), 100, { maxAttempts: 5 });
    expect(end.payload).toMatchObject({ reason: 'unrecoverable', error: { name: 'ResultTooLargeError', code: 'RESULT_TOO_LARGE' } });
    expect(rec.error).toMatchObject({ name: 'ResultTooLargeError', props: { size: 502, limit: 100 } });
    expect(retrying).not.toHaveBeenCalled();
  });

  it('result: unserializable result fails the job as unrecoverable with SerializationError; handler runs once and no retrying event fires', async () => {
    const cyc: Record<string, unknown> = {};
    cyc['a'] = cyc;
    for (const bad of [cyc, 10n, () => 1]) {
      const { end, rec, retrying, calls } = await runOne(bad, 1_048_576, { maxAttempts: 3 });
      expect(end.kind).toBe('failed');
      expect(end.payload['reason']).toBe('unrecoverable');
      expect(rec.error!.name).toBe('SerializationError');
      expect(calls()).toBe(1);
      expect(retrying).not.toHaveBeenCalled();
    }
  });

  it('result: unserializable result fails the job without retry', async () => {
    const store = new MemoryStore();
    const q = new Queue('rs', { store, logger: silent });
    queues.push(q);
    const w = q.process((job) => (job.data === 'bad' ? { n: 1n } : 'fine'));
    const results: string[] = [];
    const both = new Promise<void>((r) => {
      w.on('failed', () => void (results.push('failed'), results.length === 2 && r()));
      w.on('completed', () => void (results.push('completed'), results.length === 2 && r()));
    });
    await q.add('bad', { maxAttempts: 3 });
    await q.add('good');
    await both;
    expect(results.sort()).toEqual(['completed', 'failed']);
  });

  it('process: unserializable or oversized result fails the job once, with no retrying event', async () => {
    for (const value of [{ n: 1n }, 'x'.repeat(2 * 1_048_576)]) {
      const { end, retrying, calls } = await runOne(value, 1_048_576, { maxAttempts: 3 });
      expect(end.kind).toBe('failed');
      expect(calls()).toBe(1);
      expect(retrying).not.toHaveBeenCalled();
    }
  });

  it('concurrency: slot is freed when the result is too large', async () => {
    const store = new MemoryStore();
    const q = new Queue('rs', { store, logger: silent, maxResultBytes: 10 });
    queues.push(q);
    const w = q.process((job) => (job.data === 'big' ? 'x'.repeat(100) : 'ok'), { concurrency: 1 });
    const done = new Promise<void>((r) => w.on('completed', () => r()));
    await q.add('big');
    await q.add('small');
    await done;
    await new Promise((r) => setTimeout(r, 0));
    expect(w.inFlight).toBe(0);
  });
});
