import { MemoryStore, type AddOutcome, type NewJob, type Scope } from '@sureq/core';
import { inject, yieldToLoop } from './inject.js';

// Checks the id, yields, then inserts: two adds of a new id that interleave both report added.
class NonAtomicAdd extends MemoryStore {
  override async add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    if (jobs.length !== 1 || (await this.get(scope, jobs[0]!.id))) return super.add(scope, jobs, opts);
    await yieldToLoop();
    const out = await super.add(scope, jobs, opts);
    // the second insert of the same id "succeeds" too
    return out.map((o) => (o.status === 'duplicate' && o.by === 'id' ? { status: 'added', job: o.job } : o));
  }
}

export const nonAtomicAdd = inject('nonAtomicAdd', ['add'], ['dedup: concurrent adds of the same id create exactly one job'], NonAtomicAdd);
