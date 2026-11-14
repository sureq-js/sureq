import { MemoryStore } from '@sureq/core';
import { fencedWrites } from './fenced.js';
import { FOREVER, inject } from './inject.js';

// Fenced writes skip the expiry check: the lease is stretched for the call and put back if the write was refused.
export const noLeaseExpiry = inject(
  'noLeaseExpiry',
  ['renew', 'complete', 'fail', 'release'],
  ['fencing: complete after expiry but before sweep is rejected as expired', 'lease: renew after expiry is rejected as expired and does not revive the lease'],
  fencedWrites(MemoryStore, async (store, scope, req, call) => {
    const rec = await store.get(scope, req.id);
    const lease = rec?.state === 'active' ? rec.lease : null;
    if (lease) store.unsafeMutate(scope, req.id, { lease: { ...lease, expiresAt: FOREVER } });
    try {
      return await call(req);
    } finally {
      if (lease && (await store.get(scope, req.id))?.lease?.expiresAt === FOREVER) store.unsafeMutate(scope, req.id, { lease });
    }
  }),
);
