import { MemoryStore, type RedriveOutcome, type RedriveRequest, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// Redrives without checking the job is failed: a job that is not failed is forced to failed and redriven anyway,
// so a second redrive of the same job wins too.
class UnconditionalRedrive extends MemoryStore {
  override async redrive(scope: Scope, req: RedriveRequest): Promise<RedriveOutcome[]> {
    const out = await super.redrive(scope, req);
    return Promise.all(out.map(async (o) => {
      if (o.status !== 'skipped' || o.reason !== 'not-failed') return o;
      this.unsafeMutate(scope, o.id, { state: 'failed' });
      return (await super.redrive(scope, { ids: [o.id], limit: 1 }))[0]!;
    }));
  }
}

export const unconditionalRedrive = inject(
  'unconditionalRedrive',
  ['redrive'],
  ['dlq: concurrent redrives of one job produce exactly one redriven', 'dlq: redrive of a non-failed job is skipped not-failed'],
  UnconditionalRedrive,
);
