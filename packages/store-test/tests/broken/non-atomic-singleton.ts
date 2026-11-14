import { MemoryStore, type AddOutcome, type NewJob, type Scope } from '@sureq/core';
import { inject, yieldToLoop } from './inject.js';

// Checks the singletonKey, yields, then inserts: two adds of a free key that interleave both create a job.
class NonAtomicSingleton extends MemoryStore {
  override async add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    const key = jobs.length === 1 ? jobs[0]!.singletonKey : undefined;
    if (key === undefined || key === null) return super.add(scope, jobs, opts);
    const waiting = await this.list(scope, { state: 'waiting', offset: 0, limit: 1000, order: 'asc' });
    const delayed = await this.list(scope, { state: 'delayed', offset: 0, limit: 1000, order: 'asc' });
    if ([...waiting, ...delayed].some((j) => j.singletonHeld && j.singletonKey === key)) return super.add(scope, jobs, opts);
    await yieldToLoop();
    const out = await super.add(scope, jobs, opts);
    if (out[0]?.status !== 'duplicate' || out[0].by !== 'singletonKey') return out;
    // the key looked free: insert the job anyway, without the hold
    return super.add(scope, [{ ...jobs[0]!, singletonKey: null }], opts);
  }
}

export const nonAtomicSingleton = inject(
  'nonAtomicSingleton',
  ['add'],
  ['singleton: concurrent adds of the same key create exactly one job'],
  NonAtomicSingleton,
);
