import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { consoleLogger } from '../../src/logger/logger.js';

// consoleLogger validates its options like every other SureQ options object. Before, an unknown level
// (a typo such as 'warning') was accepted and turned on debug logging.
describe('consoleLogger options (regression)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['loud', 'warning', 'WARN', '', 3, null])('regression: level %o is an InvalidOptionError naming level', (level) => {
    const err: unknown = (() => { try { consoleLogger({ level: level as never }); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(InvalidOptionError);
    expect((err as InvalidOptionError).issues.map((i) => i.path)).toEqual(['level']);
  });

  it('regression: an unknown option is an InvalidOptionError', () => {
    expect(() => consoleLogger({ levle: 'debug' } as never)).toThrow(InvalidOptionError);
  });

  it('regression: every valid level still works, and the default is warn', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const level of ['debug', 'info', 'warn', 'error', 'silent'] as const) expect(() => consoleLogger({ level })).not.toThrow();
    consoleLogger({ level: 'debug' }).debug('d');
    consoleLogger().debug('hidden');
    consoleLogger().warn('w');
    consoleLogger({}).warn('w2');
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
