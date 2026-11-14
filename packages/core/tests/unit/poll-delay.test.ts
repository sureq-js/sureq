import { describe, expect, it } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import { Queue } from '../../src/queue/queue.js';
import { PollDelay } from '../../src/worker/poll.js';
import { silent } from '../helpers/harness.js';

const DEFAULTS = { pollMin: 100, pollMax: 5000, pollFactor: 2, pollJitter: 0.2 };
const now = 1_000_000;
const empty = { jobs: [], now, nextRunAt: null, paused: false };
const withJob = { ...empty, jobs: [{}] as never };
const delay = (random = () => 0.5) => new PollDelay({ ...DEFAULTS, random });

describe('PollDelay', () => {
  it('polling: idle worker delay grows from pollMin to pollMax and stays there', () => {
    const d = delay();
    expect(Array.from({ length: 8 }, () => d.next(empty))).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000]);
  });

  it('polling: delay resets to pollMin after a claim returns jobs', () => {
    const d = delay();
    d.next(empty);
    d.next(empty);
    expect(d.next(withJob)).toBe(0);
    expect(d.next(empty)).toBe(100);
    d.next(empty);
    d.reset();
    expect(d.next(empty)).toBe(100);
  });

  it('polling: jitter stays within pollJitter and differs between workers', () => {
    // The first wait is pollMin ± 20 %, but never below pollMin.
    expect(delay(() => 0).next(empty)).toBe(100);
    expect(delay(() => 1).next(empty)).toBe(120);
    const fourth = (r: number) => {
      const d = delay(() => r);
      for (let i = 0; i < 3; i++) d.next(empty);
      return d.next(empty); // base 800
    };
    expect([fourth(0), fourth(0.5), fourth(1)]).toEqual([640, 800, 960]);
    for (const r of [() => 0, () => 1, Math.random]) {
      const d = delay(r);
      for (let i = 0; i < 12; i++) {
        const ms = d.next(empty);
        expect(ms).toBeGreaterThanOrEqual(100);
        expect(ms).toBeLessThanOrEqual(5000);
      }
    }
    const a = delay(() => 0.1);
    const b = delay(() => 0.9);
    expect(a.next(empty)).not.toBe(b.next(empty));
  });

  it('polling: sleeps until nextRunAt for delayed jobs', () => {
    const at800 = () => {
      const d = delay();
      for (let i = 0; i < 3; i++) d.next(empty); // 100, 200, 400: the next base is 800
      return d;
    };
    expect(at800().next({ ...empty, nextRunAt: now + 30 })).toBe(100); // floored at pollMin
    expect(at800().next({ ...empty, nextRunAt: now + 700 })).toBe(700);
  });

  it('polling: blocked rate-limit result sleeps min of retryAfterMs, nextRunAt and pollMax', () => {
    const d = delay();
    for (let i = 0; i < 3; i++) d.next(empty);
    expect(d.next({ ...empty, nextRunAt: now + 900, blocked: { reason: 'rate-limit', retryAfterMs: 250 } })).toBe(250);
  });

  it('polling: paused queue polls at pollMax', () => {
    const d = delay();
    expect(d.next({ ...empty, paused: true })).toBe(5000);
    expect(d.next({ ...empty, paused: true })).toBe(5000);
    // Jittered downward only, so paused pods do not poll in lockstep.
    expect(delay(() => 0).next({ ...empty, paused: true })).toBe(4000);
    expect(delay(() => 1).next({ ...empty, paused: true })).toBe(5000);
  });

  it('polling: option validation throws InvalidOptionError', async () => {
    const q = new Queue('p', { logger: silent });
    const pathOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidOptionError);
        return (e as InvalidOptionError).issues[0]!.path;
      }
      return undefined;
    };
    const proc = (opts: Record<string, unknown>) => () => q.process(() => {}, { autorun: false, ...opts });
    expect(pathOf(proc({ pollMin: 0 }))).toBe('pollMin');
    expect(pathOf(proc({ pollMin: 200, pollMax: 100 }))).toMatch(/^poll(Min|Max)$/);
    expect(pathOf(proc({ pollFactor: 1 }))).toBe('pollFactor');
    expect(pathOf(proc({ pollJitter: 1.5 }))).toBe('pollJitter');
    expect(pathOf(proc({ notify: 'yes' }))).toBe('notify');
    expect(pathOf(proc({ pollMin: '1s', pollMax: '500ms' }))).toMatch(/^poll(Min|Max)$/);
    expect(pathOf(() => new Queue('p', { pollMin: 0 } as never))).toBe('pollMin');
    const merged = new Queue('p', { logger: silent, pollMax: '2s' });
    expect(pathOf(() => merged.process(() => {}, { autorun: false, pollMin: '3s' }))).toMatch(/^poll(Min|Max)$/);
    expect(() => proc({ pollIntervalMs: 5 })()).toThrow(/use "pollMin"/);
    expect(pathOf(proc({ pollMin: '250ms', pollMax: 1000 }))).toBeUndefined();
    await Promise.all([q.close(), merged.close()]);
  });
});
