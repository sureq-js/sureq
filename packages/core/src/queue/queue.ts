import { DuplicateHandlerError, InternalError, InvalidOptionError, JobCancelledError, QueueClosedError, StoreFormatError, type ConfigIssue } from '../errors/catalog.js';
import type { ErrorEvent } from '../events/types.js';
import { toJob } from '../job/job.js';
import { wrapStoreError } from '../errors/store.js';
import { MemoryStore } from '../store/memory/memory-store.js';
import type { SweepRequest } from '../store/contract.js';
import {
  jobNameIssue,
  POLL_DEFAULTS,
  resolveLeases,
  resolvePolling,
  resolveQueueOptions,
  workerOptionsSchema,
  batchWorkerOptionsSchema,
  MAX_TIMER_MS,
  type BatchWorkerOptions,
  type ResolvedBatchWorkerOptions,
  type Polling,
  type AddOptions,
  type QueueOptions,
  type ResolvedWorkerOptions,
  type WorkerOptions,
} from './options.js';
import { BatchWorker, Worker, type JobHandler, type WorkerHost } from '../worker/worker.js';
import type { BatchHandler } from '../worker/batch.js';
import { Sweeper } from '../worker/sweeper.js';
import { installSignals } from '../worker/lifecycle.js';
import { validate } from '../util/validate.js';
import { deadLetterExt } from '../admin/redrive.js';
import { RetentionCleaner } from '../retention/cleaner.js';
import { sweepExt } from '../retention/policy.js';
import { FormatWatch } from '../format/watch.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { buildScheduledJob } from '../scheduler/schedules.js';
import { isSureQError, type SureQError } from '../errors/base.js';
import { RegistryCheck } from '../registry/skew.js';
import { PodMetrics, StatsCache } from '../metrics/metrics.js';
import { AlertEvaluator, type AlertEvent } from '../metrics/alerts.js';
import { QueueBase, until, type AddResult, type BaseInternals, type CloseDeadlines, type QueueHooks } from './base.js';
import { platform, type Timer } from '../platform/index.js';

export type { AddResult, BulkOutcome, DuplicateInfo, JobCancelResult, QueueClient } from './base.js';

/** Job names → their data/result types. */
export type NameMap = Record<string, { data: unknown; result?: unknown }>;

/** The data type of job name `K` in a NameMap. */
export type NameData<N extends NameMap, K extends keyof N> = N[K]['data'];
/** The result type of job name `K` in a NameMap; `unknown` when the map gives none. */
export type NameResult<N extends NameMap, K extends keyof N> = N[K] extends { result: infer X } ? X : unknown;
/** The handler map `process` accepts: typed per name when the queue has a NameMap (literal keys, not the default string index). */
export type HandlerMap<N extends NameMap> =
  string extends keyof N ? Record<string, JobHandler> : { [K in keyof N & string]?: JobHandler<NameData<N, K>, NameResult<N, K>> };

export type QueueInternals = BaseInternals & {
  /** @internal The store namespace moved to a format this pod cannot read: claim and sweep nothing. */
  readonly isDegraded: () => boolean;
  /** @internal This pod's host name, sent on every claim's `history`. */
  readonly host: string;
  /** @internal This pod's worker-side metrics; workers and the sweeper report attempt ends here. */
  readonly metrics: PodMetrics;
  /** @internal The last `stats` read of a periodic tick, for `health()`. */
  readonly statsCache: StatsCache;
};

/** The queue's one store subscription; `stopped` once dropped, even while the subscribe is in flight. */
interface Subscription {
  stopped: boolean;
  reported: boolean;
  unsubscribe?: (() => Promise<void>) | undefined;
  retry?: Timer;
  /** The subscribe attempt in flight (or the last one), so dropping can wait for it. */
  pending: Promise<void>;
}

type SweeperOptions = { sweepIntervalMs: number; sweepBatch: number; random: () => number };
/** Registry records not heard from for this many heartbeat intervals are deleted on the sweeper tick, this many per tick. */
const PURGE_INTERVALS = 10;
const PURGE_LIMIT = 100;

/** Worker events a queue re-emits to its own listeners, payload unchanged. */
const RELAYED = ['active', 'completed', 'retrying', 'failed', 'deadLettered', 'drained', 'leaseLost', 'error', 'progress'] as const;

const closedError = (name: string): QueueClosedError => new QueueClosedError(`queue "${name}" is closed`);

/** A named queue of jobs in one namespace of one store. */
export class Queue<D = unknown, R = unknown, Names extends NameMap = Record<string, never>> extends QueueBase<D, R> {
  readonly #internals: QueueInternals;
  readonly #workers = new Set<Worker>();
  /** Workers `health()` reports: the open ones, and stopped ones until the next `process()`. */
  readonly #reported = new Set<Worker>();
  #sub: Subscription | undefined;
  #unsubscribed: Promise<void> = Promise.resolve();
  /** The queue's one sweeper and how many running workers hold it. */
  #sweeper: { sweeper: Sweeper; refs: number } | undefined;
  /** Re-reads the namespace's format while the sweeper runs; kept after it stops, for `health()`. */
  #watch: FormatWatch | undefined;
  /** Reads the worker registry for version skew and scheduler presence while the sweeper runs. */
  #registryCheck: RegistryCheck | undefined;
  /** Removes the `signals` listeners; set at the first `process()`. */
  #offSignals: (() => void) | undefined;
  /** Close gave up on the store calls still out; their late failures are not reported. */
  #gaveUp = false;
  /** The schedule loop, made on first start; `#schedulerPinned` once `startScheduler()` asked for it. */
  #scheduler: Scheduler | undefined;
  #schedulerPinned = false;
  /** The store format was refused: the scheduler stays stopped for good. */
  #schedulerRefused = false;
  /** A store format refusal was reported on this pod, by a worker or the queue: one error per cause. */
  #refusalReported = false;
  /** The last registry purge failed; the next failure is not reported again. */
  #purgeFailing = false;
  /** Set when `alerts` is configured; runs from construction, with or without workers. */
  readonly #alerts: AlertEvaluator | undefined;
  /** The evaluator's stop, begun when close starts. */
  #alertsStopped: Promise<void> | undefined;

  constructor(name: string, opts?: QueueOptions<D>) {
    const resolved = resolveQueueOptions(name, opts);
    super(name, resolved, resolved.store ?? new MemoryStore(), resolved.store === undefined, 'queue');
    const { client, scope, logger } = this.shared;
    const statsCache = new StatsCache(() => client.call('stats', scope, {}));
    const { metrics: metricsOpts } = resolved;
    this.#internals = Object.freeze({
      ...this.shared,
      isDegraded: () => this.#watch?.degraded ?? false,
      host: platform.hostname(),
      statsCache,
      metrics: new PodMetrics({ base: scope, windowMs: metricsOpts.windowMs, buckets: metricsOpts.buckets, names: this.shared.names }),
    });
    if (opts?.namespace === undefined) {
      logger.info(`queue "${name}" uses the default namespace "default"`, { queue: name, namespace: 'default' });
    }
    if (resolved.alerts) {
      this.#alerts = new AlertEvaluator({
        stats: () => statsCache.refresh(),
        window: () => this.#internals.metrics.window(),
        emit: (e) => this.events.emit('alert', e),
        report: (e) => {
          if (e instanceof StoreFormatError && e.recordKind === 'meta') {
            // a pod refused by the store's format evaluates nothing more; a running worker meets the same refusal and reports it
            void this.#alerts?.stop();
            if (!this.#reportsRefusal()) return;
          }
          this.report(isSureQError(e) ? e : new InternalError('alert stats read failed', { cause: e }), 'store', { operation: 'stats' });
        },
        // the store moved to a format this pod cannot read: no evaluation while degraded
        skip: () => this.#watch?.degraded ?? false,
        logger,
        base: scope,
      }, resolved.alerts);
      this.#alerts.start();
    }
    Object.freeze(Object.assign(this.hooks, {
      onAdded: () => {
        // Other Queue objects on the store are woken by its notifications, or find the job on their next poll.
        for (const w of this.#workers) w.wake('local');
      },
      // Also a worker closing on its own: its handlers still run.
      onCancelled: (id) => {
        for (const w of this.#reported) w.abortJob(id, new JobCancelledError({ jobId: id }));
      },
      onPauseChange: (paused, source) => {
        for (const w of this.#workers) w.onGlobalPause(paused, source);
      },
      onResumed: () => {
        for (const w of this.#workers) w.wake('local');
      },
      // After jobs were removed the last stats read is out of date: drop it, so health waits for the next tick's read.
      onRemoved: () => statsCache.reset(),
      health: () => ({
        workers: () => this.#reported,
        format: () => {
          const { minReadable: min, maxReadable: max } = client.__formatSupport;
          const storeFormat = this.#watch?.storeFormat ?? client.formatOf(scope.namespace);
          return { storeFormat, supported: { min, max }, degraded: this.#watch?.degraded ?? false };
        },
        scheduler: () => this.#scheduler,
        noSchedulerRunning: () => this.#registryCheck?.noSchedulerRunning ?? false,
        alerts: () => this.getAlerts(),
        deadLetters: () => {
          const { warnAbove } = this.#internals.deadLetter;
          const latest = statsCache.latest;
          return warnAbove === false || !latest ? undefined : { count: latest.deadLetters, warnAbove };
        },
        sweeper: () => this.#sweeper?.sweeper.ticks,
      }),
      podSamples: () => [...this.#internals.metrics.samples(), ...(this.#alerts?.samples() ?? [])],
      // first: no alert after close; an evaluation whose read hangs is given up at the deadline in close
      beforeClose: () => void (this.#alertsStopped = this.#alerts?.stop()),
      close: (o, deadlines) => this.#closeParts(o, deadlines),
      onClosed: () => this.#offSignals?.(),
    } satisfies QueueHooks));
  }

  /** Close the evaluator, the scheduler, every worker and the subscription; the errors are the workers' failed releases. */
  async #closeParts(opts: { timeoutMs?: number }, { giveUpAt, storeDeadline, pauseChecked }: CloseDeadlines): Promise<unknown[]> {
    const alertsStopped = this.#alertsStopped;
    const schedulerStopped = this.#stopScheduler();
    // A worker closed on its own is still waited for: its close is the same shared promise.
    const results = await Promise.allSettled([...this.#reported].filter((w) => w.state !== 'stopped').map((w) => w.close(opts)));
    this.#workers.clear();
    this.#syncSubscription();
    // A store call that never answers is given up at the deadline; its late answer is dropped quietly.
    await until(this.#unsubscribed, storeDeadline);
    if (schedulerStopped) await until(schedulerStopped, storeDeadline);
    if (alertsStopped) await until(alertsStopped, giveUpAt);
    await pauseChecked();
    this.#gaveUp = true;
    return results.flatMap((r) => (r.status === 'fulfilled' ? [] : r.reason instanceof AggregateError ? (r.reason.errors as unknown[]) : [r.reason]));
  }

  /** @internal Resolved settings, store client and scope; read by the worker. */
  get internals(): QueueInternals {
    return this.#internals;
  }

  /** This pod's firing alerts; empty without `alerts`. */
  getAlerts(): AlertEvent[] {
    return this.#alerts?.firing() ?? [];
  }

  /**
   * Add one job. Options, a string id and the keys are checked at once; the rest goes through the
   * outage gate (sent now, held or refused while the store is away): prepare once (id, serialization,
   * size check), one store write under the duplicate rules, then core's merge function for a duplicate
   * id. Resolves after the write, emitting `added` or `duplicate`; a rejected duplicate throws
   * DuplicateJobError. A lost response is settled by id when core generated it; otherwise it rejects
   * with `jobIds`. Nothing is written when a check fails.
   */
  override add<K extends keyof Names & string>(
    data: NameData<Names, K>,
    opts: AddOptions<NameData<Names, K>> & { name: K },
  ): Promise<AddResult<NameData<Names, K>, NameResult<Names, K>>>;
  /** Store one unnamed job, or a named one when the queue declares no job names. */
  override add(data: D, opts?: string extends keyof Names ? AddOptions<D> : AddOptions<D> & { name?: undefined }): Promise<AddResult<D, R>>;
  override add(data: unknown, opts?: object): Promise<AddResult<unknown, unknown>> {
    return super.add(data as D, opts as AddOptions<D>) as Promise<AddResult<unknown, unknown>>;
  }

  /** Run this queue's schedule loop on this pod, also without a worker, until `stopScheduler()` or close. */
  startScheduler(): void {
    if (this.closed) throw closedError(this.name);
    this.#schedulerPinned = true;
    this.#startScheduler();
  }

  /** Stop this pod's schedule loop; resolves once a fire in flight has finished. A later worker starts it again. */
  async stopScheduler(): Promise<void> {
    this.#schedulerPinned = false;
    await this.#stopScheduler();
  }

  #startScheduler(): void {
    if (this.#schedulerRefused) return;
    const { client, scope, scheduler: { tickMs, batchSize } } = this.#internals;
    this.#scheduler ??= new Scheduler({
      client,
      scope,
      buildJob: (rec, scheduledFor, now) => buildScheduledJob(rec, scheduledFor, now, this.#internals, client.__formatSupport.current),
      isDegraded: () => this.#watch?.degraded ?? false,
      emit: (event, payload) => this.events.emit(event, payload as never),
      report: (e, source, operation) => {
        // close gave up on the fire in flight: its late failure is dropped quietly
        if (this.#gaveUp) return;
        const error = isSureQError(e) ? e : new InternalError(`scheduler ${operation} failed`, { cause: e });
        this.report(error, source, { operation });
      },
      refused: (e) => {
        this.#schedulerRefused = true;
        // a pod that never passed the format check has nothing for the watch to judge
        if (!this.#sweeper) this.#watch?.stop();
        // a running worker meets the same refusal on its claim and reports it: one error per cause
        if (!this.#gaveUp && this.#reportsRefusal()) this.report(e, 'store', { operation: 'listDueSchedules' });
      },
    }, { tickMs, batchSize, random: this.#internals.random ?? Math.random });
    this.#scheduler.start();
    // a pod with only a scheduler must still learn that the store's format moved past it
    this.#startWatch();
  }

  /** Stop the schedule loop, and the format watch when no sweeper needs it either. */
  #stopScheduler(): Promise<void> | undefined {
    const stopped = this.#scheduler?.stop();
    if (!this.#sweeper) this.#watch?.stop();
    return stopped;
  }

  /**
   * Whether the queue reports a store format refusal itself: not when it was reported already, nor while a worker
   * of this pod runs unpaused (it meets the same refusal on its own claim and reports it). Marks it reported when it does.
   */
  #reportsRefusal(): boolean {
    // a locally paused worker claims nothing, so it never meets the refusal
    if (this.#refusalReported || [...this.#reported].some((w) => w.state === 'running' && !w.isPaused('local'))) return false;
    this.#refusalReported = true;
    return true;
  }

  #startWatch(): void {
    const { client, scope, logger } = this.#internals;
    this.#watch ??= new FormatWatch({
      client,
      namespace: scope.namespace,
      get support() {
        return client.__formatSupport;
      },
      report: (e, source, operation) => this.report(isSureQError(e) ? e : new InternalError(`${operation} failed`, { cause: e }), source, { operation }),
      emitDegraded: (error) => this.events.emit('degraded', { error }),
      logger,
    });
    this.#watch.start();
  }

  /**
   * Run jobs: `process(handler)` for unnamed jobs, or `process({ name: handler })` for named
   * ones. Returns a Worker, started unless `autorun: false`.
   */
  process(handler: JobHandler<D, R>, opts?: WorkerOptions): Worker<D, R>;
  /** Run named jobs: one handler per job name. Returns a Worker, started unless `autorun: false`. */
  process(handlers: HandlerMap<Names>, opts?: WorkerOptions): Worker;
  process(first: JobHandler<D, R> | HandlerMap<Names>, opts: WorkerOptions = {}): Worker<D, R> {
    if (this.closed) throw new QueueClosedError(`queue "${this.name}" is closed`);
    const scope = `Queue "${this.name}".process`;
    const handlers = new Map<string | null, JobHandler>();
    const issues: ConfigIssue[] = [];
    if (typeof first === 'function') handlers.set(null, first as JobHandler);
    else if (typeof first !== 'object' || first === null || Array.isArray(first) || Object.getPrototypeOf(first) !== Object.prototype && Object.getPrototypeOf(first) !== null) {
      issues.push({ path: 'handler', code: 'invalid_type', message: 'expected a handler function or an object of { jobName: handler }' });
    } else if (Object.keys(first).length === 0) {
      issues.push({ path: 'handlers', code: 'invalid_value', message: 'expected at least one { jobName: handler }' });
    } else {
      for (const [name, fn] of Object.entries(first)) {
        const nameIssue = jobNameIssue(name, `handlers.${name}`);
        if (nameIssue) issues.push(nameIssue);
        else if (typeof fn !== 'function') issues.push({ path: `handlers.${name}`, code: 'invalid_type', message: 'expected a handler function' });
        else handlers.set(name, fn);
      }
    }
    let resolved: (ResolvedWorkerOptions & Polling) | undefined;
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      // e.g. process('name', fn): the handler landed here.
      issues.push({ path: 'opts', code: 'invalid_type', message: 'expected an options object' });
    } else if (Object.hasOwn(opts, 'batchSize')) {
      issues.push({ path: 'batchSize', code: 'invalid_value', message: 'batches are run by queue.processBatch(handler, opts)' });
    } else {
      try {
        const own = validate(scope, opts, workerOptionsSchema);
        resolved = { ...own, ...resolvePolling(this.#internals, own, scope) };
      } catch (e) {
        if (!(e instanceof InvalidOptionError)) throw e;
        issues.push(...e.issues);
      }
    }
    if (issues.length > 0 || !resolved) throw new InvalidOptionError(scope, issues);
    // Each job name once per open worker of this Queue object; unnamed workers are unrestricted.
    for (const open of this.#workers) {
      for (const jobName of open.jobNames) if (jobName !== null && handlers.has(jobName)) throw new DuplicateHandlerError({ jobName });
    }
    const workerOpts = resolved;
    return this.#spawn(handlers.keys(), workerOpts, (host) => new Worker<D, R>(host, handlers, workerOpts));
  }

  /**
   * Run batches of unnamed jobs: the handler gets up to `batchSize` jobs at once, each with its own lease,
   * token, signal and retry decision. Returns a BatchWorker, started unless `autorun: false`.
   */
  processBatch(handler: BatchHandler<D, R>, opts: BatchWorkerOptions): BatchWorker<D, R> {
    if (this.closed) throw new QueueClosedError(`queue "${this.name}" is closed`);
    const scope = `Queue "${this.name}".processBatch`;
    const issues: ConfigIssue[] = [];
    if (typeof handler !== 'function') issues.push({ path: 'handler', code: 'invalid_type', message: 'expected a batch handler function' });
    let resolved: (ResolvedBatchWorkerOptions & Polling) | undefined;
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      issues.push({ path: 'opts', code: 'invalid_type', message: 'expected an options object with batchSize' });
    } else {
      try {
        const own = validate(scope, opts, batchWorkerOptionsSchema);
        resolved = { ...own, ...resolvePolling(this.#internals, own, scope) };
      } catch (e) {
        if (!(e instanceof InvalidOptionError)) throw e;
        issues.push(...e.issues);
      }
    }
    if (issues.length > 0 || !resolved) throw new InvalidOptionError(scope, issues);
    const { batchSize: size, batchDelay: delayMs, batchMaxWait, onShutdown } = resolved;
    const setup = { handler: handler as BatchHandler, size, delayMs, maxWaitMs: batchMaxWait ?? Math.min(delayMs * 20, MAX_TIMER_MS), onShutdown };
    const batchOpts = resolved;
    return this.#spawn([null], batchOpts, (host) => new BatchWorker<D, R>(host, setup, batchOpts));
  }

  /** Register and start a worker built over this queue. */
  #spawn<W extends Worker<D, R>>(names: Iterable<string | null>, resolved: ResolvedWorkerOptions & Polling, make: (host: WorkerHost) => W): W {
    if (!this.shared.client.capabilities.durable && !resolved.acknowledgeVolatileStore && !this.shared.client.volatileWarned) {
      this.shared.client.volatileWarned = true;
      this.#internals.logger.warn('store is not durable; jobs are lost on restart', { queue: this.name });
    }
    const host = {
      ...resolveLeases(this.#internals, resolved, names),
      name: this.name, internals: this.#internals, client: this.shared.client, scope: this.#internals.scope, binding: this.binding,
      acquireSweeper: (o: SweeperOptions) => this.#acquireSweeper(o),
      schedulerRunning: () => this.#scheduler?.running ?? false,
      onClose: (w: Worker) => {
        this.#workers.delete(w);
        this.#syncSubscription();
        if (this.#workers.size === 0 && !this.#schedulerPinned) void this.#stopScheduler();
      },
    };
    // Before the worker is registered: a failure here leaves nothing behind.
    if (this.#internals.signals.length > 0) {
      this.#offSignals ??= installSignals(this.#internals.signals, () => {
        this.close().catch((e: unknown) => this.report(new InternalError('close on a signal failed', { cause: e }), 'internal', { operation: 'close' }));
      });
    }
    const worker = make(host);
    this.#workers.add(worker as Worker);
    for (const w of this.#reported) if (w.state === 'stopped') this.#reported.delete(w);
    this.#reported.add(worker as Worker);
    worker.on('error', (e) => {
      if (e.error instanceof StoreFormatError && e.error.recordKind === 'meta') this.#refusalReported = true;
    });
    for (const event of RELAYED) {
      // The worker's reporter already logged (rate-limited) every error except listener failures.
      worker.on(event, (payload) => this.events.emit(event, payload as never, { quiet: event === 'error' && (payload as ErrorEvent).source !== 'listener' }));
    }
    this.#syncSubscription();
    if (this.#internals.scheduler.enabled) this.#startScheduler();
    if (resolved.autorun) void worker.run();
    return worker;
  }

  /**
   * Start the queue's sweeper on the first call, with this caller's interval and batch; the returned
   * release stops it once every caller has released.
   */
  #acquireSweeper(opts: SweeperOptions): () => Promise<void> {
    if (!this.#sweeper) {
      const { client, scope, maxCrashes, logger, history, deadLetter, retention } = this.#internals;
      const { maxClaimLimit } = client.capabilities.limits;
      // the pass ends early once this sweeper stops, so a close never waits out a backlog
      const cleaner = new RetentionCleaner({ client, scope, retention, stopping: () => !sweeper.running }, (e) => {
        this.report(isSureQError(e) ? e : new InternalError('retention clean failed', { cause: e }), 'store', { operation: 'clean' });
      });
      if (opts.sweepBatch > maxClaimLimit) {
        logger.warn(`sweepBatch ${opts.sweepBatch} is above the store's claim limit; each sweep recovers at most ${maxClaimLimit} jobs`, {
          queue: this.name, sweepBatch: opts.sweepBatch, maxClaimLimit,
        });
      }
      const sweeper = new Sweeper(
        {
          client,
          scope,
          toJob: (rec, now) => toJob(rec, now, this.binding),
          maxFormat: () => client.__formatSupport.maxReadable,
          isDegraded: () => this.#watch?.degraded ?? false,
          emit: (event, payload) => this.events.emit(event, payload as never),
          report: (e, source, operation) => {
            // a refused format is reported once for the queue, like the scheduler's
            if (e instanceof StoreFormatError && e.recordKind === 'meta' && !this.#reportsRefusal()) return;
            const error = isSureQError(e) ? e : new InternalError(`sweeper ${operation} failed`, { cause: e });
            this.report(error, source, { operation });
          },
          metrics: this.#internals.metrics,
          // each step on its own: a failed or slow step never skips or delays another
          afterTick: async (now) => {
            await Promise.all([
              this.#internals.statsCache.refresh().catch(() => {}), this.#purgeWorkers(), cleaner.maybeRun(now),
            ]);
          },
          evaluateDrained: async () => {
            const { drainedLatch } = this.#internals;
            // The sweeper ended a job of this queue, like a worker's final failure.
            drainedLatch.arm();
            try {
              await drainedLatch.evaluate(() => this.events.emit('drained', { queue: this.name }));
            } catch (e) {
              this.report(isSureQError(e) ? e : new InternalError('sweeper counts failed', { cause: e }), 'store', { operation: 'counts' });
            }
          },
        },
        {
          ...opts, sweepBatch: Math.min(opts.sweepBatch, maxClaimLimit), maxCrashes, history,
          deadLetter: deadLetterExt(deadLetter, { keep: null }) as SweepRequest['deadLetter'], ...sweepExt(retention),
        },
      );
      this.#sweeper = { sweeper, refs: 0 };
      sweeper.start();
      this.#startWatch();
      this.#registryCheck ??= new RegistryCheck({
        client, scope, logger,
        emitSkew: (workers) => this.events.emit('versionSkew', { workers }),
        schedulerRunning: () => this.#scheduler?.running ?? false,
        report: (e, operation) => this.report(isSureQError(e) ? e : new InternalError(`${operation} failed`, { cause: e }), 'store', { operation }),
      });
      this.#registryCheck.start();
    }
    const held = this.#sweeper;
    held.refs++;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (--held.refs > 0) return;
      if (this.#sweeper === held) {
        this.#sweeper = undefined;
        this.#registryCheck?.stop();
        if (!this.#scheduler?.running) this.#watch?.stop();
      }
      await held.sweeper.stop();
    };
  }

  /** Delete registry records of dead workers; a failure is reported once per outage. Never rejects. */
  async #purgeWorkers(): Promise<void> {
    try {
      await this.shared.client.call('purgeWorkers', { namespace: this.#internals.namespace }, { staleIntervals: PURGE_INTERVALS, limit: PURGE_LIMIT });
      this.#purgeFailing = false;
    } catch (e) {
      // A refused format is reported once, by the worker.
      if ((e instanceof StoreFormatError && e.recordKind === 'meta') || this.#purgeFailing) return;
      this.#purgeFailing = true;
      this.report(isSureQError(e) ? e : new InternalError('purgeWorkers failed', { cause: e }), 'store', { operation: 'purgeWorkers' });
    }
  }

  /** Hold one store subscription while an open worker wants notifications and the store has them. */
  #syncSubscription(): void {
    const want = !this.closed && this.shared.client.capabilities.notify && [...this.#workers].some((w) => w.notifies);
    if (want && !this.#sub) this.#subscribe();
    else if (!want && this.#sub) {
      const sub = this.#sub;
      this.#sub = undefined;
      sub.stopped = true;
      sub.retry?.cancel();
      // Wait for a subscribe still in flight, so close never resolves before it is released.
      this.#unsubscribed = this.#unsubscribed.then(() => sub.pending).then(() => this.#drop(sub));
    }
  }

  #subscribe(): void {
    const sub: Subscription = { stopped: false, reported: false, pending: Promise.resolve() };
    this.#sub = sub;
    const attempt = async (): Promise<void> => {
      try {
        const unsubscribe = await this.shared.client.subscribe(this.#internals.scope, () => this.#onPush());
        sub.unsubscribe = unsubscribe;
        // Dropped while subscribing: release it now.
        if (sub.stopped) await this.#drop(sub);
      } catch (e) {
        if (sub.stopped) return;
        // A refused store format: the worker reports it and closes, which drops this subscription.
        if (e instanceof StoreFormatError && e.recordKind === 'meta') return;
        // Polling carries on meanwhile; report once and try again after the workers' longest poll wait.
        if (!sub.reported) this.report(wrapStoreError('subscribe', e) as SureQError, 'store', { operation: 'subscribe' });
        sub.reported = true;
        const wait = [...this.#workers].reduce((ms, w) => Math.max(ms, w.pollMax), 0) || (this.#internals.pollMax ?? POLL_DEFAULTS.pollMax);
        sub.retry = platform.setTimer(() => void (sub.pending = attempt()), wait);
      }
    };
    sub.pending = attempt();
  }

  async #drop(sub: Subscription): Promise<void> {
    const unsubscribe = sub.unsubscribe;
    sub.unsubscribe = undefined;
    try {
      await unsubscribe?.();
    } catch (e) {
      if (this.#gaveUp) return;
      this.report(wrapStoreError('subscribe', e) as SureQError, 'store', { operation: 'subscribe' });
    }
  }

  /** A store notification: wake every open worker; nothing a worker throws reaches the store. */
  #onPush(): void {
    for (const w of this.#workers) {
      try {
        w.wake('push');
      } catch (e) {
        const error = isSureQError(e) ? e : new InternalError('waking a worker on a store notification failed', { cause: e });
        this.report(error, 'store', { operation: 'subscribe' });
      }
    }
  }
}
