import type { JobState } from '../store/types.js';

export type { JobState };

export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled'];

/**
 * The state transitions. Creation (as waiting or delayed) and deletion are not
 * transitions. Sweep, cancel and redrive arrive with their features.
 */
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  delayed: ['waiting'],
  waiting: ['active'],
  active: ['completed', 'delayed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The state a reader sees: a delayed job whose `runAt` has passed is waiting. */
export function effectiveState(rec: { state: JobState; runAt: number }, now: number): JobState {
  return rec.state === 'delayed' && rec.runAt <= now ? 'waiting' : rec.state;
}
