import { MemoryStore, type CompleteRequest, type CompleteResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// complete changes the job but never closes its attempt record.
class CloseSkipsHistory extends MemoryStore {
  override async complete(scope: Scope, req: CompleteRequest): Promise<CompleteResult> {
    return super.complete(scope, { ...req, history: false });
  }
}

export const closeSkipsHistory = inject(
  'closeSkipsHistory',
  ['complete'],
  ['history: complete, fail, cancel, sweep and release close the record with the right outcome'],
  CloseSkipsHistory,
);
