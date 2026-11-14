import { MemoryStore, type ReleaseRequest, type ReleaseResult, type Scope } from '@sureq/core';
import { FOREVER, inject } from './inject.js';

// release skips the fence: it takes the stored token and revives an expired lease.
class UnfencedRelease extends MemoryStore {
  override async release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult> {
    const rec = await this.get(scope, req.id);
    if (rec?.state !== 'active' || !rec.lease) return super.release(scope, req);
    this.unsafeMutate(scope, req.id, { lease: { ...rec.lease, expiresAt: FOREVER } });
    return super.release(scope, { ...req, token: rec.token });
  }
}

export const unfencedRelease = inject(
  'unfencedRelease',
  ['release'],
  ['release: stale token is rejected and changes nothing', 'fencing: renew, fail and release with stale token are all rejected and change nothing'],
  UnfencedRelease,
);
