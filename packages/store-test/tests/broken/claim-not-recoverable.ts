import { randomUUID } from 'node:crypto';
import { MemoryStore, type ClaimRequest, type ClaimResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// claim ignores claimId, so a repeat claims fresh jobs.
class ClaimNotRecoverable extends MemoryStore {
  override async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    return super.claim(scope, { ...req, claimId: randomUUID() });
  }
}

export const claimNotRecoverable = inject(
  'claimNotRecoverable',
  ['claim'],
  ['contract: claim repeated with the same claimId returns the same jobs with recovered true and claims nothing new'],
  ClaimNotRecoverable,
);
