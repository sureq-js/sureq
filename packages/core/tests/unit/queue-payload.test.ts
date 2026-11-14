import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError, PayloadTooLargeError, SerializationError } from '../../src/errors/catalog.js';
import { addVia } from '../helpers/add-via.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const queue = (opts: Record<string, unknown> = {}) => new Queue('q', { logger: silent, ...opts });
const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => expect.unreachable('resolved'), (e: unknown) => e);

describe('payload size limit', () => {
  it('payload: payload at the limit is accepted', async () => {
    const q = queue({ maxPayloadBytes: 10 });
    await expect(q.internals.prepare('12345678', {})).resolves.toMatchObject({ data: '"12345678"' });
    await expect(q.internals.prepare('123456789', {})).rejects.toThrow(PayloadTooLargeError);
  });

  it('payload: payload one byte over the limit throws PayloadTooLargeError', async () => {
    const e = await caught(queue({ maxPayloadBytes: 10 }).internals.prepare('123456789', {}));
    expect(e).toBeInstanceOf(PayloadTooLargeError);
    expect(e).toMatchObject({ size: 11, limit: 10 });
  });

  it('payload: error carries size, limit and queue', async () => {
    const e = (await caught(queue({ maxPayloadBytes: 10 }).internals.prepare('123456789', {}))) as PayloadTooLargeError;
    expect(e).toMatchObject({ size: 11, limit: 10, queue: 'q' });
    expect(e.details).toEqual({ size: 11, limit: 10, queue: 'q', field: 'data' });
  });

  it('payload: rejection happens before any store call', async () => {
    const store = new MemoryStore();
    const add = vi.spyOn(store, 'add');
    const q = queue({ store, maxPayloadBytes: 10 });
    await expect(addVia(q, '123456789')).rejects.toThrow(PayloadTooLargeError);
    expect(add).not.toHaveBeenCalled();
  });

  it('payload: default limit applies when option omitted', async () => {
    const q = queue();
    expect(q.internals.maxPayloadBytes).toBe(1_048_576);
    await expect(q.internals.prepare('x'.repeat(1_048_574), {})).resolves.toBeDefined();
    await expect(q.internals.prepare('x'.repeat(1_048_575), {})).rejects.toThrow(PayloadTooLargeError);
  });

  it('payload: invalid maxPayloadBytes throws InvalidOptionError at construction', () => {
    for (const maxPayloadBytes of [0, -1, 1.5, NaN, '1mb', Number.MAX_SAFE_INTEGER + 1]) {
      expect.soft(() => queue({ maxPayloadBytes }), String(maxPayloadBytes)).toThrow(InvalidOptionError);
    }
  });

  it('payload: error message does not contain the payload', async () => {
    const e = (await caught(queue({ maxPayloadBytes: 5 }).internals.prepare('SECRET-TOKEN-xyz', {}))) as PayloadTooLargeError;
    expect(e).toBeInstanceOf(PayloadTooLargeError);
    expect(e.message).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(e.toJSON())).not.toContain('SECRET-TOKEN');
  });

  it('payload: size check runs after option validation and serialization, before the store call and so before duplicate handling', async () => {
    const store = new MemoryStore();
    const add = vi.spyOn(store, 'add');
    const q = queue({ store, maxPayloadBytes: 5 });
    await expect(addVia(q, 'x'.repeat(100), { maxAttempts: 0 })).rejects.toThrow(InvalidOptionError);
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    await expect(addVia(q, cyc)).rejects.toThrow(SerializationError);
    expect(add).not.toHaveBeenCalled();
  });
});
