import { MemoryStore, type Scope, type SweepRequest, type SweepResult } from '@sureq/core';
import { inject, yieldToLoop } from './inject.js';

// sweep decides from a snapshot taken before a yield and never re-checks it at write time.
class SweepUndoesRenew extends MemoryStore {
  override async sweep(scope: Scope, req: SweepRequest): Promise<SweepResult> {
    const snapshot = await this.list(scope, { state: 'active', offset: 0, limit: 1000, order: 'asc' });
    await yieldToLoop();
    const res = await super.sweep(scope, req);
    for (const rec of snapshot) {
      if (res.swept.length >= req.limit || rec.lease!.expiresAt > res.now || res.swept.some((j) => j.id === rec.id)) continue;
      const crashCount = rec.crashCount + 1;
      this.unsafeMutate(scope, rec.id, { state: 'waiting', lease: null, crashCount, runAt: res.now });
      res.swept.push({ id: rec.id, token: rec.token, previousOwner: rec.lease!.owner, action: 'requeued', attempt: rec.attempt, crashCount });
    }
    return res;
  }
}

export const sweepUndoesRenew = inject(
  'sweepUndoesRenew',
  ['sweep'],
  [
    'sweep: sweep does not undo a renew that landed first',
    'sweep: concurrent sweepers count each crash exactly once',
    'fencing: sweep does not undo a renew that landed first',
  ],
  SweepUndoesRenew,
);
