import { MemoryStore, type Scope, type UpdateRequest, type UpdateResult } from '@sureq/core';
import { inject } from './inject.js';

// update ignores expectedRev and edits active jobs too.
class UpdateIgnoresRev extends MemoryStore {
  override async update(scope: Scope, req: UpdateRequest): Promise<UpdateResult> {
    const rec = await this.get(scope, req.id);
    if (!rec) return super.update(scope, req);
    const active = rec.state === 'active';
    if (active) this.unsafeMutate(scope, req.id, { state: 'waiting' });
    try {
      return await super.update(scope, { ...req, expectedRev: rec.rev });
    } finally {
      if (active) this.unsafeMutate(scope, req.id, { state: 'active' });
    }
  }
}

export const updateIgnoresRev = inject(
  'updateIgnoresRev',
  ['update'],
  [
    'contract: update applies on matching rev, conflict on stale rev, not-editable when active',
    'merge: conditional write fails when rev changed',
    'merge: conditional write fails when job became active',
  ],
  UpdateIgnoresRev,
);
