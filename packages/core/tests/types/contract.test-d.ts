import { describe, expectTypeOf, it } from 'vitest';
import { Queue, STORE_CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS } from '../../src/index.js';
import type {
  AddOutcome, CancelResult, ClaimBlocked, ClaimRequest, ClaimResult, CompleteRequest, CompleteResult, DeadLetterInfo,
  DeleteScheduleResult, FailRequest, FailResult, FireScheduleRequest, FireScheduleResult, GetAttemptsResult, JobCounts, JobRecord,
  JobState, ListRequest, ListWorkersResult, NamespaceScope, NewJob, Payload, PutScheduleRequest, PutScheduleResult, RedriveOutcome,
  ReleaseRequest, ReleaseResult, RemoveResult, RenewRequest, RenewResult, ScheduleRecord, Scope, StatsResult, Store,
  StoreCapabilities, StoreMeta, StoreTime, SweepRequest, SweepResult, UpdateRequest, UpdateResult,
} from '../../src/index.js';

describe('contract', () => {
  it('contract: Store has exactly the documented methods and subscribe is optional', () => {
    expectTypeOf<keyof Store>().toEqualTypeOf<
      'contractVersion' | 'capabilities' | 'open' | 'close' | 'now' | 'add' | 'claim' | 'renew' | 'complete' | 'fail' |
      'release' | 'sweep' | 'cancel' | 'remove' | 'update' | 'get' | 'list' | 'counts' | 'setPaused' | 'isPaused' | 'subscribe' |
      'stats' | 'getAttempts' | 'clean' | 'obliterate' | 'redrive' | 'setProgress' | 'registerWorker' | 'heartbeatWorker' |
      'unregisterWorker' | 'listWorkers' | 'purgeWorkers' | 'ensureNamespaceMeta' | 'getNamespaceMeta' | 'putSchedule' |
      'getSchedule' | 'listSchedules' | 'deleteSchedule' | 'listDueSchedules' | 'fireSchedule'
    >();
    expectTypeOf<Store['subscribe']>().toEqualTypeOf<((scope: Scope, onWake: () => void) => Promise<() => Promise<void>>) | undefined>();
    expectTypeOf<ReturnType<Store['claim']>>().toEqualTypeOf<Promise<ClaimResult>>();
    expectTypeOf<ReturnType<Store['renew']>>().toEqualTypeOf<Promise<RenewResult>>();
    expectTypeOf<ReturnType<Store['complete']>>().toEqualTypeOf<Promise<CompleteResult>>();
    expectTypeOf<ReturnType<Store['fail']>>().toEqualTypeOf<Promise<FailResult>>();
    expectTypeOf<ReturnType<Store['release']>>().toEqualTypeOf<Promise<ReleaseResult>>();
    expectTypeOf<ReturnType<Store['sweep']>>().toEqualTypeOf<Promise<SweepResult>>();
    expectTypeOf<ReturnType<Store['cancel']>>().toEqualTypeOf<Promise<CancelResult>>();
    expectTypeOf<ReturnType<Store['remove']>>().toEqualTypeOf<Promise<RemoveResult>>();
    expectTypeOf<ReturnType<Store['update']>>().toEqualTypeOf<Promise<UpdateResult>>();
    expectTypeOf<ReturnType<Store['add']>>().toEqualTypeOf<Promise<AddOutcome[]>>();
    expectTypeOf<ReturnType<Store['get']>>().toEqualTypeOf<Promise<JobRecord | null>>();
    expectTypeOf<ReturnType<Store['list']>>().toEqualTypeOf<Promise<JobRecord[]>>();
    expectTypeOf<ReturnType<Store['counts']>>().toEqualTypeOf<Promise<JobCounts>>();
    expectTypeOf<ReturnType<Store['now']>>().toEqualTypeOf<Promise<StoreTime>>();
    expectTypeOf<ReturnType<Store['stats']>>().toEqualTypeOf<Promise<StatsResult>>();
    expectTypeOf<ReturnType<Store['getAttempts']>>().toEqualTypeOf<Promise<GetAttemptsResult>>();
    expectTypeOf<ReturnType<Store['redrive']>>().toEqualTypeOf<Promise<RedriveOutcome[]>>();
    expectTypeOf<ReturnType<Store['fireSchedule']>>().toEqualTypeOf<Promise<FireScheduleResult>>();
    expectTypeOf<ReturnType<Store['getNamespaceMeta']>>().toEqualTypeOf<Promise<StoreMeta | null>>();
    expectTypeOf<ReturnType<Store['listWorkers']>>().toEqualTypeOf<Promise<ListWorkersResult>>();
    expectTypeOf<Parameters<Store['ensureNamespaceMeta']>[0]>().toEqualTypeOf<NamespaceScope>();
    expectTypeOf<Parameters<Store['complete']>[1]>().toEqualTypeOf<CompleteRequest>();
  });

  it('contract: JobRecord has exactly the documented fields', () => {
    expectTypeOf<keyof JobRecord>().toEqualTypeOf<
      'formatVersion' | 'namespace' | 'queue' | 'id' | 'name' | 'data' | 'dataVersion' | 'state' | 'priority' | 'seq' |
      'runAt' | 'attempt' | 'maxAttempts' | 'crashCount' | 'lease' | 'token' | 'lastFinal' | 'result' | 'error' | 'backoff' | 'timeout' |
      'idempotencyKey' | 'workerId' | 'uniqueWhile' | 'singletonKey' | 'singletonHeld' | 'rev' | 'createdAt' | 'startedAt' | 'finishedAt' |
      'deadLetter' | 'retainUntil' | 'keep' | 'progress' | 'batchProgress' | 'redriveCount' | 'lastError' | 'attemptsTruncated' |
      'scheduleKey' | 'scheduledFor' | 'cancelReason'
    >();
    expectTypeOf<JobRecord['data']>().toEqualTypeOf<Payload>();
    expectTypeOf<NonNullable<JobRecord['lease']>['held']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<JobRecord['deadLetter']>().toEqualTypeOf<DeadLetterInfo | null>();
    expectTypeOf<JobRecord['cancelReason']>().toEqualTypeOf<'user' | null>();
    expectTypeOf<NonNullable<JobRecord['lastFinal']>['kind']>().toEqualTypeOf<'complete' | 'fail' | 'release'>();
  });

  it('contract: NewJob requires only id, data, formatVersion and maxAttempts', () => {
    const ok: NewJob = { id: 'a', data: 'x', formatVersion: 1, maxAttempts: 1 };
    void ok;
    // @ts-expect-error maxAttempts is required
    const bad: NewJob = { id: 'a', data: 'x', formatVersion: 1 };
    void bad;
    expectTypeOf<keyof NewJob>().toEqualTypeOf<
      'id' | 'name' | 'data' | 'dataVersion' | 'formatVersion' | 'priority' | 'first' | 'delayMs' | 'runAt' | 'maxAttempts' |
      'backoff' | 'timeout' | 'idempotencyKey' | 'uniqueWhile' | 'onDuplicate' | 'singletonKey' | 'defaulted' | 'keep'
    >();
  });

  it('contract: results are discriminated unions that narrow on ok, removed and status', () => {
    type Fenced = 'superseded' | 'expired' | 'not-active';
    const c = {} as CompleteResult;
    if (c.ok) expectTypeOf(c.now).toEqualTypeOf<StoreTime>();
    else expectTypeOf(c.reason).toEqualTypeOf<Fenced>();
    const r = {} as RenewResult;
    if (r.ok) expectTypeOf(r.expiresAt).toEqualTypeOf<StoreTime>();
    else expectTypeOf(r.reason).toEqualTypeOf<Fenced>();
    const f = {} as FailResult;
    if (f.ok) expectTypeOf(f.state).toEqualTypeOf<'delayed' | 'failed'>();
    else expectTypeOf(f.reason).toEqualTypeOf<Fenced>();
    const l = {} as ReleaseResult;
    if (l.ok) expectTypeOf(l.state).toEqualTypeOf<'waiting' | 'delayed'>();
    else expectTypeOf(l.reason).toEqualTypeOf<Fenced>();
    const m = {} as RemoveResult;
    if (m.removed) expectTypeOf(m.previousState).toEqualTypeOf<JobState>();
    else expectTypeOf(m.reason).toEqualTypeOf<'not-found' | 'active'>();
    const a = {} as AddOutcome;
    if (a.status === 'added') expectTypeOf(a.job).toEqualTypeOf<JobRecord>();
    else if (a.status === 'duplicate') expectTypeOf(a.by).toEqualTypeOf<'id' | 'singletonKey'>();
    else expectTypeOf(a).toEqualTypeOf<{ status: 'not-applied' }>();
  });

  it('contract: the new result types narrow on ok, deleted, status and outcome', () => {
    const d = {} as DeleteScheduleResult;
    if (d.deleted) expectTypeOf(d).toEqualTypeOf<{ deleted: true }>();
    else expectTypeOf(d.reason).toEqualTypeOf<'not-found' | 'conflict'>();
    const r = {} as RedriveOutcome;
    if (r.status === 'redriven') {
      expectTypeOf(r.viaDeadLetter).toEqualTypeOf<boolean>();
      expectTypeOf(r.state).toEqualTypeOf<'waiting' | 'delayed'>();
    } else expectTypeOf(r.reason).toEqualTypeOf<'not-failed' | 'not-found' | 'duplicate-id'>();
    const p = {} as PutScheduleResult;
    if (p.ok) expectTypeOf(p.schedule).toEqualTypeOf<ScheduleRecord>();
    else expectTypeOf(p.reason).toEqualTypeOf<'conflict' | 'exists'>();
    const f = {} as FireScheduleResult;
    if (f.outcome === 'fired') expectTypeOf(f.jobId).toEqualTypeOf<string>();
    if (f.outcome === 'busy') expectTypeOf(f).toEqualTypeOf<{ outcome: 'busy' }>();
    expectTypeOf<RenewRequest['batchId']>().toEqualTypeOf<string | undefined>();
  });

  it('contract: later-release members are not declared', () => {
    const base = { workerId: 'w', limit: 1, leaseMs: 1, claimId: 'c' };
    const job: NewJob = { id: 'a', data: 'x', formatVersion: 1, maxAttempts: 1 };
    // @ts-expect-error only shutdown and pause are declared
    const c: ReleaseRequest = { id: 'a', token: 1, refundAttempt: false, handlerStarted: false, reason: 'gate' };
    // @ts-expect-error only paused is declared
    const d: ClaimBlocked = { reason: 'gate' };
    // @ts-expect-error flow-failed is not declared
    const e: CompleteResult = { ok: false, reason: 'flow-failed', now: 1 };
    // @ts-expect-error dataVersion is not patchable
    const g: UpdateRequest = { id: 'a', expectedRev: 1, patch: { dataVersion: 1 } };
    // @ts-expect-error ids is not a list filter
    const h: ListRequest = { state: 'waiting', offset: 0, limit: 1, order: 'asc', ids: ['a'] };
    // @ts-expect-error tags is not a list filter
    const i: ListRequest = { state: 'waiting', offset: 0, limit: 1, order: 'asc', tags: ['a'] };
    // @ts-expect-error deadlineError is not declared
    const j: FailRequest = { id: 'a', token: 1, error: 'x', deadlineError: 'x' };
    // @ts-expect-error metrics is not declared
    const k: CompleteRequest = { id: 'a', token: 1, result: null, metrics: {} };
    // @ts-expect-error firstJob is not declared
    const l: PutScheduleRequest = { schedule: {} as PutScheduleRequest['schedule'], expectedRev: null, firstJob: job };
    // @ts-expect-error jobs is not declared
    const m: FireScheduleRequest = { key: 'k', expectedRev: 1, mode: 'backlog', job, jobs: [job] };
    // @ts-expect-error advanced is not an outcome
    const n: FireScheduleResult = { outcome: 'advanced' };
    // @ts-expect-error constraints is not declared
    const o: ClaimRequest = { ...base, constraints: {} };
    void [c, d, e, g, h, i, j, k, l, m, n, o];
  });

  it('contract: handlerStarted is required on ReleaseRequest', () => {
    expectTypeOf<ReleaseRequest['handlerStarted']>().toEqualTypeOf<boolean>();
    // @ts-expect-error handlerStarted is required
    const r: ReleaseRequest = { id: 'a', token: 1, refundAttempt: false };
    void r;
  });

  it('contract: a minimal object literal satisfies Store', () => {
    const unused = async (): Promise<never> => {
      throw new TypeError('unused');
    };
    const store: Store = {
      contractVersion: 1,
      capabilities: {} as StoreCapabilities,
      open: async () => {}, close: async () => {}, now: async () => 0,
      add: unused, claim: unused, renew: unused, complete: unused, fail: unused, release: unused, sweep: unused,
      cancel: unused, remove: unused, update: unused, get: async () => null, list: async () => [],
      counts: unused, setPaused: async () => ({ changed: false }), isPaused: async () => false,
      stats: unused, getAttempts: unused, clean: unused, obliterate: unused, redrive: unused, setProgress: unused,
      registerWorker: unused, heartbeatWorker: unused, unregisterWorker: unused, listWorkers: unused, purgeWorkers: unused,
      ensureNamespaceMeta: unused, getNamespaceMeta: unused, putSchedule: unused, getSchedule: unused, listSchedules: unused,
      deleteSchedule: unused, listDueSchedules: unused, fireSchedule: unused,
    };
    void store;
  });

  it('contract: types are exported from the package entry', () => {
    expectTypeOf<SweepRequest['failError']>().toEqualTypeOf<Payload>();
    expectTypeOf<ListRequest['order']>().toEqualTypeOf<'asc' | 'desc'>();
    expectTypeOf<FailRequest['retryInMs']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<JobCounts['blocked']>().toEqualTypeOf<number>();
  });

  it('contract: version values are typed number, so a later version is not a breaking type change', () => {
    expectTypeOf(STORE_CONTRACT_VERSION).toEqualTypeOf<number>();
    expectTypeOf(SUPPORTED_CONTRACT_VERSIONS).toEqualTypeOf<readonly [number, number]>();
    expectTypeOf<Queue['formatVersion']>().toEqualTypeOf<number>();
  });
});
