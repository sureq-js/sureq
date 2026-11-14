import type { JobState } from '../contract.js';
import { JOB_STATES } from '../../util/job-states.js';

/** The allowed state transitions. Creation and deletion are not transitions. */
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  delayed: ['waiting', 'cancelled'],
  waiting: ['active', 'delayed', 'cancelled'],
  active: ['completed', 'failed', 'delayed', 'waiting', 'cancelled'],
  completed: [],
  failed: ['waiting', 'delayed'], // redrive only
  cancelled: [],
};

/** Every job state, in the order the store documents them. */
export const STATES = JOB_STATES;

export function canMove(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The state a reader sees: a delayed job whose `runAt` has passed is waiting. */
export function effective(rec: { state: JobState; runAt: number }, now: number): JobState {
  return rec.state === 'delayed' && rec.runAt <= now ? 'waiting' : rec.state;
}
