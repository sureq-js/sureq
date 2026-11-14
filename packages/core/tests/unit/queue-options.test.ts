import { describe, expect, it } from 'vitest';
import { resolveQueueOptions, resolveJobOptions, QUEUE_NAME_RE, NAMESPACE_RE, MIN_PRIORITY, MAX_PRIORITY } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { spyStore } from '../helpers/spy-store.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('queue options', () => {
  it('queue: resolveQueueOptions applies the defaults', () => {
    const r = resolveQueueOptions('q', {});
    expect(r).toMatchObject({
      namespace: 'default', order: 'fifo', maxBulkSize: 1000, maxErrorBytes: 16_384, storeStacks: true,
      maxPayloadBytes: 1_048_576, maxResultBytes: 1_048_576,
    });
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('defaults: maxAttempts, backoff and priority are accepted as defaults', () => {
    const q = new Queue('q', { defaultJobOptions: { maxAttempts: 5, backoff: { type: 'fixed', delay: 1000 }, priority: 2 }, logger: silent });
    expect(q.internals.defaultJobOptions).toEqual({ maxAttempts: 5, backoff: { type: 'fixed', delay: 1000 }, priority: 2 });
  });

  it('defaults: id, name, delay, runAt, first and singletonKey are rejected as defaults', () => {
    for (const k of ['id', 'name', 'delay', 'runAt', 'first', 'singletonKey']) {
      expect.soft(() => new Queue('q', { defaultJobOptions: { [k]: 1 } as never }), k).toThrow(InvalidOptionError);
    }
    try {
      new Queue('q', { defaultJobOptions: { delay: 5000 } as never });
    } catch (e) {
      expect((e as InvalidOptionError).issues[0]).toMatchObject({ path: 'defaultJobOptions.delay', code: 'conflict' });
    }
  });

  it('defaults: unknown key is rejected', () => {
    expect(() => new Queue('q', { defaultJobOptions: { maxAttemps: 5 } as never })).toThrow(/did you mean "maxAttempts"/);
    expect(() => new Queue('q', { defaultJobOptions: { attempts: 5 } as never })).toThrow(/use "maxAttempts"/);
  });

  it('defaults: invalid default throws InvalidOptionError at construction', () => {
    expect(() => new Queue('q', { defaultJobOptions: { maxAttempts: 0 } })).toThrow(InvalidOptionError);
    expect(() => new Queue('q', { defaultJobOptions: { priority: 1.5 } })).toThrow(InvalidOptionError);
    expect(() => new Queue('q', { defaultJobOptions: { backoff: { type: '' } } as never })).toThrow(InvalidOptionError);
  });

  it('defaults: mutating the passed object after construction has no effect', () => {
    const d = { maxAttempts: 5, backoff: { type: 'fixed' as const, delay: 1000 } };
    const q = new Queue('q', { defaultJobOptions: d, logger: silent });
    d.maxAttempts = 9;
    d.backoff.delay = 1;
    expect(q.internals.defaultJobOptions).toEqual({ maxAttempts: 5, backoff: { type: 'fixed', delay: 1000 } });
    expect(Object.isFrozen(q.internals.defaultJobOptions)).toBe(true);
    expect(Object.isFrozen(q.internals.defaultJobOptions.backoff)).toBe(true);
  });

  it('defaults: defaultJobOptions {} or omitted is the same as none', () => {
    expect(new Queue('q', { defaultJobOptions: {}, logger: silent }).internals.defaultJobOptions).toEqual({});
    expect(new Queue('q', { logger: silent }).internals.defaultJobOptions).toEqual({});
  });

  const D = { maxAttempts: 5, backoff: { type: 'fixed', delay: 1000 }, priority: 5 } as const;

  it('defaults: queue default applies when add gives no option', () => {
    expect(resolveJobOptions(D, {}, 0)).toMatchObject({ maxAttempts: 5, priority: 5, backoff: { type: 'fixed', delay: 1000 } });
  });

  it('defaults: add option overrides the default, including falsy values', () => {
    expect(resolveJobOptions(D, { priority: 0 }, 0).priority).toBe(0);
  });

  it('defaults: undefined in add option falls back to the default', () => {
    expect(resolveJobOptions(D, { priority: undefined }, 0).priority).toBe(5);
  });

  it('defaults: object options are replaced, not deep-merged', () => {
    const b = resolveJobOptions({ backoff: { type: 'fixed', delay: 7000 } }, { backoff: { type: 'exponential' } }, 0).backoff as { type: string; delay?: number };
    expect(b.type).toBe('exponential');
    expect(b.delay).not.toBe(7000);
  });

  it('defaults: library fallbacks are resolved when neither side sets them', () => {
    expect(resolveJobOptions({}, {}, 0)).toMatchObject({ maxAttempts: 3, priority: 0 });
  });

  it('defaults: invalid merged result throws InvalidOptionError', () => {
    expect(() => resolveJobOptions(D, { maxAttempts: 0 }, 0)).toThrow(InvalidOptionError);
  });

  const resolveAdd = (o: Record<string, unknown>) => resolveJobOptions({}, o, 0);

  it('delay: delay and runAt together throw InvalidOptionError', () => {
    expect(() => resolveAdd({ delay: 5, runAt: 1 })).toThrow(InvalidOptionError);
  });

  it('add: delay and runAt together throws InvalidOptionError', () => {
    try {
      resolveJobOptions({}, { delay: 1000, runAt: Date.now() + 1000 }, 0);
      expect.unreachable();
    } catch (e) {
      const issues = (e as InvalidOptionError).issues;
      expect(issues.every((i) => i.code === 'conflict')).toBe(true);
      expect(issues.map((i) => i.path).sort()).toEqual(['delay', 'runAt']);
    }
  });

  it('delay: invalid delay and runAt values throw InvalidOptionError', () => {
    for (const delay of [1.5, -1, '5 seconds', NaN, Infinity, 3.2e12, '1.0001ms', null, '5s ']) {
      expect.soft(() => resolveAdd({ delay }), String(delay)).toThrow(InvalidOptionError);
    }
    for (const runAt of [new Date('invalid'), NaN, 1.5, 8.64e15 + 1, '2026-01-01']) {
      expect.soft(() => resolveAdd({ runAt }), String(runAt)).toThrow(InvalidOptionError);
    }
  });

  it('delay: Duration strings convert to ms and a delay above the 100-year cap throws', () => {
    expect(resolveAdd({ delay: '1.5s' }).delayMs).toBe(1500);
    expect(resolveAdd({ delay: '2h' }).delayMs).toBe(7_200_000);
    expect(resolveAdd({ delay: 3_153_600_000_000 }).delayMs).toBe(3_153_600_000_000);
    expect(() => resolveAdd({ delay: 3_153_600_000_001 })).toThrow(/100 years/);
    expect(resolveAdd({}).delayMs).toBe(0);
  });

  it('delay: runAt as Date and as epoch ms are equivalent', () => {
    expect(resolveJobOptions({}, { runAt: new Date(1_000) }, 400).delayMs).toBe(600);
    expect(resolveJobOptions({}, { runAt: 1_000 }, 400).delayMs).toBe(600);
    expect(resolveJobOptions({}, { runAt: 100 }, 400).delayMs).toBe(0);
  });

  it('delay: delay and runAt as queue defaults throw InvalidOptionError', () => {
    expect(() => new Queue('q', { defaultJobOptions: { delay: 5000 } as never })).toThrow(InvalidOptionError);
    expect(() => new Queue('q', { defaultJobOptions: { runAt: 1 } as never })).toThrow(InvalidOptionError);
  });

  it('priority: invalid priority values throw InvalidOptionError', () => {
    for (const priority of [1.5, NaN, 'high', Infinity, -Infinity, MIN_PRIORITY - 1, MAX_PRIORITY + 1, null]) {
      expect.soft(() => resolveJobOptions({}, { priority }, 0), String(priority)).toThrow(InvalidOptionError);
    }
    expect(resolveJobOptions({}, { priority: MIN_PRIORITY }, 0).priority).toBe(MIN_PRIORITY);
    expect(resolveJobOptions({}, { priority: MAX_PRIORITY }, 0).priority).toBe(MAX_PRIORITY);
  });

  it('priority: queue default priority is overridden per add', () => {
    expect(resolveJobOptions({ priority: 5 }, {}, 0).priority).toBe(5);
    expect(resolveJobOptions({ priority: 5 }, { priority: 1 }, 0).priority).toBe(1);
  });

  it('priority: first as a queue default throws InvalidOptionError', () => {
    expect(() => new Queue('q', { defaultJobOptions: { first: true } as never })).toThrow(InvalidOptionError);
  });

  it('priority: first is a boolean per-add option, default false', () => {
    expect(resolveJobOptions({}, {}, 0).first).toBe(false);
    expect(resolveJobOptions({}, { first: true }, 0).first).toBe(true);
    expect(() => resolveJobOptions({}, { first: 'yes' }, 0)).toThrow(InvalidOptionError);
  });

  const catchErr = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return expect.unreachable('did not throw');
  };

  it('add: unknown option throws InvalidOptionError naming the option and the closest valid one', () => {
    const e = catchErr(() => resolveAdd({ maxAttemps: 5 })) as InvalidOptionError;
    expect(e.issues[0]).toMatchObject({ path: 'maxAttemps', code: 'unknown_option', suggestion: 'maxAttempts' });
    expect(e.message).toContain('did you mean "maxAttempts"?');
  });

  it('add: name option is stored and visible on the job; invalid name throws InvalidOptionError', () => {
    expect(resolveAdd({ name: 'email:send/v1' }).name).toBe('email:send/v1');
    expect(resolveAdd({}).name).toBeNull();
    for (const name of ['', '*', 'a b', 'x'.repeat(129), 'é', 5]) {
      expect.soft(() => resolveAdd({ name }), String(name)).toThrow(InvalidOptionError);
    }
    expect(resolveAdd({ name: 'x'.repeat(128) }).name).toHaveLength(128);
  });

  it('add: delay accepts a Duration string and a number of ms', () => {
    expect(resolveAdd({ delay: '30s' }).delayMs).toBe(30_000);
    expect(resolveAdd({ delay: 250 }).delayMs).toBe(250);
  });

  it('add: all issues are reported in one error', () => {
    const e = catchErr(() => resolveAdd({ priority: 1.5, delay: -1, bogus: 1 })) as InvalidOptionError;
    expect(e.issues.map((i) => i.path)).toEqual(['bogus', 'delay', 'priority']);
  });

  it('queue: name and namespace patterns', () => {
    expect(QUEUE_NAME_RE.test('emails.v2_x-y')).toBe(true);
    expect(QUEUE_NAME_RE.test('a'.repeat(101))).toBe(false);
    expect(NAMESPACE_RE.test('n'.repeat(64))).toBe(true);
    expect(NAMESPACE_RE.test('n'.repeat(65))).toBe(false);
  });

  it('contract: custom Store objects are accepted and anything else throws InvalidOptionError at path store', async () => {
    for (const bad of [{}, new Date(), null, 'store', { ...new MemoryStore(), add() {} }]) {
      let caught: unknown;
      try {
        new Queue('q', { store: bad as never, logger: silent });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidOptionError);
      expect((caught as InvalidOptionError).issues[0]!.path).toBe('store');
    }
    const { store, calls } = spyStore(new MemoryStore());
    const q = new Queue('q', { store, logger: silent });
    await q.add(1);
    expect(calls.map((c) => c.op)).toContain('add');
  });

  it('dedup: queue-level id must be a function', () => {
    const e = catchErr(() => new Queue('q', { id: 'x' as never, logger: silent })) as InvalidOptionError;
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect(e.issues[0]!.path).toBe('id');
    expect(() => new Queue('q', { id: (d) => String(d), logger: silent })).not.toThrow();
  });

  it('dedup: unknown onDuplicate value throws InvalidOptionError naming the allowed rules', () => {
    const e = catchErr(() => resolveAdd({ onDuplicate: 'replce' })) as InvalidOptionError;
    expect(e).toBeInstanceOf(InvalidOptionError);
    expect(e.issues[0]).toMatchObject({ path: 'onDuplicate', suggestion: 'replace' });
    expect(e.message).toMatch(/ignore.*replace.*reject/);
    expect(catchErr(() => new Queue('q', { onDuplicate: 'nope' as never, logger: silent }))).toBeInstanceOf(InvalidOptionError);
    expect(catchErr(() => resolveAdd({ onDuplicate: 5 }))).toBeInstanceOf(InvalidOptionError);
    for (const rule of ['ignore', 'replace', 'reject', () => ({})]) expect(() => resolveAdd({ onDuplicate: rule })).not.toThrow();
  });

  it('dedup: uniqueWhile accepts pending and retained only', () => {
    for (const v of ['pending', 'retained']) expect(resolveAdd({ uniqueWhile: v }).uniqueWhile).toBe(v);
    expect(catchErr(() => resolveAdd({ uniqueWhile: 'forever' }))).toBeInstanceOf(InvalidOptionError);
    expect(catchErr(() => new Queue('q', { uniqueWhile: 'always' as never, logger: silent }))).toBeInstanceOf(InvalidOptionError);
    expect(new Queue('q', { logger: silent }).internals.uniqueWhile).toBe('pending');
  });

  it('dedup: id, onDuplicate and uniqueWhile are not accepted inside defaultJobOptions', () => {
    for (const k of ['id', 'onDuplicate', 'uniqueWhile', 'idempotencyKey']) {
      const e = catchErr(() => new Queue('q', { defaultJobOptions: { [k]: 'x' } as never, logger: silent })) as InvalidOptionError;
      expect.soft(e, k).toBeInstanceOf(InvalidOptionError);
      expect.soft(e.issues[0], k).toMatchObject({ path: `defaultJobOptions.${k}` });
    }
    const e = catchErr(() => new Queue('q', { defaultJobOptions: { onDuplicate: 'replace' } as never })) as InvalidOptionError;
    expect(e.issues[0]!.message).toMatch(/queue option/);
  });
});
