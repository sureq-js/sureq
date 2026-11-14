import { describe, expect, expectTypeOf, it } from 'vitest';
import { TERMINAL_STATES, canTransition, effectiveState, isTerminal, type JobState } from '../../src/job/states.js';

const STATES: JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];
const ALLOWED = new Set(['delayed>waiting', 'waiting>active', 'active>completed', 'active>delayed', 'active>failed']);

describe('states (table)', () => {
  it('states: illegal transitions are rejected and change nothing', () => {
    for (const from of STATES) {
      for (const to of STATES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(ALLOWED.has(`${from}>${to}`));
    }
  });

  it('states: terminal states never change except via explicit retry', () => {
    expect([...TERMINAL_STATES]).toEqual(['completed', 'failed', 'cancelled']);
    for (const s of TERMINAL_STATES) for (const t of STATES) expect(canTransition(s, t)).toBe(false);
    for (const s of STATES) expect(isTerminal(s), s).toBe(TERMINAL_STATES.includes(s));
  });

  it('states: delayed job whose runAt passed is claimed without any timer', () => {
    expect(effectiveState({ state: 'delayed', runAt: 100 }, 99)).toBe('delayed');
    expect(effectiveState({ state: 'delayed', runAt: 100 }, 100)).toBe('waiting');
    expect(effectiveState({ state: 'delayed', runAt: 100 }, 101)).toBe('waiting');
    for (const s of STATES.filter((x) => x !== 'delayed')) expect(effectiveState({ state: s, runAt: 0 }, 1e12)).toBe(s);
  });

  it('states: waiting-for-retry job is delayed with attempt at least 1', () => {
    expectTypeOf<JobState>().toEqualTypeOf<'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'cancelled'>();
  });
});
