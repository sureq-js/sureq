import { MemoryStore, type AddOutcome, type NewJob, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// seq is max(seq) + 1 (min(seq) - 1 for first) over the rows still stored, so a deleted job's seq comes back.
class ReusesSeq extends MemoryStore {
  override async add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    const out = await super.add(scope, jobs, opts);
    // read and rewrite in one synchronous step, so concurrent adds still get distinct values
    const mine = new Set(out.flatMap((o) => (o.status === 'added' ? [o.job.id] : [])));
    const others = this.dump().jobs.filter((j) => j.namespace === scope.namespace && j.queue === scope.queue && !mine.has(j.id)).map((j) => j.seq);
    let high = others.reduce((a, b) => Math.max(a, b), 0);
    let low = others.reduce((a, b) => Math.min(a, b), 0);
    return out.map((o, i): AddOutcome => {
      if (o.status !== 'added') return o;
      const seq = jobs[i]!.first ? --low : ++high;
      this.unsafeMutate(scope, o.job.id, { seq });
      return { status: 'added', job: { ...o.job, seq } };
    });
  }
}

export const reusesSeq = inject(
  'reusesSeq',
  ['add'],
  ['idem: seq is never reused after remove, clean or first true, so the default key stays unique'],
  ReusesSeq,
);
