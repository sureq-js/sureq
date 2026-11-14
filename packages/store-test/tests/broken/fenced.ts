import type { CompleteResult, FailRequest, FailResult, MemoryStore, Payload, ReleaseRequest, ReleaseResult, RenewRequest, RenewResult, Scope } from '@sureq/core';

type Fenced = RenewResult | CompleteResult | FailResult | ReleaseResult;
export type FencedReq = { id: string; token: number };
/** Wrap one fenced write: `around(scope, req, call)` may edit the request and the result. */
export type Around = (store: MemoryStore, scope: Scope, req: FencedReq, call: (req: FencedReq) => Promise<Fenced>) => Promise<Fenced>;

/** A MemoryStore subclass whose renew, complete, fail and release all go through `around`. */
export function fencedWrites(Base: typeof MemoryStore, around: Around): typeof MemoryStore {
  return class extends Base {
    override async renew(scope: Scope, req: RenewRequest): Promise<RenewResult> {
      return around(this, scope, req, (r) => super.renew(scope, r as RenewRequest)) as Promise<RenewResult>;
    }
    override async complete(scope: Scope, req: { id: string; token: number; result: Payload | null }): Promise<CompleteResult> {
      return around(this, scope, req, (r) => super.complete(scope, r as typeof req)) as Promise<CompleteResult>;
    }
    override async fail(scope: Scope, req: FailRequest): Promise<FailResult> {
      return around(this, scope, req, (r) => super.fail(scope, r as FailRequest)) as Promise<FailResult>;
    }
    override async release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult> {
      return around(this, scope, req, (r) => super.release(scope, r as ReleaseRequest)) as Promise<ReleaseResult>;
    }
  };
}
