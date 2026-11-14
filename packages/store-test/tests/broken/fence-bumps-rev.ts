import { MemoryStore } from '@sureq/core';
import { fencedWrites } from './fenced.js';
import { inject } from './inject.js';

// A fence-rejected write still bumps rev.
export const fenceBumpsRev = inject(
  'fenceBumpsRev',
  ['renew', 'complete', 'fail', 'release'],
  ['contract: fence check order superseded, not-active, expired, and rejection changes nothing including rev'],
  fencedWrites(MemoryStore, async (store, scope, req, call) => {
    const res = await call(req);
    const rec = res.ok ? null : await store.get(scope, req.id);
    if (rec) store.unsafeMutate(scope, req.id, { rev: rec.rev + 1 });
    return res;
  }),
);
