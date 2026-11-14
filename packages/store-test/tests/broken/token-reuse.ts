import { MemoryStore, type ClaimRequest, type ClaimResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// The token is the attempt number less the crashes, so it starts again after a requeue.
class TokenReuse extends MemoryStore {
  override async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    const res = await super.claim(scope, req);
    for (const job of res.jobs) {
      job.token = job.attempt - job.crashCount;
      job.lease = { ...job.lease!, token: job.token };
      this.unsafeMutate(scope, job.id, { token: job.token, lease: job.lease });
    }
    return res;
  }
}

export const tokenReuse = inject(
  'tokenReuse',
  ['claim'],
  ['fencing: re-claim after sweep issues a larger token than the first claim', 'fencing: token never decreases and is kept after the job finishes'],
  TokenReuse,
);
