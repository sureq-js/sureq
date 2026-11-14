import { describe, expect, it } from 'vitest';
import { InvalidOptionError, QueueClosedError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { parseCron } from '../../src/scheduler/cron.js';
import { nextOccurrence, parseTiming, upcoming } from '../../src/scheduler/timing.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';

const Z = Date.parse;
const NOW = Z('2026-11-06T00:00Z');
const issuesOf = (input: unknown) => {
  try {
    parseTiming('t', input, NOW);
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidOptionError);
    return (err as InvalidOptionError).issues;
  }
  throw new InvalidOptionError('t', [{ path: '', code: 'invalid_value', message: 'expected parseTiming to throw' }]);
};

describe('schedule timing', () => {
  it('timing: parseTiming normalizes cron and every and collects every issue', () => {
    expect(parseTiming('t', { cron: '0 2 * * *' }, NOW)).toEqual({ kind: 'cron', cron: '0 2 * * *', tz: 'UTC', spec: parseCron('0 2 * * *') });
    expect(parseTiming('t', { cron: '0 2 * * *', tz: 'Europe/Berlin' }, NOW)).toMatchObject({ tz: 'Europe/Berlin' });
    expect(parseTiming('t', { every: '30s' }, NOW)).toEqual({ kind: 'every', everyMs: 30_000 });

    expect(issuesOf({ cron: 'x', tz: 'EST' }).map((i) => [i.path, i.reason])).toEqual([['cron', 'bad-cron'], ['tz', 'bad-timezone']]);
    expect(issuesOf({ cron: '0 0 30 2 *' })).toEqual([{ path: 'cron', code: 'invalid_value', reason: 'no-occurrence', message: 'no date matches within 9 years' }]);
    expect(issuesOf({ every: '1w' })).toMatchObject([{ path: 'every', reason: 'bad-interval' }]);
    expect(issuesOf({})).toMatchObject([{ code: 'missing_option' }]);
    expect(issuesOf({ cron: '* * * * *', every: 1000 })).toMatchObject([{ code: 'conflict' }]);
    expect(issuesOf({ every: 1000, tz: 'UTC' })).toMatchObject([{ path: 'tz', code: 'conflict' }]);
    expect(issuesOf({ crn: '* * * * *' })).toContainEqual(expect.objectContaining({ path: 'crn', code: 'unknown_option', suggestion: 'cron' }));
  });

  it('timing: upcoming gives n strictly increasing instants', () => {
    const ny = parseTiming('t', { cron: '0 9 * * *', tz: 'America/New_York' }, NOW);
    expect(upcoming(ny, 0, Z('2026-03-06T00:00Z'), 3)).toEqual([Z('2026-03-06T14:00Z'), Z('2026-03-07T14:00Z'), Z('2026-03-08T13:00Z')]);
    const every = parseTiming('t', { every: 1000 }, NOW);
    expect(upcoming(every, 500, 2_000, 3)).toEqual([2_500, 3_500, 4_500]);
    expect(nextOccurrence(every, 500, 2_500)).toBe(3_500);
    const leap = parseTiming('t', { cron: '0 0 29 2 *' }, NOW);
    expect(upcoming(leap, 0, Z('2096-03-01T00:00Z'), 3)).toEqual([Z('2104-02-29T00:00Z'), Z('2108-02-29T00:00Z'), Z('2112-02-29T00:00Z')]);
    // fewer only when a cron runs out of matches
    expect(upcoming({ kind: 'cron', cron: '0 0 30 2 *', tz: 'UTC', spec: parseCron('0 0 30 2 *') }, 0, NOW, 3)).toEqual([]);
  });
});

describe('schedule preview', () => {
  it('timing: previewSchedule lists ticks from store now', async () => {
    const queue = new Queue('q', { store: new MemoryStore({ clock: () => 1_000 }) });
    try {
      await expect(queue.previewSchedule({ every: '1s' })).resolves.toEqual([2000, 3000, 4000, 5000, 6000]);
      await expect(queue.previewSchedule({ cron: '0 * * * *' }, 2)).resolves.toEqual([3_600_000, 7_200_000]);
      await expect(queue.previewSchedule({ cron: 'nope' })).rejects.toMatchObject({ issues: [{ reason: 'bad-cron' }] });
      for (const n of [0, 101, 1.5, '5']) await expect(queue.previewSchedule({ every: 1000 }, n as number)).rejects.toMatchObject({ issues: [{ path: 'n' }] });
    } finally {
      await queue.close();
    }
    await expect(queue.previewSchedule({ every: 1000 })).rejects.toBeInstanceOf(QueueClosedError);
  });
});
