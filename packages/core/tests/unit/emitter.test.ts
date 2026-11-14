import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../../src/events/emitter.js';
import type { ErrorEvent, QueueEvents } from '../../src/events/types.js';
import { ListenerError, StoreError } from '../../src/errors/catalog.js';
import type { Logger } from '../../src/logger/logger.js';

const spyLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) satisfies Logger;
const setup = () => {
  const logger = spyLogger();
  return { logger, em: new TypedEmitter<QueueEvents>({ queue: 'q', logger }) };
};
const tick = () => new Promise((r) => setImmediate(r));

describe('events (emitter)', () => {
  it('events: off, once and unsubscribe function work', () => {
    const { em } = setup();
    const once = vi.fn();
    em.once('drained', once);
    em.emit('drained', { queue: 'q' });
    em.emit('drained', { queue: 'q' });
    expect(once).toHaveBeenCalledOnce();

    const sub = vi.fn();
    const unsubscribe = em.on('drained', sub);
    em.emit('drained', { queue: 'q' });
    unsubscribe();
    em.emit('drained', { queue: 'q' });
    expect(sub).toHaveBeenCalledOnce();

    const twice = vi.fn();
    em.on('drained', twice);
    em.on('drained', twice);
    em.emit('drained', { queue: 'q' });
    expect(twice).toHaveBeenCalledTimes(2);
    em.off('drained', twice);
    em.emit('drained', { queue: 'q' });
    expect(twice).toHaveBeenCalledTimes(3);
  });

  it('events: listener added or removed during emit follows the rules', () => {
    const { em } = setup();
    const order: string[] = [];
    const b = vi.fn(() => {
      order.push('b');
    });
    const c = vi.fn(() => {
      order.push('c');
    });
    const a = vi.fn(() => {
      order.push('a');
      em.off('drained', a);
      em.off('drained', c);
      em.on('drained', b);
    });
    em.on('drained', a);
    em.on('drained', c);
    em.emit('drained', { queue: 'q' });
    expect(order).toEqual(['a', 'c']); // c still runs this pass; b not yet
    em.emit('drained', { queue: 'q' });
    expect(order).toEqual(['a', 'c', 'b']);
  });

  it('events: throwing listener becomes ListenerError and other listeners still run', () => {
    const { em } = setup();
    const ok = vi.fn();
    const onError = vi.fn<(e: ErrorEvent) => void>();
    em.on('added', () => {
      throw new TypeError('boom');
    });
    em.on('added', ok);
    em.on('error', onError);
    expect(em.emit('added', { job: { id: 'j' } })).toBeUndefined();
    expect(ok).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    const e = onError.mock.calls[0]![0];
    expect(e.source).toBe('listener');
    expect(e.error).toBeInstanceOf(ListenerError);
    expect(e.error.code).toBe('LISTENER_ERROR');
    expect((e.error as ListenerError).event).toBe('added');
    expect(e.error.details).toMatchObject({ event: 'added' });
    expect(e.context).toEqual({ queue: 'q', event: 'added' });
  });

  it('events: throwing listener is contained and reported as error', () => {
    const { em } = setup();
    const next = vi.fn();
    const onError = vi.fn();
    em.on('completed', () => {
      throw new TypeError('x');
    });
    em.on('completed', next);
    em.on('error', onError);
    em.emit('completed', { job: {}, result: 1, durationMs: 3 });
    expect(next).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].error).toBeInstanceOf(ListenerError);
  });

  it('events: async rejecting listener is contained', async () => {
    const { em } = setup();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const cause = new TypeError('x');
      const onError = vi.fn<(e: ErrorEvent) => void>();
      em.on('error', onError);
      em.on('drained', async () => {
        throw cause;
      });
      em.emit('drained', { queue: 'q' });
      await tick();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]![0].error.cause).toBe(cause);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('events: error without listener does not throw', () => {
    const { em, logger } = setup();
    expect(() =>
      em.emit('error', { error: new StoreError('down', { operation: 'claim', retryable: true, outcomeUnknown: false }), source: 'store', context: { queue: 'q' } }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]![0]).toBe('sureq error');
    expect(logger.error.mock.calls[0]![1]).toMatchObject({ source: 'store', queue: 'q' });
    em.on('added', () => {
      throw new TypeError('y');
    });
    expect(() => em.emit('added', { job: {} })).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('events: throwing error listener does not recurse', () => {
    const { em, logger } = setup();
    const bad = vi.fn(() => {
      throw new TypeError('in error listener');
    });
    em.on('error', bad);
    em.on('drained', () => {
      throw new TypeError('first');
    });
    em.emit('drained', { queue: 'q' });
    expect(bad).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('events: once listener that throws is removed anyway', () => {
    const { em } = setup();
    const fn = vi.fn(() => {
      throw new TypeError('x');
    });
    em.on('error', () => {});
    em.once('drained', fn);
    em.emit('drained', { queue: 'q' });
    em.emit('drained', { queue: 'q' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('events: unknown event name is accepted and never fires', () => {
    const { em } = setup();
    const fn = vi.fn();
    // @ts-expect-error: not a queue event
    expect(() => em.on('future', fn)).not.toThrow();
    em.emit('drained', { queue: 'q' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('events: close removes all listeners', () => {
    const { em } = setup();
    const a = vi.fn();
    const err = vi.fn();
    em.on('drained', a);
    em.on('error', err);
    em.removeAll();
    em.emit('drained', { queue: 'q' });
    em.emit('error', { error: new ListenerError({ event: 'x', cause: 1 }), source: 'internal', context: { queue: 'q' } });
    expect(a).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  // The store-error spec names for the same rules.
  const storeError = () => new StoreError('db down', { operation: 'claim', retryable: true, outcomeUnknown: false });

  it('storeerr: throwing sync listener is contained and other listeners still run', () => {
    const { em } = setup();
    const ok = vi.fn();
    em.on('error', () => {});
    em.on('added', () => {
      throw new TypeError('x');
    });
    em.on('added', ok);
    em.emit('added', { job: {} });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('storeerr: async rejecting listener is contained', async () => {
    const { em } = setup();
    const onError = vi.fn();
    em.on('error', onError);
    em.on('added', () => Promise.reject(new TypeError('x')));
    em.emit('added', { job: {} });
    await tick();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('storeerr: throwing error listener does not recurse', () => {
    const { em, logger } = setup();
    const bad = vi.fn(() => {
      throw new TypeError('x');
    });
    em.on('error', bad);
    em.reportError({ error: storeError(), source: 'store', context: { queue: 'q', operation: 'claim' } });
    expect(bad).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('storeerr: error event without listener logs and does not throw', () => {
    const { em, logger } = setup();
    expect(() => em.reportError({ error: storeError(), source: 'store', context: { queue: 'q', operation: 'claim' } })).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('sureq error', expect.objectContaining({ source: 'store', operation: 'claim', queue: 'q' }));
  });

  it('storeerr: error event with listener receives source, context and typed error', () => {
    const { em } = setup();
    const onError = vi.fn<(e: ErrorEvent) => void>();
    em.on('error', onError);
    const ev: ErrorEvent = { error: storeError(), source: 'store', context: { queue: 'q', operation: 'claim', jobId: 'j' } };
    em.reportError(ev);
    expect(onError).toHaveBeenCalledWith(ev);
    expect(onError.mock.calls[0]![0].error).toBeInstanceOf(StoreError);
  });
});
