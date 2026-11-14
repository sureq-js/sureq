import { MemoryStore, type FailRequest, type FailResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// fail with retryInMs always retries: attempts left are never checked.
class FailIgnoresMaxAttempts extends MemoryStore {
  override async fail(scope: Scope, req: FailRequest): Promise<FailResult> {
    const rec = req.retryInMs === undefined ? null : await this.get(scope, req.id);
    if (!rec) return super.fail(scope, req);
    this.unsafeMutate(scope, req.id, { maxAttempts: rec.attempt + 1 });
    try {
      return await super.fail(scope, req);
    } finally {
      this.unsafeMutate(scope, req.id, { maxAttempts: rec.maxAttempts });
    }
  }
}

export const failIgnoresMaxAttempts = inject(
  'failIgnoresMaxAttempts',
  ['fail'],
  ['contract: fail with retryInMs but attempt at maxAttempts goes failed'],
  FailIgnoresMaxAttempts,
);
