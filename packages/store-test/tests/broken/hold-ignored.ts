import { MemoryStore, type ClaimRequest, type ClaimResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// claim drops hold, so a held lease is never marked and its expiry counts as a crash.
class HoldIgnored extends MemoryStore {
  override async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    const { hold: _hold, ...rest } = req;
    return super.claim(scope, rest);
  }
}

export const holdIgnored = inject(
  'holdIgnored',
  ['claim'],
  [
    'batch: claim with hold marks the lease held and renew with started clears it',
    'batch: an expired held lease is swept as a refunded release without crashCount',
  ],
  HoldIgnored,
);
