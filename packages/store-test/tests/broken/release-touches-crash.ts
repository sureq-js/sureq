import { MemoryStore, type ReleaseRequest, type ReleaseResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// release counts a give-back as a crash.
class ReleaseTouchesCrash extends MemoryStore {
  override async release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult> {
    const res = await super.release(scope, req);
    const rec = res.ok && !res.repeated ? await this.get(scope, req.id) : null;
    if (rec) this.unsafeMutate(scope, req.id, { crashCount: rec.crashCount + 1 });
    return res;
  }
}

export const releaseTouchesCrash = inject(
  'releaseTouchesCrash',
  ['release'],
  ['release: release leaves crashCount unchanged', 'poison: crashCount is not changed by complete, fail, release or cancel'],
  ReleaseTouchesCrash,
);
