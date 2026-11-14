import { MemoryStore, type ClaimRequest, type ClaimResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// claim does not read the pause flag.
class PauseIgnored extends MemoryStore {
  override async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    if (!(await this.isPaused(scope))) return super.claim(scope, req);
    await this.setPaused(scope, false);
    try {
      return await super.claim(scope, req);
    } finally {
      await this.setPaused(scope, true);
    }
  }
}

export const pauseIgnored = inject(
  'pauseIgnored',
  ['claim'],
  ['claim: paused queue returns nothing, reports blocked paused, and resume restores claiming', 'gpause: claim returns no jobs while paused and jobs after resume'],
  PauseIgnored,
);
