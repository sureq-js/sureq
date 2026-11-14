import { MemoryStore, type CompleteResult, type Payload, type Scope } from '@sureq/core';
import { FOREVER, inject } from './inject.js';

// complete does not re-check the state after a cancel: a cancelled job with a matching token still completes.
class CancelCompleteRace extends MemoryStore {
  override async complete(scope: Scope, req: { id: string; token: number; result: Payload | null }): Promise<CompleteResult> {
    const rec = await this.get(scope, req.id);
    if (rec?.state === 'cancelled' && rec.token === req.token && rec.token > 0) {
      const lease = { owner: rec.workerId ?? 'unknown', token: rec.token, expiresAt: FOREVER, claimId: 'cancelled' };
      this.unsafeMutate(scope, req.id, { state: 'active', lease });
    }
    return super.complete(scope, req);
  }
}

export const cancelCompleteRace = inject(
  'cancelCompleteRace',
  ['complete'],
  ['cancel: concurrent cancel and complete with a valid token — exactly one wins'],
  CancelCompleteRace,
);
