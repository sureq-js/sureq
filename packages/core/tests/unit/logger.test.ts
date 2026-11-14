import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger, createLogger, pinoLogger, type Logger } from '../../src/logger/logger.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';

const spies = () => ({
  debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
  info: vi.spyOn(console, 'info').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
});

afterEach(() => vi.restoreAllMocks());

describe('logger', () => {
  it('logger: default is console at warn level', () => {
    const c = spies();
    const l = createLogger(undefined);
    l.debug('d');
    l.info('i');
    expect(c.debug).not.toHaveBeenCalled();
    expect(c.info).not.toHaveBeenCalled();
    l.warn('w', { a: 1 });
    expect(c.warn).toHaveBeenCalledWith('w', { a: 1 });
    l.error('e');
    expect(c.error).toHaveBeenCalledOnce();
  });

  it('logger: false produces no output', () => {
    const c = spies();
    const l = createLogger(false);
    l.debug('d');
    l.info('i');
    l.warn('w');
    l.error('e');
    for (const s of Object.values(c)) expect(s).not.toHaveBeenCalled();
  });

  it('logger: logger missing a method throws InvalidOptionError', () => {
    expect.assertions(2);
    try {
      createLogger({ debug() {}, info() {}, warn() {} } as never);
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidOptionError);
      expect((e as InvalidOptionError).issues[0]?.path).toBe('logger.error');
    }
  });

  it('logger: pino adapter swaps argument order and needs no pino dependency', () => {
    const p = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    pinoLogger(p).info('m', { a: 1 });
    expect(p.info).toHaveBeenCalledWith({ a: 1 }, 'm');
    pinoLogger(p).warn('n');
    expect(p.warn).toHaveBeenCalledWith({}, 'n');
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual({});
  });

  it('logger: throwing logger does not break queue or workers', () => {
    const boom = vi.fn(() => {
      throw new TypeError('logger down');
    });
    const l = createLogger({ debug: boom, info: boom, warn: boom, error: boom });
    expect(() => l.error('x')).not.toThrow();
    expect(() => l.warn('x')).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it('logger: async logger is not awaited', async () => {
    const rejecting = () => Promise.reject(new TypeError('async down'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const l = createLogger({ debug: rejecting, info: rejecting, warn: rejecting, error: rejecting } as unknown as Logger);
      expect(l.error('x')).toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('logger: a custom logger with extra methods is used as is', () => {
    const custom = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    createLogger(custom).info('hi', { q: 'a' });
    expect(custom.info).toHaveBeenCalledWith('hi', { q: 'a' });
    expect(custom.child).not.toHaveBeenCalled();
  });

  it('logger: console level silent produces no output', () => {
    const c = spies();
    const l = consoleLogger({ level: 'silent' });
    l.error('e');
    l.warn('w');
    for (const s of Object.values(c)) expect(s).not.toHaveBeenCalled();
  });
});
