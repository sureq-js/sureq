import {
  BulkAddError, CapabilityError, DuplicateJobError, FilterError, InternalError, JobRejectedError, InvalidMergeResultError, InvalidJobStateError, InvalidOptionError,
  JobNotFoundError, PayloadTooLargeError, QueueClosedError, StoreError, StoreNotReadyError, type ConfigIssue, type StoreUnavailableError,
} from '../errors/catalog.js';
import { TypedEmitter } from '../events/emitter.js';
import type { Jsonify } from '../serialize/jsonify.js';
import type { QueueEvents, Unsubscribe } from '../events/types.js';
import { toJob, type Job, type JobBinding } from '../job/job.js';
import { serializeValue } from '../serialize/value.js';
import { createLogger, type Logger } from '../logger/logger.js';
import { createReporter } from '../events/report.js';
import { FORMAT_VERSION } from '../store/memory/format.js';
import { clientFor, isUnavailable, type ConnectionState, type StoreClient } from '../store/client.js';
import { AddGate, resolveAmbiguousAdd } from './outage.js';
import { PauseFlag } from './pause.js';
import type { AddOutcome, CleanableState, DeadLetterReason, JobCounts, JobRecord, JobState, ListRequest, NewJob, RedriveOutcome, Scope, Store } from '../store/contract.js';
import { JOB_STATES } from '../util/job-states.js';
import { uuidv7 } from '../util/uuidv7.js';
import type { Duration } from '../util/duration.js';
import {
  bulkOptionsSchema, resolveJobOptions, POLL_DEFAULTS, RELEASE_MIN_MS,
  type AddOptions, type BulkOptions, type ResolvedJobOptions, type ResolvedQueueOptions,
} from './options.js';
import { DrainedLatch } from './drained.js';
import { readAllAttempts, readAttempts, type AttemptPage } from '../history/attempts.js';
import {
  countDeadLetters, getDeadLetters, redrive, redriveAll, retryJob, type AdminHost, type RedriveOptions, type RedriveSummary,
} from '../admin/redrive.js';
import { cleanJobs, drainJobs } from '../admin/clean.js';
import { finishExt } from '../retention/policy.js';
import { obliterateQueue } from '../admin/obliterate.js';
import { buildHealth, type HealthHost, type HealthReport } from '../health/health.js';
import {
  buildNewJob, computeMerge, draftRecord, type ComputedMerge, MAX_KEY_BYTES, MERGE_TRIES, mergeInto, resolveId, validateKey, type MergeContext, type MergeFn,
} from './add.js';
import { deepFreeze } from '../util/freeze.js';
import { BULK_FILTER_CONCURRENCY, makeFilter, mapLimit, type FilterContext, type Serialized } from './filter.js';
import { validate, type Schema } from '../util/validate.js';
import { parseTiming, upcoming, type ScheduleTiming } from '../scheduler/timing.js';
import { ScheduleManager, type Schedule, type ScheduleDefinition, type UpsertResult } from '../scheduler/schedules.js';
import { isSureQError, type SureQError } from '../errors/base.js';
import { toWorkerInfos, type WorkerInfo } from '../registry/info.js';
import { Counter, NameLabels, SCOPES, storeSamples, type MetricSample, type MetricsSnapshot } from '../metrics/catalogue.js';
import { platform, type Timer } from '../platform/index.js';

/** One prepared input: the job for the store, plus core's merge function and the incoming data it merges. */
interface Prepared {
  newJob: NewJob;
  /** Store time read for this add; job snapshots are taken as of it. */
  now: number;
  /** The id is core's UUIDv7, not one the caller gave or computed. */
  generatedId: boolean;
  mergeFn?: MergeFn;
  incoming?: unknown;
  /** The merge an atomic `addBulk` computed before its write. */
  computed?: ComputedMerge;
  /** What the filter is told about a merged value: the add's name and options. */
  filterAs?: { name: string | null; opts: Readonly<AddOptions> };
}
/** The part of an `addBulk` done before its write; kept, so a resend after an outage does not run it again. */
interface BulkPrep {
  now: number;
  ids: string[];
  out: BulkOutcome<unknown, unknown>[];
  sent: number[];
  preps: Prepared[];
  dryDone: boolean;
}
/** What `addBulk` decided before the gate: the inputs that already failed, and each other input's options and own id. */
interface Early {
  out: BulkOutcome<unknown, unknown>[];
  checked: Array<{ policy: ResolvedJobOptions; ownId: string | undefined; serialized?: Serialized | undefined }>;
}
type Duplicate = Extract<AddOutcome, { status: 'duplicate' }>;
/** A store outcome, or a merge core did on top of it. */
type Outcome = AddOutcome | (Omit<Duplicate, 'action'> & { action: 'merged' });

/** What an add that met an existing job did, and why it matched. */
export interface DuplicateInfo {
  /** What the add did with the existing job. */
  action: 'ignored' | 'replaced' | 'merged';
  /** The existing job's state before this add. */
  existingState: JobState;
  /** What matched: the job `'id'` or its `'singletonKey'`. */
  by: 'id' | 'singletonKey';
}
/** What `add` resolves to: the stored job, and for a duplicate (`added: false`) what happened. */
export interface AddResult<D = unknown, R = unknown> {
  /** The job now holding the id: the new one, or the existing one when it was a duplicate. */
  job: Job<D, R>;
  /** False when the id or singleton key was already taken. */
  added: boolean;
  /** What happened to the existing job; set only when `added` is false. */
  duplicate?: DuplicateInfo;
}
/** What `cancel` resolves to: the job as stored after the call, and whether this call cancelled it. */
export type JobCancelResult<J = Job> =
  | { cancelled: true; previousState: 'waiting' | 'delayed' | 'active'; job: J }
  | { cancelled: false; reason: 'already-terminal'; state: 'completed' | 'failed' | 'cancelled'; job: J };
/** One `addBulk` input's outcome. */
export type BulkOutcome<D = unknown, R = unknown> = ({ ok: true } & AddResult<D, R>) | { ok: false; error: SureQError };

/** The settings, store client and scope a queue or producer works with. */
export type BaseInternals = Readonly<Omit<ResolvedQueueOptions, 'store' | 'logger' | 'filter' | 'metrics'>> & {
  readonly client: StoreClient;
  readonly scope: Scope;
  readonly ownsStore: boolean;
  readonly logger: Logger;
  /** The add pipeline: defaults, validation, serialization, size check, id. */
  readonly prepare: (data: unknown, opts: Record<string, unknown>) => Promise<NewJob>;
  /** The queue's filter on one input: resolves when accepted, else emits `rejected` and throws JobRejectedError or FilterError. */
  readonly filter: (data: unknown, ctx: Omit<FilterContext, 'queue'>) => Promise<Serialized | undefined>;
  /** @internal Decides when this queue object has just become empty (`drained`). */
  readonly drainedLatch: DrainedLatch;
  /** @internal Holds or rejects adds while the store is unreachable. */
  readonly addGate: AddGate;
  /** @internal The queue's global pause flag as last seen. */
  readonly isGloballyPaused: () => boolean;
  /** @internal Number a store read of the flag (a claim) just before sending it. */
  readonly pauseReadSeq: () => number;
  /** @internal A read numbered `seq` showed the flag; ignored when a newer read or this pod's own change came first. */
  readonly observePaused: (paused: boolean, seq: number) => void;
  /** @internal The flag is known set but a claim came back unpaused: read it from the store, at most once per pollMax. */
  readonly checkPaused: () => void;
  /** @internal The `name` label of every metric, bounded by `metrics.maxNameLabels`. */
  readonly names: NameLabels;
};

/** What both a `Queue` and a `Producer` offer: adding jobs, readiness, health and close. */
export interface QueueClient<D = unknown, R = unknown> {
  /** Store one job. */
  add(data: D, opts?: AddOptions<D>): Promise<AddResult<D, R>>;
  /** Store many jobs in one store call; one outcome per input, in order. */
  addBulk(items: ReadonlyArray<{ data: D; opts?: AddOptions<D> }>, opts?: BulkOptions): Promise<BulkOutcome<D, R>[]>;
  /** Resolve once the store is open and answering; rejects with `StoreNotReadyError` after `timeoutMs`. */
  ready(opts?: { timeoutMs?: number }): Promise<void>;
  /** Stop and release everything this object holds. */
  close(opts?: { timeoutMs?: number }): Promise<void>;
  /** A health report for liveness and readiness probes. */
  health(opts?: { timeoutMs?: number }): Promise<HealthReport>;
}

/**
 * What a subclass adds around the shared members: its workers, sweeper, alerts and pod metrics. Kept on an
 * instance field, not the prototype, so a producer's members are exactly its public ones.
 */
export interface QueueHooks {
  /** Jobs were added by this object: wake its workers. */
  onAdded(): void;
  /** This object cancelled a job: abort the attempt in its workers. */
  onCancelled(id: string): void;
  /** The global pause flag changed as this object saw it. */
  onPauseChange(paused: boolean, source: 'self' | 'observed'): void;
  /** This object resumed the queue: wake its workers. */
  onResumed(): void;
  /** Jobs were removed: anything cached about the counts is out of date. */
  onRemoved(): void;
  /** The health parts only a worker pod has. */
  health(): Partial<HealthHost>;
  /** Pod-observed samples beyond the add counters. */
  podSamples(): MetricSample[];
  /** Close has begun, before anything is refused: stop what must not emit after close. */
  beforeClose(): void;
  /**
   * Close the workers, subscription and scheduler, then wait for this object's pause read with `pauseChecked`;
   * resolves to the errors close reports.
   */
  close(opts: { timeoutMs?: number }, deadlines: CloseDeadlines): Promise<unknown[]>;
  /** Close has finished, just before `closed`. */
  onClosed(): void;
}

/** When close gives up on workers and store calls (pod-monotonic ms), and the wait for an in-flight pause read. */
export interface CloseDeadlines {
  giveUpAt: number;
  storeDeadline: number;
  pauseChecked(): Promise<void>;
}

/** What a producer does: nothing beyond the shared members. Copied into each object's own `hooks`. */
const NO_HOOKS: QueueHooks = {
  onAdded() {}, onCancelled() {}, onPauseChange() {}, onResumed() {}, onRemoved() {}, beforeClose() {},
  health: () => ({}), podSamples: () => [], close: async (_o, d) => (await d.pauseChecked(), []), onClosed() {},
};

/** The listing order the queue documents for each state. */
const LIST_ORDER: Record<JobState, Pick<ListRequest, 'orderBy' | 'order'>> = {
  waiting: { orderBy: 'seq', order: 'asc' },
  delayed: { orderBy: 'runAt', order: 'asc' },
  active: { orderBy: 'startedAt', order: 'asc' },
  completed: { orderBy: 'finishedAt', order: 'desc' },
  failed: { orderBy: 'finishedAt', order: 'desc' },
  cancelled: { orderBy: 'finishedAt', order: 'desc' },
};
const readySchema: Schema<{ timeoutMs?: number }> = { fields: { timeoutMs: { kind: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER } } };
const closeSchema = readySchema;
const previewSchema: Schema<{ n: number }> = { fields: { n: { kind: 'integer', min: 1, max: 100 } } };
const healthSchema: Schema<{ timeoutMs: number }> = { fields: { timeoutMs: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER, default: 2000 } } };
const getWorkersSchema: Schema<{ includeStale: boolean }> = { fields: { includeStale: { kind: 'boolean', default: false } } };
const READY_TIMEOUT_MS = 30_000;
/** One shared `ready()` attempt: retries until the store answers or every waiter gave up. */
interface ReadyAttempt {
  done: Promise<void>;
  waiters: number;
  stopped: boolean;
  last: unknown;
  /** Stop retrying; with `reason`, waiters reject with it at once. */
  stop(reason?: Error): void;
}
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
const pageSchema: Schema<{ offset: number; limit: number }> = {
  fields: {
    offset: { kind: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER, default: 0 },
    limit: { kind: 'integer', min: 0, max: MAX_PAGE, default: DEFAULT_PAGE },
  },
};

/** Wait for `p`, but not past `at` (pod-monotonic ms). Ref'd: a caller waits on it. */
export async function until(p: Promise<unknown>, at: number): Promise<void> {
  let timer: Timer | undefined;
  const expired = new Promise<void>((r) => (timer = platform.setTimer(r, Math.max(0, at - platform.monotonicMs()), { ref: true })));
  try {
    await Promise.race([p, expired]);
  } finally {
    timer?.cancel();
  }
}

/**
 * The members a `Queue` and a `Producer` share: add, read, control, schedule management, admin, health and close.
 * `E` is the events its `on`/`once`/`off` offer.
 */
export abstract class QueueBase<D = unknown, R = unknown, E extends keyof QueueEvents & string = keyof QueueEvents & string> implements QueueClient<D, R> {
  readonly #name: string;
  readonly #kind: 'queue' | 'producer';
  /** `Queue "<name>"` or `Producer "<name>"`, the scope of option errors. */
  readonly #label: string;
  /** @internal */
  protected readonly shared: BaseInternals;
  /** @internal */
  protected readonly events: TypedEmitter<QueueEvents<Job<D, R>, Jsonify<R>>>;
  /** @internal */
  protected readonly binding: JobBinding;
  /** @internal */
  protected readonly report: ReturnType<typeof createReporter>;
  /** @internal Filled in once by the subclass constructor, which then freezes it. */
  protected readonly hooks: QueueHooks = { ...NO_HOOKS };
  /** What the dead-letter reads and redrives use. */
  readonly #admin: AdminHost;
  /** Settles once every add call so far has entered the add gate (or failed before it). */
  #gateTail: Promise<void> = Promise.resolve();
  readonly #client: StoreClient;
  /** `close()` began: no new work. Reads keep working until `#closed`. */
  #stopping = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #ready: ReadyAttempt | undefined;
  readonly #offConnection: Unsubscribe;
  /** Aborted when the queue closes: ends waits for the store. */
  readonly #closeSignal = new AbortController();
  /** The global pause flag as this queue object last saw it. */
  readonly #paused = new PauseFlag((paused, source) => this.#emitPause(paused, source));
  /** Store reads of the flag are numbered when sent; `#pauseMark` is the newest applied, so a stale answer changes nothing. */
  #pauseSeq = 0;
  #pauseMark = 0;
  /** This object's pause and resume writes, one at a time, so their answers arrive in the order the store applied them. */
  #pauseWrites: Promise<unknown> = Promise.resolve();
  /** The confirming `isPaused` read in flight, and when the last one was sent. */
  #pauseCheck: Promise<void> | undefined;
  #pauseCheckAt = -Infinity;
  readonly #schedules: ScheduleManager;
  readonly #addedTotal = new Counter('sureq_jobs_added_total');
  readonly #rejectedTotal = new Counter('sureq_jobs_rejected_total');

  /** @internal Use `new Queue` or `new Producer`. */
  protected constructor(name: string, resolved: ResolvedQueueOptions, store: Store, owned: boolean, kind: 'queue' | 'producer') {
    // detect the runtime now: an unsupported one throws UnsupportedRuntimeError here, not from a later call
    void platform.name;
    const client = clientFor(store);
    client.attach(owned);
    const { initialDelay, maxDelay, factor, jitter } = resolved.reconnect;
    client.configure({ initialDelayMs: initialDelay, maxDelayMs: maxDelay, factor, jitter, random: resolved.random ?? Math.random }, resolved.storeCallTimeout);
    this.#client = client;
    this.#kind = kind;
    this.#label = `${kind === 'producer' ? 'Producer' : 'Queue'} "${name}"`;
    const logger = createLogger(resolved.logger === undefined ? undefined : resolved.logger);
    this.#name = name;
    if (resolved.retention.warning !== undefined) logger.warn(resolved.retention.warning, { queue: name });
    this.events = new TypedEmitter({ queue: name, logger });
    this.report = createReporter({
      emit: (e) => this.events.emit('error', e, { quiet: true }),
      logger,
      now: () => platform.monotonicMs(),
      queue: name,
    });
    const scope: Scope = Object.freeze({ namespace: resolved.namespace, queue: name });
    const { filter, metrics: metricsOpts, store: _store, ...rest } = resolved;
    const names = new NameLabels(metricsOpts.maxNameLabels, (msg) => logger.warn(msg, { queue: name }));
    this.shared = Object.freeze({
      ...rest,
      client,
      logger,
      ownsStore: owned,
      scope,
      prepare: async (data: unknown, addOpts: Record<string, unknown>) => (await this.#prepare(data, addOpts)).newJob,
      filter: makeFilter({
        fn: filter, timeoutMs: resolved.filterTimeoutMs, queue: name, logger,
        emit: (e, jobName) => {
          this.#rejectedTotal.inc({ ...scope, name: names.label(jobName) });
          this.events.emit('rejected', e);
        },
      }),
      drainedLatch: new DrainedLatch(() => client.call('counts', scope)),
      addGate: new AddGate(client, { onDisconnected: resolved.onDisconnected, maxWaitMs: resolved.maxWait, maxBufferedAdds: resolved.maxBufferedAdds }),
      isGloballyPaused: () => this.#paused.value,
      pauseReadSeq: () => ++this.#pauseSeq,
      observePaused: (paused: boolean, seq: number) => this.#observePaused(paused, seq),
      checkPaused: () => this.#checkPaused(),
      names,
    });
    this.#admin = {
      client, scope, toJob: (rec, now) => toJob(rec, now, this.binding), emit: (event, payload) => this.events.emit(event, payload as QueueEvents<Job<D, R>, Jsonify<R>>[typeof event]),
      drainedLatch: this.shared.drainedLatch,
      jobsLeft: () => this.#drained(),
      redriven: () => {
        this.hooks.onRemoved();
        this.hooks.onAdded();
      },
    };
    // job.remove() and job.cancel() are the queue's: same validation, error wrapping and drained evaluation.
    this.binding = {
      retry: (id, seq, o) => (this.#closed ? Promise.reject(this.#closedError()) : retryJob(this.#admin, id, seq, o)),
      remove: (id) => this.remove(id), cancel: (id) => this.cancel(id), deserialize: (s) => JSON.parse(s) as unknown,
      getAttempts: (id) => {
        if (this.#closed) return Promise.reject(this.#closedError());
        return readAllAttempts(client, scope, id);
      },
      get format() {
        return client.__formatSupport;
      },
    };
    this.#schedules = new ScheduleManager({
      client, scope, queue: name, maxPayloadBytes: resolved.maxPayloadBytes, logger,
      keyLimit: () => this.#keyLimit(),
      emit: (event, payload) => this.events.emit(event, payload),
      filter: this.shared.filter,
    });
    this.#offConnection = client.onConnection((e) => {
      if (e.type === 'disconnected') this.events.emit('storeDisconnected', { error: e.error });
      else this.events.emit('storeReconnected', { downForMs: e.downForMs, attempts: e.attempts });
    });
  }

  /** The shared state of this queue's store connection; `'closed'` once this queue is closed. */
  get connectionState(): ConnectionState {
    return this.#closed ? 'closed' : this.#client.state;
  }

  /** The queue name. */
  get name(): string {
    return this.#name;
  }

  /** The namespace. */
  get namespace(): string {
    return this.shared.namespace;
  }

  /** The stored record format this release writes. Typed `number` so a later format is not a type change. */
  get formatVersion(): number {
    return FORMAT_VERSION;
  }

  /**
   * Workers serving this queue, from every pod, judged by store time: live ones (heard from within three of their
   * heartbeat intervals), plus the rest flagged `stale` with `includeStale`; by `startedAt`, then `workerId`.
   */
  async getWorkers(opts: { includeStale?: boolean } = {}): Promise<WorkerInfo[]> {
    const { includeStale } = validate(`${this.#label}.getWorkers`, opts, getWorkersSchema);
    if (this.#closed) throw this.#closedError();
    const res = await this.#client.call('listWorkers', { namespace: this.shared.namespace }, { queue: this.#name });
    return toWorkerInfos(res, { includeStale });
  }

  /** The store's current time in epoch ms: one `now` call, nothing cached. */
  getStoreTime(): Promise<number> {
    if (this.#closed) return Promise.reject(this.#closedError());
    return this.#client.call('now');
  }

  /**
   * The next `n` (1-100, default 5) fire times of a timing, in epoch ms, from store now; an `every` grid is anchored
   * at store now. Throws InvalidOptionError for a bad timing or `n`; writes nothing.
   */
  async previewSchedule(timing: ScheduleTiming, n = 5): Promise<number[]> {
    if (this.#closed) throw this.#closedError();
    const scope = `${this.#label}.previewSchedule`;
    validate(scope, { n }, previewSchema);
    const now = await this.#client.call('now');
    return upcoming(parseTiming(scope, timing, now), now, now, n);
  }

  /**
   * Create the schedule `key` or bring it to `def` (idempotent and safe across pods): `created`, `updated`,
   * `unchanged`, or `stale` when a higher `version` is stored. The template is frozen here; queue defaults apply
   * when a job is made. Throws InvalidOptionError before any store call, ScheduleConflictError when writes keep racing.
   */
  upsertSchedule<T = D>(key: string, def: ScheduleDefinition<T>): Promise<UpsertResult<T>> {
    if (this.#stopping) return Promise.reject(this.#closedError());
    return this.#schedules.upsert(key, def);
  }

  /** One schedule of this queue, or null. */
  async getSchedule(key: string): Promise<Schedule | null> {
    if (this.#closed) throw this.#closedError();
    return this.#schedules.get(key);
  }

  /** One page of this queue's schedules in key order (`limit` 1-1000, default 100), optionally only `active` or `paused` ones. */
  async listSchedules(opts?: { cursor?: string; limit?: number; state?: 'active' | 'paused' }): Promise<{ schedules: Schedule[]; nextCursor: string | null }> {
    if (this.#closed) throw this.#closedError();
    return this.#schedules.list(opts);
  }

  /** Stop a schedule firing on every pod (idempotent); jobs it already made still run. ScheduleNotFoundError for an unknown key. */
  async pauseSchedule(key: string): Promise<Schedule> {
    if (this.#stopping) throw this.#closedError();
    return this.#schedules.pause(key);
  }

  /** Resume a paused schedule from its first tick after store now (idempotent); ticks missed while paused are not fired. */
  async resumeSchedule(key: string): Promise<Schedule> {
    if (this.#stopping) throw this.#closedError();
    return this.#schedules.resume(key);
  }

  /** Delete a schedule; jobs it already made are left alone. False when there was none. */
  async deleteSchedule(key: string): Promise<boolean> {
    if (this.#stopping) throw this.#closedError();
    return this.#schedules.delete(key);
  }

  /** The next `n` (1-100, default 5) fire times of a stored schedule, in epoch ms from store now; writes nothing. */
  async nextRuns(key: string, n?: number): Promise<number[]> {
    if (this.#closed) throw this.#closedError();
    return this.#schedules.nextRuns(key, n);
  }

  /**
   * Resolves once the store is open and answers one `now` call, retrying with backoff while it is
   * down. Concurrent calls share one attempt. Rejects StoreNotReadyError (the last failure as `cause`)
   * when `timeoutMs` (default 30 s) passes first.
   */
  async ready(opts: { timeoutMs?: number } = {}): Promise<void> {
    const { timeoutMs = READY_TIMEOUT_MS } = validate(`${this.#label}.ready`, opts, readySchema);
    if (this.#stopping) throw this.#closedError();
    const attempt = (this.#ready ??= this.#connect());
    attempt.waiters++;
    let timer: Timer | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = platform.setTimer(() => {
          const message = `${this.#kind} "${this.#name}": store not ready after ${timeoutMs} ms`;
          reject(new StoreNotReadyError(message, { timeoutMs, cause: attempt.last }));
        }, timeoutMs, { ref: true });
      });
      return await Promise.race([attempt.done, expired]);
    } finally {
      timer?.cancel();
      if (--attempt.waiters === 0) this.#dropReady(attempt);
    }
  }

  /**
   * A liveness and readiness report; never rejects at runtime. `live` never depends on the store; the
   * store check is one `now` call bounded by `timeoutMs` (default 2 s), skipped while not connected.
   * A store not opened yet is opened first, within the same `timeoutMs`.
   */
  async health(opts: { timeoutMs?: number } = {}): Promise<HealthReport> {
    let { timeoutMs } = validate(`${this.#label}.health`, opts, healthSchema);
    if (!this.#client.opened && !this.#stopping) {
      // A fresh queue opens its store on its first call; a probe must not report it as reconnecting.
      const started = platform.monotonicMs();
      await this.ready({ timeoutMs }).catch(() => {});
      timeoutMs = Math.max(1, timeoutMs - (platform.monotonicMs() - started));
    }
    return buildHealth({
      client: this.#client,
      // Before the first successful open the connection counts as reconnecting.
      state: () => (this.connectionState === 'connected' && !this.#client.opened ? 'reconnecting' : this.connectionState),
      workers: () => [],
      isPaused: () => this.#paused.value,
      isClosing: () => this.#stopping,
      format: () => {
        const { minReadable: min, maxReadable: max } = this.#client.__formatSupport;
        return { storeFormat: this.#client.formatOf(this.shared.namespace), supported: { min, max }, degraded: false };
      },
      scheduler: () => undefined,
      noSchedulerRunning: () => false,
      alerts: () => [],
      deadLetters: () => undefined,
      sweeper: () => undefined,
      ...this.hooks.health(),
    }, { timeoutMs });
  }

  /**
   * A snapshot of this queue's metrics (see `describeMetrics()`): `sureq_jobs` and the oldest waiting age from one store
   * read, shared by every pod; the rest are this pod's counters, histograms and window gauges. Scrape every pod and sum.
   */
  async metrics(): Promise<MetricsSnapshot> {
    if (this.#closed) throw this.#closedError();
    const { client, scope } = this.shared;
    const stats = await client.call('stats', scope, {});
    const samples = [...storeSamples(scope, stats), ...this.#addedTotal.samples(), ...this.#rejectedTotal.samples(), ...this.hooks.podSamples()];
    return { at: stats.now, scope: { ...SCOPES }, samples };
  }

  /** How long, in ms of store time, the oldest waiting job that is not blocked (a pause) has been due; null when none. */
  async getOldestWaitingAge(): Promise<number | null> {
    if (this.#closed) throw this.#closedError();
    const { oldestWaitingRunAt, now } = await this.#client.call('stats', this.shared.scope, {});
    return oldestWaitingRunAt === null ? null : Math.max(0, now - oldestWaitingRunAt);
  }

  #dropReady(attempt: ReadyAttempt, reason?: Error): void {
    attempt.stop(reason);
    if (this.#ready === attempt) this.#ready = undefined;
  }

  #connect(): ReadyAttempt {
    const stopped = new AbortController();
    let abort: (reason: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => (abort = reject));
    const attempt: ReadyAttempt = {
      done: Promise.resolve(),
      waiters: 0,
      stopped: false,
      last: undefined,
      stop: (reason) => {
        attempt.stopped = true;
        stopped.abort();
        if (reason) abort(reason);
      },
    };
    const loop = (async () => {
      // A failure starts the client's outage; its probe, on the reconnect schedule, says when to try again.
      while (!attempt.stopped) {
        try {
          await this.#client.open();
          // the format check first: a refused pod's later ready() calls answer from it without a store call
          await this.#client.checkFormat(this.shared.namespace);
          await this.#client.call('now');
          // The store answered: the outage is over now, not at the prober's next backoff probe.
          this.#client.markReachable();
          return;
        } catch (e) {
          // Only an unreachable store is waited out; any other failure is the answer.
          if (!isUnavailable(e)) throw e;
          attempt.last = e;
        }
        if (!(await this.#client.waitConnected(stopped.signal))) return;
      }
    })();
    // A stop with a reason (the queue closed) ends the wait even while an open hangs.
    attempt.done = Promise.race([loop, aborted]);
    attempt.done.catch(() => {}); // waiters see the rejection; nobody else must
    return attempt;
  }

  /** A global change: emitted here and on each worker of this queue object, unless closing. */
  #emitPause(paused: boolean, source: 'self' | 'observed'): void {
    if (this.#stopping) return;
    if (this.#kind === 'queue') this.events.emit(paused ? 'paused' : 'resumed', { scope: 'global', queue: this.#name, source, at: Date.now() });
    this.hooks.onPauseChange(paused, source);
  }

  /** True once `close()` has been called. */
  get closed(): boolean {
    return this.#stopping;
  }

  #closedError(): QueueClosedError {
    return new QueueClosedError(`${this.#kind} "${this.#name}" is closed`);
  }

  /**
   * Add one job. Options, a string id and the keys are checked at once; the rest goes through the
   * outage gate (sent now, held or refused while the store is away): prepare once (id, serialization,
   * size check), one store write under the duplicate rules, then core's merge function for a duplicate
   * id. Resolves after the write, emitting `added` or `duplicate`; a rejected duplicate throws
   * DuplicateJobError. A lost response is settled by id when core generated it; otherwise it rejects
   * with `jobIds`. Nothing is written when a check fails.
   */
  add(data: D, opts?: AddOptions<D>): Promise<AddResult<D, R>>;
  async add(data: unknown, opts: object = {}): Promise<AddResult<unknown, unknown>> {
    if (this.#stopping) throw this.#closedError();
    const { client, scope, addGate } = this.shared;
    const turn = this.#gateTurn();
    let prepared: Prepared | undefined;
    let ownId: string | undefined;
    let serialized: Serialized | undefined;
    const send = async () => {
      // Prepared once: a resend after the store came back keeps the same id.
      const p = (prepared ??= await this.#prepare(data, opts as Record<string, unknown>, { ownId, serialized }));
      this.shared.drainedLatch.addStarted();
      return (await client.call('add', scope, [p.newJob]))[0]!;
    };
    let entry: Promise<AddOutcome>;
    try {
      // Bad options fail at once, also while the store is unreachable; the real check runs again with the store's time.
      const early = this.#checkEarly(data, opts as Record<string, unknown>);
      ownId = early.ownId;
      // Filtered once, before the gate: a rejection needs no store, and a resend does not filter again.
      serialized = await this.#filter(data, opts, early.policy, ownId);
      await turn.ready();
      entry = addGate.run(send);
    } finally {
      turn.entered();
    }
    let outcome: AddOutcome;
    try {
      outcome = await entry;
    } catch (e) {
      if (!(e instanceof StoreError && e.outcomeUnknown) || !prepared) throw e;
      const p = prepared;
      // The write may have landed: once the store is back, look before sending again. A caller's id is never resent.
      const settled = isUnavailable(e) && p.generatedId
        ? await this.#resolveAmbiguous(p, e, send).catch(() => undefined)
        : undefined;
      if (!settled) {
        // Still unknown: give the caller the id to check.
        Object.defineProperty(e, 'jobIds', { value: [p.newJob.id], enumerable: true });
        e.details['jobIds'] = [p.newJob.id];
        throw e;
      }
      outcome = settled;
    }
    const [result] = this.#published([await this.#merge(prepared!, outcome)], prepared!.now);
    if (result instanceof DuplicateJobError) throw result;
    return result!;
  }

  /** Wait (at most `maxWait`) for the store, then settle an add whose outcome is unknown; undefined when it never came back. */
  async #resolveAmbiguous(p: Prepared, original: StoreUnavailableError, send: () => Promise<AddOutcome>): Promise<AddOutcome | undefined> {
    const { client, scope, maxWait } = this.shared;
    const waited = new AbortController();
    const timer = platform.setTimer(() => waited.abort(), maxWait, { ref: true });
    try {
      if (!(await client.waitConnected(AbortSignal.any([waited.signal, this.#closeSignal.signal])))) return undefined;
    } finally {
      timer?.cancel();
    }
    return resolveAmbiguousAdd({ get: (jobId) => client.call('get', scope, jobId), send }, p.newJob.id, p.generatedId, original);
  }

  /** The option checks that need no store: the options themselves, the id (an id function runs here, once) and the keys. */
  #checkEarly(data: unknown, addOpts: Record<string, unknown>): { policy: ResolvedJobOptions; ownId: string | undefined } {
    const policy = resolveJobOptions(this.shared.defaultJobOptions, addOpts, 0, this.shared);
    const keyLimit = this.#keyLimit();
    const ownId = resolveId(policy.idSpec, data, keyLimit);
    this.#checkKeys(policy, keyLimit);
    return { policy, ownId };
  }

  /**
   * Reserve this call's turn at the add gate. While the gate holds adds, a call enters it only after every
   * earlier call did, so a slow filter cannot reorder held adds; while it sends at once, nobody waits.
   */
  #gateTurn(): { ready(): Promise<void>; entered(): void } {
    const before = this.#gateTail;
    let entered!: () => void;
    const mine = new Promise<void>((r) => (entered = r));
    this.#gateTail = Promise.all([before, mine]).then(() => {});
    const { addGate } = this.shared;
    return { ready: () => (addGate.holding ? before : Promise.resolve()), entered };
  }

  /** The add's options over the queue defaults, as the filter sees them. */
  #filterOpts(opts: object): Readonly<AddOptions> {
    return Object.freeze({ ...this.shared.defaultJobOptions, ...opts });
  }

  /** Run the queue's filter on one add's data, as `'replace'` when the add replaces a holder. */
  #filter(data: unknown, opts: object, policy: ResolvedJobOptions, ownId: string | undefined): Promise<Serialized | undefined> {
    return this.shared.filter(data, {
      name: policy.name,
      id: ownId ?? null,
      opts: this.#filterOpts(opts),
      operation: policy.onDuplicate === 'replace' ? 'replace' : 'add',
    });
  }

  /** `singletonKey` and `idempotencyKey` sizes. */
  #checkKeys(policy: ResolvedJobOptions, keyLimit: number): void {
    if (policy.singletonKey !== undefined && policy.singletonKey !== null) validateKey(policy.singletonKey, 'singletonKey', keyLimit);
    if (policy.idempotencyKey !== undefined) validateKey(policy.idempotencyKey, 'idempotencyKey', MAX_KEY_BYTES);
  }

  /** Ids and singleton keys must also fit the store's own limit. */
  #keyLimit(): number {
    return Math.min(MAX_KEY_BYTES, this.shared.client.capabilities.limits.maxIdBytes);
  }

  /**
   * Add many jobs in one store write. Outcome `i` belongs to input `i`. An input that fails
   * validation, serialization or the size check gets `{ ok: false, error }` and is not sent.
   */
  async addBulk(items: ReadonlyArray<{ data: D; opts?: AddOptions<D> }>, opts: BulkOptions = {}): Promise<BulkOutcome<D, R>[]> {
    if (this.#stopping) throw this.#closedError();
    if (!Array.isArray(items)) throw new InvalidOptionError('addBulk', [{ path: 'items', code: 'invalid_type', message: 'expected an array of { data, opts? }' }]);
    const { atomic } = validate('addBulk', opts, bulkOptionsSchema);
    const { client, maxBulkSize } = this.shared;
    if (atomic && !client.capabilities.transactions) throw new CapabilityError('transactions', 'atomic addBulk needs a store with transactions');
    if (items.length > maxBulkSize) {
      const message = `expected at most ${maxBulkSize} inputs (maxBulkSize), received ${items.length}`;
      throw new InvalidOptionError('addBulk', [{ path: 'items', code: 'out_of_range', message }]);
    }
    if (items.length === 0) return [];
    const turn = this.#gateTurn();
    let entry: Promise<BulkOutcome<D, R>[]>;
    try {
      // Bad options are decided at once, also while the store is unreachable (checked again with the store's time).
      const early: Early = { out: [], checked: [] };
      for (const [i, item] of items.entries()) {
        try {
          early.checked[i] = this.#checkEarly(item.data, (item.opts ?? {}) as Record<string, unknown>);
        } catch (e) {
          if (!(e instanceof InvalidOptionError)) throw e;
          // Nothing was written and no id was assigned yet.
          if (atomic) throw new BulkAddError(`addBulk input ${i} failed: ${e.message}`, { index: i, jobIds: [], cause: e });
          early.out[i] = { ok: false, error: e };
        }
      }
      await this.#filterBulk(items, atomic, early);
      if (Object.keys(early.out).length === items.length) return early.out as BulkOutcome<D, R>[];
      await turn.ready();
      // One gate entry for the whole call: buffered or rejected as a whole.
      const memo: { prep?: BulkPrep } = {};
      entry = this.shared.addGate.run(() => this.#sendBulk(items, atomic, memo, early));
    } finally {
      turn.entered();
    }
    return entry;
  }

  /** Filter every input that passed the early checks, 16 at once; a refusal fills its slot (atomic: the first by index rejects the call). */
  async #filterBulk(items: ReadonlyArray<{ data: D; opts?: AddOptions<D> }>, atomic: boolean, early: Early): Promise<void> {
    const errors = await mapLimit(items, BULK_FILTER_CONCURRENCY, async (item, i) => {
      if (early.out[i]) return undefined;
      const checked = early.checked[i]!;
      try {
        checked.serialized = await this.#filter(item.data, item.opts ?? {}, checked.policy, checked.ownId);
        return undefined;
      } catch (e) {
        if (e instanceof JobRejectedError || e instanceof FilterError) return e;
        throw e;
      }
    });
    for (const [i, error] of errors.entries()) {
      if (!error) continue;
      if (atomic) throw new BulkAddError(`addBulk input ${i} failed: ${error.message}`, { index: i, jobIds: [], cause: error });
      early.out[i] = { ok: false, error };
    }
  }

  async #sendBulk(
    items: ReadonlyArray<{ data: D; opts?: AddOptions<D> }>, atomic: boolean, memo: { prep?: BulkPrep }, early: Early,
  ): Promise<BulkOutcome<D, R>[]> {
    const { client, scope } = this.shared;
    // Prepared once: a resend after the store came back keeps the ids and calls no id or merge function again.
    const prep = (memo.prep ??= await this.#prepareBulk(items, atomic, early));
    const { now, ids, sent, preps } = prep;
    const out = [...prep.out] as BulkOutcome<D, R>[];
    const jobs = preps.map((p) => p.newJob);
    if (atomic && !prep.dryDone) {
      await this.#dryMerge(preps, sent, ids, now);
      prep.dryDone = true;
    }
    if (jobs.length > 0) {
      let outcomes: AddOutcome[];
      try {
        this.shared.drainedLatch.addStarted();
        outcomes = atomic ? await client.call('add', scope, jobs, { atomic: true }) : await client.call('add', scope, jobs);
      } catch (e) {
        // Some or all may have landed: never guess, give the caller every id that was sent.
        if (e instanceof StoreError && e.outcomeUnknown) {
          throw new BulkAddError('addBulk store write outcome unknown; check the jobIds', { jobIds: jobs.map((j) => j.id), cause: e });
        }
        throw e;
      }
      const k = atomic ? outcomes.findIndex((o) => o.status === 'duplicate' && o.action === 'rejected') : -1;
      if (k >= 0) {
        // the store wrote nothing; no events for a call that did not happen
        const error = this.#duplicateError(outcomes[k] as Extract<AddOutcome, { status: 'duplicate' }>);
        throw new BulkAddError(`addBulk input ${sent[k]} is a rejected duplicate: ${error.message}`, { index: sent[k]!, jobIds: ids, cause: error });
      }
      // Merges run one by one in input order, so an in-call duplicate merges into the earlier input's job.
      // The batch is written: a failed merge costs only its own input, and every other input is still reported.
      const done: Array<{ i: number; o: Outcome }> = [];
      let failed: { index: number; cause: unknown } | undefined;
      for (const [n, i] of sent.entries()) {
        try {
          done.push({ i, o: await this.#merge(preps[n]!, outcomes[n]!) });
        } catch (e) {
          const error = isSureQError(e) ? e : new InvalidMergeResultError({ jobId: preps[n]!.newJob.id, cause: e });
          out[i] = { ok: false, error };
          failed ??= { index: i, cause: e };
        }
      }
      const results = this.#published(done.map((d) => d.o), now);
      for (const [k, { i }] of done.entries()) {
        const res = results[k]!;
        out[i] = res instanceof DuplicateJobError ? { ok: false, error: res } : { ok: true, ...res };
      }
      // atomic: the insert was committed (and reported above), but a merge into a stored job failed
      if (atomic && failed) {
        const message = `addBulk input ${failed.index} could not be merged: ${String((failed.cause as Error | undefined)?.message ?? failed.cause)}`;
        throw new BulkAddError(message, { index: failed.index, jobIds: ids, cause: failed.cause });
      }
    }
    return out;
  }

  /** Every input's id and job, before the write; an input that fails gets its outcome (atomic: the call rejects). */
  async #prepareBulk(items: ReadonlyArray<{ data: unknown; opts?: object | undefined }>, atomic: boolean, early: Early): Promise<BulkPrep> {
    // Every input gets its id before any work, so a failure can name them all.
    const now = await this.shared.client.call('now');
    const ids = items.map(() => uuidv7(now));
    const prep: BulkPrep = { now, ids, out: [], sent: [], preps: [], dryDone: false };
    for (const [i, item] of items.entries()) {
      const failed = early.out[i];
      if (failed) {
        prep.out[i] = failed;
        continue;
      }
      try {
        const prepared = await this.#prepare(item.data, (item.opts ?? {}) as Record<string, unknown>, { now, id: ids[i]!, ownId: early.checked[i]!.ownId, serialized: early.checked[i]!.serialized });
        ids[i] = prepared.newJob.id;
        prep.preps.push(prepared);
        prep.sent.push(i);
      } catch (e) {
        if (!isSureQError(e)) throw e;
        if (atomic) throw new BulkAddError(`addBulk input ${i} failed: ${e.message}`, { index: i, jobIds: ids, cause: e });
        prep.out[i] = { ok: false, error: e };
      }
    }
    return prep;
  }

  /**
   * Turn the store's outcomes into results, in write order: `added` for a new job, `duplicate` for one that
   * met an existing job (a rejected one becomes a DuplicateJobError, after its event).
   */
  #published(outcomes: Outcome[], now: number): Array<AddResult<D, R> | DuplicateJobError> {
    const results = outcomes.map((o) => {
      // only an atomic call that was refused returns not-applied, and that is handled before
      if (o.status === 'not-applied') throw new InternalError('Unexpected add outcome not-applied', { details: { status: o.status } });
      // a snapshot as of the store time read for this add (never earlier than the record's creation)
      const job = toJob<D, R>(o.job, Math.max(now, o.job.createdAt), this.binding);
      if (o.status === 'added') {
        const { scope, names } = this.shared;
        this.#addedTotal.inc({ ...scope, name: names.label(o.job.name) });
        this.events.emit('added', { job });
        return { job, added: true };
      }
      const { action, existingState, by } = o;
      this.events.emit('duplicate', { id: o.job.id, action, existingState, by });
      if (action === 'rejected') return this.#duplicateError(o as Duplicate);
      return { job, added: false, duplicate: { action, existingState, by } };
    });
    // Other Queue objects on the store are woken by its notifications, or find the job on their next poll.
    if (outcomes.some((o) => o.status === 'added')) this.hooks.onAdded();
    return results;
  }

  /** Write one job; when the outcome is unknown, the error carries its id so the caller can check. */
  async #storeAdd(newJob: NewJob): Promise<AddOutcome> {
    try {
      const [outcome] = await this.shared.client.call('add', this.shared.scope, [newJob]);
      return outcome!;
    } catch (e) {
      if (e instanceof StoreError && e.outcomeUnknown) {
        Object.defineProperty(e, 'jobIds', { value: [newJob.id], enumerable: true });
        e.details['jobIds'] = [newJob.id];
      }
      throw e;
    }
  }

  #duplicateError(o: Duplicate): DuplicateJobError {
    return new DuplicateJobError({ jobId: o.job.id, existingState: o.existingState, by: o.by });
  }

  #mergeContext(p: Prepared, budget: { left: number }): MergeContext {
    const { client, scope, maxPayloadBytes, filter } = this.shared;
    const { name, opts } = p.filterAs!;
    return {
      client, scope, queue: this.#name, id: p.newJob.id, mergeFn: p.mergeFn!, incoming: p.incoming, maxPayloadBytes, budget, computed: p.computed,
      toJob: (rec) => toJob(rec, Math.max(p.now, rec.createdAt), this.binding),
      check: async (merged) => { await filter(merged, { name, id: p.newJob.id, opts, operation: 'merge' }); },
    };
  }

  /** Apply core's merge function when the store found the id held by a waiting or delayed job; a key conflict never merges. */
  async #merge(p: Prepared, o: AddOutcome, budget = { left: MERGE_TRIES }): Promise<Outcome> {
    if (!p.mergeFn || o.status !== 'duplicate' || o.by !== 'id' || (o.existingState !== 'waiting' && o.existingState !== 'delayed')) return o;
    const r = await mergeInto(this.#mergeContext(p, budget), o.job);
    if (r.kind === 'readd') {
      // the id came free meanwhile: add again, with what is left of the same budget
      return this.#merge(p, await this.#storeAdd(p.newJob), budget);
    }
    return { status: 'duplicate', action: r.kind === 'merged' ? 'merged' : 'ignored', by: 'id', existingState: r.existingState, job: r.job };
  }

  /**
   * Atomic `addBulk`: compute every merge before the write (against the stored holder, or an earlier input of
   * the call), so a throwing or invalid merge rejects the call with nothing written.
   */
  async #dryMerge(preps: Prepared[], sent: number[], ids: string[], now: number): Promise<void> {
    if (!preps.some((p) => p.mergeFn)) return;
    const { client, scope } = this.shared;
    const seen = new Map<string, JobRecord | null>();
    for (const [n, p] of preps.entries()) {
      const id = p.newJob.id;
      const rec = seen.has(id) ? seen.get(id)! : await client.call('get', scope, id);
      const holds = rec !== null && (rec.uniqueWhile === 'retained' || rec.state === 'waiting' || rec.state === 'delayed' || rec.state === 'active');
      if (!holds) {
        seen.set(id, draftRecord(p.newJob, scope, now));
        continue;
      }
      seen.set(id, rec);
      if (!p.mergeFn || (rec.state !== 'waiting' && rec.state !== 'delayed')) continue;
      try {
        const json = await computeMerge(this.#mergeContext(p, { left: 1 }), rec);
        p.computed = { rev: rec.rev, base: rec.data, json };
        // the conditional write will raise rev by one
        seen.set(id, { ...rec, data: json, rev: rec.rev + 1 });
      } catch (e) {
        throw new BulkAddError(`addBulk input ${sent[n]} could not be merged: ${(e as Error).message}`, { index: sent[n]!, jobIds: ids, cause: e });
      }
    }
  }

  /** Read one job of this queue fresh from the store; `null` if it is unknown here. */
  async getJob(id: string): Promise<Job<D, R> | null> {
    if (this.#closed) throw this.#closedError();
    if (typeof id !== 'string') throw new InvalidOptionError('getJob', [{ path: 'id', code: 'invalid_type', message: 'expected a string job id' }]);
    const { client, scope } = this.shared;
    const rec = await client.call('get', scope, id);
    return rec ? toJob<D, R>(rec, await client.call('now'), this.binding) : null;
  }

  /**
   * One page of a job's attempt records, oldest first (`limit` 1 to 1000, default 100; `cursor` is the
   * `nextCursor` of the page before). `truncated` counts older records the per-job cap dropped. An unknown
   * id gives an empty page.
   */
  async getAttempts(jobId: string, opts: { limit?: number; cursor?: string } = {}): Promise<AttemptPage> {
    if (this.#closed) throw this.#closedError();
    return readAttempts(this.shared.client, this.shared.scope, jobId, opts);
  }

  /**
   * One page of dead letters (failed jobs kept with a reason), oldest dead letter first: `reason`, `olderThan` (by the
   * time it was dead-lettered), `limit` 1 to 1000 (default 100) and `cursor` (the `nextCursor` of the page before).
   */
  async getDeadLetters(opts?: { reason?: DeadLetterReason; olderThan?: Duration; limit?: number; cursor?: string }): Promise<{ jobs: Job<D, R>[]; nextCursor: string | null }> {
    if (this.#closed) throw this.#closedError();
    return getDeadLetters(this.#admin, opts) as Promise<{ jobs: Job<D, R>[]; nextCursor: string | null }>;
  }

  /** How many dead letters this queue holds, optionally of one reason. */
  async countDeadLetters(opts?: { reason?: DeadLetterReason }): Promise<number> {
    if (this.#closed) throw this.#closedError();
    return countDeadLetters(this.#admin, opts);
  }

  /**
   * Move failed jobs (dead letters or not) back to waiting, or delayed by `delay`: one conditional write per job, so
   * a job is redriven once however many calls race. Outcomes keep the input order. A single id whose dead letter was
   * superseded by a newer job with that id throws DuplicateJobError; in a list it is `skipped / duplicate-id`.
   */
  redrive(id: string, opts?: RedriveOptions): Promise<RedriveOutcome>;
  /** Redrive several jobs; one outcome per id, in input order. */
  redrive(ids: string[], opts?: RedriveOptions): Promise<RedriveOutcome[]>;
  async redrive(ids: string | string[], opts?: RedriveOptions): Promise<RedriveOutcome | RedriveOutcome[]> {
    if (this.#closed) throw this.#closedError();
    const single = !Array.isArray(ids);
    const out = await redrive(this.#admin, ids, opts, single);
    return single ? out[0]! : out;
  }

  /**
   * Redrive every dead letter matching `filter`, oldest first, `pageSize` (default 100) per store call, up to `limit`.
   * Not atomic: on a failure the jobs already redriven stay so, and running it again picks up the rest.
   */
  async redriveAll(filter?: { reason?: DeadLetterReason; olderThan?: Duration }, opts?: RedriveOptions & { limit?: number; pageSize?: number }): Promise<RedriveSummary> {
    if (this.#closed) throw this.#closedError();
    return redriveAll(this.#admin, filter, opts);
  }

  /**
   * One page of this queue's jobs in one state, in the store's documented order: waiting by
   * insertion (not claim order), delayed by runAt, active by start, finished ones newest first.
   */
  async getJobs(state: JobState, range: { offset?: number; limit?: number } = {}): Promise<Job<D, R>[]> {
    if (this.#closed) throw this.#closedError();
    const issues: ConfigIssue[] = [];
    if (!JOB_STATES.includes(state)) issues.push({ path: 'state', code: 'invalid_value', message: `expected one of ${JOB_STATES.join(', ')}` });
    let page = { offset: 0, limit: DEFAULT_PAGE };
    try {
      page = validate('getJobs', range, pageSchema);
    } catch (e) {
      if (!(e instanceof InvalidOptionError)) throw e;
      issues.push(...e.issues);
    }
    if (issues.length > 0) throw new InvalidOptionError('getJobs', issues);
    if (page.limit === 0) return [];
    const { client, scope } = this.shared;
    const recs = await client.call('list', scope, { state, ...page, ...LIST_ORDER[state] });
    const now = await client.call('now');
    return recs.map((rec) => toJob<D, R>(rec, now, this.binding));
  }

  /**
   * Delete one job of this queue that is not running: `true` if it was deleted, `false` if
   * it is unknown here. An active job is refused with InvalidJobStateError and left as it is.
   */
  async remove(id: string): Promise<boolean> {
    if (this.#closed) throw this.#closedError();
    if (typeof id !== 'string') throw new InvalidOptionError('remove', [{ path: 'id', code: 'invalid_type', message: 'expected a string job id' }]);
    const { client, scope } = this.shared;
    const res = await client.call('remove', scope, { id });
    if (!res.removed) {
      if (res.reason === 'active') throw new InvalidJobStateError({ jobId: id, state: 'active' });
      return false;
    }
    // Only a waiting or delayed job kept the queue from being empty; removing a finished one changes nothing.
    if (res.previousState === 'waiting' || res.previousState === 'delayed') {
      // Removing the last queued job empties the queue too.
      await this.#drained();
    }
    return true;
  }

  /**
   * Cancel a waiting, delayed or active job; it never runs (again) and its outcome is discarded. A handler
   * running in this queue object's workers is aborted at once with JobCancelledError; one running elsewhere
   * at its next store write. A finished job is left as it is (`cancelled: false`). Unknown id: JobNotFoundError.
   * Works while paused and without workers.
   */
  async cancel(id: string): Promise<JobCancelResult<Job<D, R>>> {
    if (this.#stopping) throw this.#closedError();
    if (typeof id !== 'string') throw new InvalidOptionError('cancel', [{ path: 'id', code: 'invalid_type', message: 'expected a string job id' }]);
    const { client, scope, history, retention } = this.shared;
    // Read first: the cancelled policy is resolved from the job's name and its own keep.
    const before = await client.call('get', scope, id);
    if (!before) throw new JobNotFoundError({ jobId: id });
    const ext = finishExt(retention, before, 'cancelled');
    // A discarding cancel leaves no record to read back, so its finish time is the store time read before the write.
    const discardAt = ext.retention?.discard === true ? await client.call('now') : undefined;
    // A producer keeps no history settings: it sends none, so the store only closes an open attempt record.
    const res = await client.call('cancel', scope, { id, ...(this.#kind === 'queue' && { history }), ...ext });
    if (!res.ok && res.reason === 'not-found') throw new JobNotFoundError({ jobId: id });
    // Also a worker closing on its own: its handlers still run.
    if (res.ok) this.hooks.onCancelled(id);
    // A cancel that deleted the job leaves only the record read before it. A concurrent remove can delete the record
    // between the calls: then it is unknown here, even though this call cancelled it.
    const rec = res.ok && discardAt !== undefined
      ? { ...before, state: 'cancelled' as const, lease: null, cancelReason: 'user' as const, finishedAt: discardAt }
      : await client.call('get', scope, id);
    if (!rec) throw new JobNotFoundError({ jobId: id });
    const job = toJob<D, R>(rec, rec.finishedAt ?? rec.createdAt, this.binding);
    if (!res.ok) return { cancelled: false, reason: 'already-terminal', state: rec.state as 'completed' | 'failed' | 'cancelled', job };
    if (this.#kind === 'queue') this.events.emit('cancelled', { job, previousState: res.previousState });
    // The job left the queue's pending set.
    await this.#drained();
    return { cancelled: true, previousState: res.previousState, job };
  }

  /**
   * Remove the jobs of one state (`completed`, `failed`, `cancelled`, `waiting` or `delayed`) that are at least `olderThan`
   * old by store time: finished jobs by when they finished, waiting and delayed ones by when they were added. Runs
   * `pageSize` (1 to 5000, default 500) per store call, up to `limit`; `done` is false only when `limit` stopped it.
   * Cleaning `failed` also removes the dead letters. Emits `cleaned` when it removed any. Destructive: cannot be undone.
   */
  async clean(state: CleanableState, olderThan: Duration, opts?: { limit?: number; pageSize?: number }): Promise<{ removed: number; done: boolean }> {
    if (this.#closed) throw this.#closedError();
    return this.#removed(await cleanJobs(this.#admin, state, olderThan, opts));
  }

  /** Remove every waiting job, and delayed ones too with `delayed: true`; running jobs are not touched. Destructive. */
  async drain(opts?: { delayed?: boolean; pageSize?: number }): Promise<{ removed: number }> {
    if (this.#closed) throw this.#closedError();
    return this.#removed(await drainJobs(this.#admin, opts));
  }

  /**
   * Delete the whole queue: every job, its attempt history, dead letters, schedules and settings, `pageSize` (default 500)
   * per store call. Refused with QueueNotIdleError while jobs run, unless `force` (their workers' later writes are then
   * refused). While it runs, other pods' adds, claims and sweeps are refused; a call that died part-way is finished by
   * calling it again. Refused (`mixed-versions`) while a registered pod runs an older release; a pod that never registered
   * cannot be seen, so finish a rolling upgrade first. Destructive: cannot be undone.
   */
  async obliterate(opts?: { force?: boolean; pageSize?: number }): Promise<{ removed: number }> {
    if (this.#closed) throw this.#closedError();
    return this.#removed(await obliterateQueue(this.#admin, opts));
  }

  /** After jobs were removed the last stats read is out of date: drop it, so health waits for the next tick's read. */
  #removed<T>(res: T): T {
    this.hooks.onRemoved();
    return res;
  }

  /** A job left the pending set: emit `drained` when the queue just became empty. A producer has no workers to tell, so reads nothing. */
  async #drained(): Promise<void> {
    if (this.#kind === 'producer') return;
    const { drainedLatch } = this.shared;
    drainedLatch.arm();
    await drainedLatch.evaluate(() => this.events.emit('drained', { queue: this.#name }));
  }

  /**
   * Pause the queue for every pod: the store flag is set, so no claim anywhere returns a job until
   * `resume()`. Running jobs finish; adds, reads and the sweeper go on. `changed` is false when it was
   * already paused.
   */
  async pause(): Promise<{ changed: boolean }> {
    return this.#setPaused(true);
  }

  /** Clear the global pause; this pod's workers claim at once, other pods on a notification or their next poll. */
  async resume(): Promise<{ changed: boolean }> {
    const res = await this.#setPaused(false);
    if (res.changed) this.hooks.onResumed();
    return res;
  }

  #setPaused(paused: boolean): Promise<{ changed: boolean }> {
    const write = this.#pauseWrites.then(() => this.#writePaused(paused));
    this.#pauseWrites = write.catch(() => {});
    return write;
  }

  async #writePaused(paused: boolean): Promise<{ changed: boolean }> {
    if (this.#stopping) throw this.#closedError();
    const { changed } = await this.#client.call('setPaused', this.shared.scope, paused);
    // Every read sent before this answer may predate the change: none of them may undo it.
    this.#pauseMark = ++this.#pauseSeq;
    // Already so in the store: this pod may not have known, but it is not this call's change.
    this.#paused.set(paused, changed ? 'self' : null);
    return { changed };
  }

  /** Read the global flag from the store (and take it as this pod's view); a newer change this pod already knows wins. */
  async pauseState(): Promise<{ paused: boolean }> {
    if (this.#closed) throw this.#closedError();
    const seq = ++this.#pauseSeq;
    const paused = await this.#client.call('isPaused', this.shared.scope);
    this.#observePaused(paused, seq);
    return { paused: this.#paused.value };
  }

  #observePaused(paused: boolean, seq: number): void {
    if (seq <= this.#pauseMark) return;
    this.#pauseMark = seq;
    this.#paused.set(paused, 'observed');
  }

  #checkPaused(): void {
    const every = this.shared.pollMax ?? POLL_DEFAULTS.pollMax;
    if (this.#pauseCheck || this.#stopping || this.#client.state !== 'connected' || platform.monotonicMs() - this.#pauseCheckAt < every) return;
    this.#pauseCheckAt = platform.monotonicMs();
    const seq = ++this.#pauseSeq;
    this.#pauseCheck = this.#client.call('isPaused', this.shared.scope).then(
      (paused) => this.#observePaused(paused, seq),
      (e: unknown) => {
        // Closing, or an outage the connection events already report: dropped quietly.
        if (this.#stopping || isUnavailable(e)) return;
        this.report(isSureQError(e) ? e : new InternalError('reading the pause flag failed', { cause: e }), 'store', { operation: 'isPaused' });
      },
    ).finally(() => (this.#pauseCheck = undefined));
  }

  /** The global flag as this pod last saw it (its own calls, claims, `pauseState()`); no store call. */
  isPaused(): boolean {
    return this.#paused.value;
  }

  /** Jobs per state, read from the store. Every state key is present; `blocked` counts waiting jobs held back by a pause. */
  getCounts(): Promise<JobCounts> {
    if (this.#closed) return Promise.reject(this.#closedError());
    return this.#client.call('counts', this.shared.scope);
  }

  /** Listen for an event; returns a function that stops listening. */
  on<K extends E>(event: K, fn: (payload: QueueEvents<Job<D, R>, Jsonify<R>>[K]) => unknown): Unsubscribe {
    return this.events.on(event, fn);
  }

  /** Listen for the next occurrence of an event only. */
  once<K extends E>(event: K, fn: (payload: QueueEvents<Job<D, R>, Jsonify<R>>[K]) => unknown): Unsubscribe {
    return this.events.once(event, fn);
  }

  /** Stop a listener added with `on` or `once`. */
  off<K extends E>(event: K, fn: (payload: QueueEvents<Job<D, R>, Jsonify<R>>[K]) => unknown): void {
    this.events.off(event, fn);
  }

  /** Turn one add's data and options into the job the store receives. */
  async #prepare(
    data: unknown, addOpts: Record<string, unknown>,
    given?: { now?: number; id?: string; ownId?: string | undefined; serialized?: Serialized | undefined },
  ): Promise<Prepared> {
    const { client, defaultJobOptions, order, maxPayloadBytes } = this.shared;
    const now = given?.now ?? (await client.call('now'));
    const policy = resolveJobOptions(defaultJobOptions, addOpts, now, this.shared);
    const keyLimit = this.#keyLimit();
    this.#checkKeys(policy, keyLimit);
    // the filter's serialization when it ran, so toJSON runs once and the job stores exactly what the filter saw
    const { json, bytes } = given?.serialized ?? serializeValue(data);
    if (bytes > maxPayloadBytes) throw new PayloadTooLargeError({ size: bytes, limit: maxPayloadBytes, queue: this.name });
    // the early check already ran the id function
    const own = given && 'ownId' in given ? given.ownId : resolveId(policy.idSpec, data, keyLimit);
    const id = own ?? given?.id ?? uuidv7(now);
    const newJob = buildNewJob(id, json, policy, order === 'fifo', this.#client.__formatSupport.current);
    const generatedId = own === undefined;
    if (typeof policy.onDuplicate !== 'function') return { newJob, now, generatedId };
    // the function sees the data as stored, so a merge gives the same result on every pod
    return {
      newJob, now, generatedId, mergeFn: policy.onDuplicate as MergeFn, incoming: deepFreeze(JSON.parse(json) as unknown),
      filterAs: { name: policy.name, opts: this.#filterOpts(addOpts) },
    };
  }

  /**
   * Stop using this queue: refuse new work at once, close every worker with the same options (see
   * `Worker.close`), then release the store. A private store (no `store` option) is closed with it; a
   * store the caller passed in stays open for its other queues. Reads work until the workers have stopped, and so
   * do `remove`, `redrive`, `redriveAll`, `clean`, `drain` and `obliterate`: they are refused only once close has finished.
   * Idempotent: every call returns the same promise. Rejects with one AggregateError, after every step,
   * when a worker could not release its leases.
   */
  close(opts: { timeoutMs?: number } = {}): Promise<void> {
    try {
      validate(`${this.#label}.close`, opts, closeSchema);
    } catch (e) {
      return Promise.reject(e as Error);
    }
    this.#closing ??= this.#close(opts);
    return this.#closing;
  }

  async #close(opts: { timeoutMs?: number }): Promise<void> {
    // The workers' deadline; with the second their last releases get, also the bound for the store calls after them.
    const giveUpAt = platform.monotonicMs() + (opts.timeoutMs ?? this.shared.shutdownTimeout) + this.shared.shutdownAbortGrace;
    const storeDeadline = giveUpAt + RELEASE_MIN_MS;
    const queue = this.#kind === 'queue';
    this.hooks.beforeClose();
    this.#stopping = true;
    if (queue) this.events.emit('closing', { queue: this.#name });
    this.shared.addGate.close();
    this.#closeSignal.abort();
    if (this.#ready) this.#dropReady(this.#ready, this.#closedError());
    const pauseChecked = async () => {
      if (this.#pauseCheck) await until(this.#pauseCheck, giveUpAt);
    };
    const errors = await this.hooks.close(opts, { giveUpAt, storeDeadline, pauseChecked });
    this.#offConnection();
    this.#closed = true;
    let closeError: { error: unknown } | undefined;
    try {
      // A failure after the deadline is dropped.
      await until(this.#client.close().catch((error: unknown) => void (closeError = { error })), storeDeadline);
    } finally {
      this.hooks.onClosed();
      if (queue) this.events.emit('closed', { queue: this.#name });
    }
    if (closeError && errors.length === 0) throw closeError.error;
    if (closeError) errors.push(closeError.error);
    if (errors.length > 0) throw new AggregateError(errors, 'shutdown: some leases could not be released');
  }
}
