import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logEvent,
  LOG_LEVELS,
  type LogEvent,
  type Logger,
} from '../../src/logger/logger.js';
import type { SerializedError } from '../../src/serialize/error.js';

const spyLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) satisfies Logger;
const EVENTS = Object.keys(LOG_LEVELS) as LogEvent[];
const fieldsOf = (l: ReturnType<typeof spyLogger>) =>
  Object.values(l).flatMap((m) => m.mock.calls.map((c) => c[1] as Record<string, unknown>));

afterEach(() => vi.restoreAllMocks());

describe('logger (events)', () => {
  it('logger: the only event SureQ logs is sureq error, at error level', () => {
    expect(LOG_LEVELS).toEqual({ 'sureq error': 'error' });
    const l = spyLogger();
    logEvent(l, 'sureq error', { queue: 'q' });
    for (const level of ['debug', 'info', 'warn'] as const) expect(l[level]).not.toHaveBeenCalled();
    expect(l.error).toHaveBeenCalledOnce();
    expect(l.error.mock.calls[0]?.[0]).toBe('sureq error');
  });

  it('logger: job data never appears in any log call across add, run, retry, fail, complete', () => {
    for (const e of EVENTS) {
      const l = spyLogger();
      logEvent(l, e, { queue: 'q', jobId: 'j', data: 'SECRET-12345', result: 'SECRET-12345', meta: { k: 'SECRET-12345' } });
      expect(JSON.stringify(Object.values(l).map((m) => m.mock.calls))).not.toContain('SECRET-12345');
    }
  });

  it('logger: error props and cause payloads never appear', () => {
    const error: SerializedError = {
      v: 1, name: 'E', message: 'm', props: { body: 'SECRET-12345' }, cause: { v: 1, name: 'C', message: 'SECRET-CAUSE' },
    };
    const l = spyLogger();
    logEvent(l, 'sureq error', { queue: 'q', error });
    const [fields] = fieldsOf(l);
    expect(fields).toMatchObject({ errorName: 'E', errorMessage: 'm' });
    const text = JSON.stringify(l.error.mock.calls);
    expect(text).not.toContain('SECRET-12345');
    expect(text).not.toContain('SECRET-CAUSE');
  });

  it('logger: fields are flat and strings are cut at 1024 chars', () => {
    const l = spyLogger();
    logEvent(l, 'sureq error', { queue: 'q'.repeat(5000), jobName: {}, attempt: 2 });
    const f = fieldsOf(l)[0]!;
    expect((f['queue'] as string).length).toBe(1024);
    expect(f).not.toHaveProperty('jobName');
    expect(f['attempt']).toBe(2);
  });

  it('logger: an error line carries the stack', () => {
    const error: SerializedError = { v: 1, name: 'E', message: 'm', stack: 'S' };
    const l = spyLogger();
    logEvent(l, 'sureq error', { queue: 'q', error });
    expect(fieldsOf(l)[0]?.['stack']).toBe('S');
  });

  it('logger: error event logs source, operation and ids', () => {
    const l = spyLogger();
    const error: SerializedError = { v: 1, name: 'StoreError', message: 'down', code: 'STORE_ERROR' };
    logEvent(l, 'sureq error', { source: 'store', operation: 'claim', queue: 'q', namespace: 'default', jobId: 'j', workerId: 'w', error });
    expect(fieldsOf(l)[0]).toEqual({
      source: 'store', operation: 'claim', queue: 'q', namespace: 'default', jobId: 'j', workerId: 'w',
      errorName: 'StoreError', errorCode: 'STORE_ERROR', errorMessage: 'down',
    });
  });

  it('logger: logEvent never throws', () => {
    const throwing = { get queue(): string { throw new TypeError('x'); } };
    expect(() => logEvent(spyLogger(), 'sureq error', throwing)).not.toThrow();
  });
});
