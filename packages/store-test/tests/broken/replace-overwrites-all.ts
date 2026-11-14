import { MemoryStore, type AddOutcome, type NewJob, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// A replace writes every field: unset ones get their insert defaults and `defaulted` is ignored.
class ReplaceOverwritesAll extends MemoryStore {
  override async add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    const all = jobs.map((job) => {
      if (job.onDuplicate !== 'replace') return job;
      const { defaulted: _ignored, ...rest } = job;
      return { name: null, priority: 0, dataVersion: null, backoff: null, idempotencyKey: null, ...rest };
    });
    return super.add(scope, all, opts);
  }
}

export const replaceOverwritesAll = inject(
  'replaceOverwritesAll',
  ['add'],
  ["contract: replace overwrites only specified fields, never lowers maxAttempts below attempt and keeps a retry job's runAt"],
  ReplaceOverwritesAll,
);
