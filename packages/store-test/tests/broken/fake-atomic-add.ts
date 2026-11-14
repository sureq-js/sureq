import { MemoryStore, type AddOutcome, type NewJob, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// Declares transactions but writes an atomic batch one job at a time.
class FakeAtomicAdd extends MemoryStore {
  override async add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    if (!opts?.atomic) return super.add(scope, jobs, opts);
    const out: AddOutcome[] = [];
    for (const job of jobs) {
      try {
        out.push(...(await super.add(scope, [job])));
      } catch {
        out.push({ status: 'not-applied' });
      }
    }
    return out;
  }
}

export const fakeAtomicAdd = inject(
  'fakeAtomicAdd',
  ['add'],
  ['capabilities: transactions true — atomic add is all or nothing', 'contract: add atomic with a rejected duplicate writes nothing'],
  FakeAtomicAdd,
);
