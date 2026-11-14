import { MemoryStore, type ClaimRequest, type ClaimResult, type RemoveResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// Tokens are a per-job counter that starts again at 1 when the id is removed and added again.
class PerJobTokenReset extends MemoryStore {
  readonly #tokens = new Map<string, number>();
  override async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    const res = await super.claim(scope, req);
    for (const job of res.jobs) {
      const key = `${scope.namespace}/${scope.queue}/${job.id}`;
      if (res.recovered) {
        job.token = this.#tokens.get(key)!;
      } else {
        job.token = (this.#tokens.get(key) ?? 0) + 1;
        this.#tokens.set(key, job.token);
      }
      job.lease = { ...job.lease!, token: job.token };
      this.unsafeMutate(scope, job.id, { token: job.token, lease: job.lease });
    }
    return res;
  }
  override async remove(scope: Scope, req: { id: string }): Promise<RemoveResult> {
    const res = await super.remove(scope, req);
    if (res.removed) this.#tokens.delete(`${scope.namespace}/${scope.queue}/${req.id}`);
    return res;
  }
}

export const perJobTokenReset = inject(
  'perJobTokenReset',
  ['claim', 'remove'],
  [
    'fencing: stale token from a previous incarnation of a reused id is rejected',
    'fencing: tokens are unique per queue across jobs and never reused after remove, clean or forced obliterate',
  ],
  PerJobTokenReset,
);
