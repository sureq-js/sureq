import type { JobState } from '../store/contract.js';

/** Every job state, in the order the store reports and documents them. */
export const JOB_STATES: readonly JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];
