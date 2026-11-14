import {
  MemoryStore, type AddOutcome, type CancelResult, type CompleteResult, type FailRequest, type FailResult, type JobRecord, type NewJob,
  type Payload, type ReleaseRequest, type ReleaseResult, type RemoveResult, type Scope, type UpdateRequest, type UpdateResult,
} from '@sureq/core';
import { inject } from './inject.js';

// Every seventh write (counting add inputs one by one) is acknowledged but not applied.
class LostWrites extends MemoryStore {
  #writes = 0;
  #drop(): boolean {
    return ++this.#writes % 7 === 0;
  }
  override async add(scope: Scope, jobs: NewJob[], opts?: { atomic?: boolean }): Promise<AddOutcome[]> {
    const keep = jobs.map(() => !this.#drop());
    const added = await super.add(scope, jobs.filter((_, i) => keep[i]), opts);
    const now = await this.now();
    return jobs.map((job, i) => (keep[i] ? added.shift()! : { status: 'added', job: fake(scope, job, now) }));
  }
  override async complete(scope: Scope, req: { id: string; token: number; result: Payload | null }): Promise<CompleteResult> {
    return this.#drop() ? { ok: true, now: await this.now() } : super.complete(scope, req);
  }
  override async fail(scope: Scope, req: FailRequest): Promise<FailResult> {
    if (!this.#drop()) return super.fail(scope, req);
    const now = await this.now();
    return req.retryInMs === undefined ? { ok: true, state: 'failed', now } : { ok: true, state: 'delayed', runAt: now + req.retryInMs, now };
  }
  override async release(scope: Scope, req: ReleaseRequest): Promise<ReleaseResult> {
    if (!this.#drop()) return super.release(scope, req);
    const now = await this.now();
    return { ok: true, state: req.delayMs ? 'delayed' : 'waiting', runAt: now + (req.delayMs ?? 0), now };
  }
  override async cancel(scope: Scope, req: { id: string }): Promise<CancelResult> {
    return this.#drop() ? { ok: true, previousState: 'waiting' } : super.cancel(scope, req);
  }
  override async remove(scope: Scope, req: { id: string }): Promise<RemoveResult> {
    return this.#drop() ? { removed: true, previousState: 'completed' } : super.remove(scope, req);
  }
  override async update(scope: Scope, req: UpdateRequest): Promise<UpdateResult> {
    if (!this.#drop()) return super.update(scope, req);
    const job = await this.get(scope, req.id);
    return job ? { ok: true, job } : { ok: false, reason: 'not-found' };
  }
  override async setPaused(scope: Scope, paused: boolean): Promise<{ changed: boolean }> {
    return this.#drop() ? { changed: true } : super.setPaused(scope, paused);
  }
}

function fake(scope: Scope, job: NewJob, now: number): JobRecord {
  const runAt = job.runAt ?? now + (job.delayMs ?? 0);
  return {
    formatVersion: job.formatVersion, namespace: scope.namespace, queue: scope.queue, id: job.id, name: job.name ?? null, data: job.data,
    dataVersion: job.dataVersion ?? null, state: runAt > now ? 'delayed' : 'waiting', priority: job.priority ?? 0, seq: 0, runAt, attempt: 0,
    maxAttempts: job.maxAttempts, crashCount: 0, lease: null, token: 0, lastFinal: null, result: null, error: null, backoff: job.backoff ?? null, timeout: job.timeout ?? null,
    idempotencyKey: job.idempotencyKey ?? null, workerId: null, uniqueWhile: job.uniqueWhile ?? 'pending', singletonKey: job.singletonKey ?? null,
    singletonHeld: false, rev: 1, createdAt: now, startedAt: null, finishedAt: null, deadLetter: null, retainUntil: null, keep: null,
    progress: null, batchProgress: null, redriveCount: 0, lastError: null, attemptsTruncated: 0, scheduleKey: null, scheduledFor: null,
    cancelReason: null,
  };
}

export const lostWrites = inject(
  'lostWrites',
  ['add', 'complete', 'fail', 'release', 'cancel', 'remove', 'update', 'setPaused'],
  ['contract: add returns one outcome per input in order', 'contract: counts equal list totals per state after a mixed workload'],
  LostWrites,
);
