import {
  MemoryStore, type CompleteResult, type FailRequest, type FailResult, type Payload, type ReleaseRequest, type ReleaseResult, type Scope,
} from '@sureq/core';
import { inject } from './inject.js';

const refuse = <T extends { ok: boolean; repeated?: true }>(r: T): T | { ok: false; reason: 'not-active' } =>
  r.ok && r.repeated ? { ok: false, reason: 'not-active' } : r;

// A repeated complete, fail or release is refused instead of answered.
class FinalNotRepeatable extends MemoryStore {
  override async complete(scope: Scope, req: { id: string; token: number; result: Payload | null }): Promise<CompleteResult> {
    return refuse(await super.complete(scope, req));
  }
  override async fail(scope: Scope, req: FailRequest): Promise<FailResult> {
    return refuse(await super.fail(scope, req));
  }
  override async release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult> {
    return refuse(await super.release(scope, req));
  }
}

export const finalNotRepeatable = inject(
  'finalNotRepeatable',
  ['complete', 'fail', 'release'],
  [
    'contract: complete, fail and release repeated with the same token return the original outcome with repeated true and change nothing, not even rev',
  ],
  FinalNotRepeatable,
);
