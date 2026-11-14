import { MemoryStore } from '@sureq/core';
import { fencedWrites } from './fenced.js';
import { inject } from './inject.js';

// Fenced writes check the state but not the token: the stored token replaces the caller's.
export const ignoredFencingToken = inject(
  'ignoredFencingToken',
  ['renew', 'complete', 'fail', 'release'],
  [
    'fencing: complete with old token after re-claim is rejected as superseded',
    'fencing: renew, fail and release with stale token are all rejected and change nothing',
  ],
  fencedWrites(MemoryStore, async (store, scope, req, call) => {
    const rec = await store.get(scope, req.id);
    return call(rec?.state === 'active' ? { ...req, token: rec.token } : req);
  }),
);
