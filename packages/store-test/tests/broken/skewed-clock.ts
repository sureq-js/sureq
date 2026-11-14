import { MemoryStore } from '@sureq/core';
import { inject } from './inject.js';

const realNow = Date.now;

// The store reads the calling process's Date.now: the store clock plus whatever skew the pod has.
class SkewedClock extends MemoryStore {
  constructor(opts: { clock?: () => number }) {
    const clock = opts.clock ?? realNow;
    super({ ...opts, clock: () => clock() + (Date.now() - realNow()) });
  }
}

export const skewedClock = inject(
  'skewedClock',
  ['constructor'],
  [
    'clock: store time is unaffected by pod clock skew +1h',
    'clock: store time is unaffected by pod clock skew -1h',
    'lease: lease expires at claim time plus leaseMs on store time',
    'age: computed in store time under pod clock skew ±1h',
    'admin: clean removes only jobs of the state older than the cutoff by store time',
    'retention: expiry uses store time when pod clock is skewed',
  ],
  SkewedClock,
);
