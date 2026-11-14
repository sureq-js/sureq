import { MemoryStore, type Scope, type SetProgressRequest, type SetProgressResult } from '@sureq/core';
import { FOREVER, inject } from './inject.js';

// setProgress skips the fence: it takes the stored token and revives an expired lease.
class UnfencedProgress extends MemoryStore {
  override async setProgress(scope: Scope, req: SetProgressRequest): Promise<SetProgressResult> {
    const rec = await this.get(scope, req.id);
    if (rec?.state !== 'active' || !rec.lease) return super.setProgress(scope, req);
    this.unsafeMutate(scope, req.id, { lease: { ...rec.lease, expiresAt: FOREVER } });
    return super.setProgress(scope, { ...req, token: rec.token });
  }
}

export const unfencedProgress = inject(
  'unfencedProgress',
  ['setProgress'],
  ['progress: write with stale token is rejected and changes nothing'],
  UnfencedProgress,
);
