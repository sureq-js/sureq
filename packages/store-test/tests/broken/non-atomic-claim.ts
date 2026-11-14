import { MemoryStore, type ClaimRequest, type ClaimResult, type Scope } from '@sureq/core';
import { inject, yieldToLoop } from './inject.js';

// claim picks its jobs, yields to the event loop, then writes: a caller in between sees the same jobs as waiting.
class NonAtomicClaim extends MemoryStore {
  override async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    await yieldToLoop();
    const res = await super.claim(scope, req);
    if (res.recovered || res.jobs.length === 0) return res;
    for (const j of res.jobs) this.unsafeMutate(scope, j.id, { state: 'waiting', lease: null, attempt: j.attempt - 1 });
    await yieldToLoop();
    for (const j of res.jobs) this.unsafeMutate(scope, j.id, { state: 'active', lease: j.lease, token: j.token, attempt: j.attempt });
    return res;
  }
}

export const nonAtomicClaim = inject(
  'nonAtomicClaim',
  ['claim'],
  ['claim: concurrent claimers never receive the same job', 'claim: 100k jobs each claimed exactly once'],
  NonAtomicClaim,
);
