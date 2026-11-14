import { MemoryStore, type Scope, type SweepRequest, type SweepResult } from '@sureq/core';
import { inject } from './inject.js';

// sweep never reclaims anything.
class SweepNeverReclaims extends MemoryStore {
  override async sweep(_scope: Scope, req: SweepRequest): Promise<SweepResult> {
    // the request is still checked: an empty scope of its own sweeps nothing
    return super.sweep({ namespace: 'sweep-never-reclaims', queue: 'none' }, req);
  }
}

export const sweepNeverReclaims = inject(
  'sweepNeverReclaims',
  ['sweep'],
  ['sweep: expired lease is requeued to waiting with crashCount 1 and token kept', 'poison: sweep increments crashCount and requeues below the limit'],
  SweepNeverReclaims,
);
