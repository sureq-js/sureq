import { isObliterating } from '../admin/obliterate.js';
import type { Jsonify } from '../serialize/jsonify.js';
import { isSureQError, type SureQError } from '../errors/base.js';
import {
  InternalError, JobCancelledError, JobTimeoutError, LeaseLostError, ResultTooLargeError, ShutdownError, StoreFormatError, StoreUnavailableError,
  WorkerClosedError, isStoreError,
} from '../errors/catalog.js';
import { TypedEmitter } from '../events/emitter.js';
import type { ErrorSource, FailureReason, Unsubscribe, WorkerEvents } from '../events/types.js';
import { parsePayload, toClaimedJob, toJob, type Job, type JobBinding } from '../job/job.js';
import { RELEASE_MIN_MS, type Leases, type Polling, type ResolvedWorkerOptions } from '../queue/options.js';
import type { QueueInternals } from '../queue/queue.js';
import { serializeError } from '../serialize/error.js';
import { serializeValue } from '../serialize/value.js';
import type { StoreClient } from '../store/client.js';
import type { ClaimResult, DeadLetterReason, FailRequest, FailResult, FencedRejection, JobRecord, Scope, SetProgressRequest } from '../store/contract.js';
import { uuidv7 } from '../util/uuidv7.js';
import { validate, type Schema } from '../util/validate.js';
import { createContext, toError, type JobContext, type WorkerContext } from './context.js';
import { decideFailure } from '../retry/decide.js';
import { createReporter } from '../events/report.js';
import { finalize, type FinalResult } from './finalize.js';
import { PollDelay } from './poll.js';
import { LeaseKeeper, lossReason } from './lease.js';
import { resolveTimeout, startTimeout } from './timeout.js';
import { Lifecycle, releaseLease, type ReleaseOutcome, type WorkerState } from './lifecycle.js';
import type { StoredBackoff } from '../retry/backoff.js';
import { PauseFlag, type PauseScope } from '../queue/pause.js';
import type { Settled, Slot } from './slot.js';
import { Batching, type BatchSetup, type Outcome } from './batch.js';
import { loopDeadAfterMs, type WorkerSnapshot } from '../health/health.js';
import { deadLetterExt } from '../admin/redrive.js';
import { finishExt } from '../retention/policy.js';
import { encodeProgress, ProgressChannel } from './progress.js';
import { RegistryHeartbeat } from '../registry/heartbeat.js';
import { platform, type Timer } from '../platform/index.js';

/**
 * Serialize a handler result for the store: `undefined` stores nothing; otherwise JSON
 * within `maxResultBytes` UTF-8 bytes. Throws SerializationError or ResultTooLargeError; the error
 * never contains the value.
 */
export function encodeResult(value: unknown, maxResultBytes: number, jobId: string): string | undefined {
  if (value === undefined) return undefined;
  const { json, bytes } = serializeValue(value);
  if (bytes > maxResultBytes) throw new ResultTooLargeError({ size: bytes, limit: maxResultBytes, jobId });
  return json;
}

/** A claimed job's local lease deadline, on the pod's monotonic clock. */
function leaseDeadline(rec: JobRecord, claim: { now: number; sentAt: number }): number {
  return claim.sentAt + (rec.lease!.expiresAt - claim.now);
}

/** Runs one job attempt. Its return value is the job's result; a throw fails the attempt. */
export type JobHandler<D = unknown, R = unknown> = (job: Job<D, R>, ctx: JobContext) => R | Promise<R>;

/** What a worker needs from its queue; its lease lengths are resolved there. */
export interface WorkerHost extends Readonly<Leases> {
  readonly name: string;
  readonly internals: QueueInternals;
  readonly client: StoreClient;
  readonly scope: Scope;
  readonly binding: JobBinding;
  /** Hold the queue's sweeper while this worker runs; call the returned function to let go. */
  readonly acquireSweeper: (opts: { sweepIntervalMs: number; sweepBatch: number; random: () => number }) => () => Promise<void>;
  /** The queue runs its scheduler on this pod now; the registry record carries it. */
  readonly schedulerRunning: () => boolean;
  /** Called once when the worker starts closing, so the queue can release its job names. */
  readonly onClose?: (worker: Worker) => void;
}

/** A worker event listener for event `K`. */
export type Listener<D, R, K extends keyof WorkerEvents> = (payload: WorkerEvents<Job<D, R>, Jsonify<R>>[K]) => unknown;

/** A `ctx.fail` call decides the attempt, whatever the handler returned or threw afterwards. */
function failRecordOr(ctx: WorkerContext, outcome: Outcome): Outcome {
  const rec = ctx.getFailRecord();
  if (!rec) return outcome;
  return rec.retry === undefined ? { ok: false, err: rec.err } : { ok: false, err: rec.err, retry: rec.retry };
}

/** The dead-letter reason of each way a worker fails a job for good. */
const DEAD_LETTER_REASON = { 'attempts-exhausted': 'exhausted', unrecoverable: 'unrecoverable', 'not-retryable': 'retryRejected' } as const satisfies Record<FailureReason, string>;

const CLAIM_BACKOFF_MS = 100;
const CLAIM_BACKOFF_MAX_MS = 5000;
/** Without `skipLocked` claimers serialise: each claim asks for at most this many jobs, and polls jitter at least this much. */
const SERIAL_CLAIM_LIMIT = 10;
const SERIAL_POLL_JITTER = 0.5;
/** Measured: at 2000 a batch blocks the event loop for over 50 ms. */
const CONCURRENCY_WARN_ABOVE = 1000;
const closeOptionsSchema: Schema<{ timeoutMs?: number }> = { fields: { timeoutMs: { kind: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER } } };
const pauseOptionsSchema: Schema<{ waitForActive?: boolean }> = { fields: { waitForActive: { kind: 'boolean' } } };

/** One running attempt of a single-job handler. */
interface Attempt extends Slot {
  readonly rec: JobRecord;
  done: Promise<void>;
  running: boolean;
  /** Aborted by shutdown: whatever the handler does now, the job is released. */
  discarded: boolean;
  release?: Promise<ReleaseOutcome>;
}

/** Claims jobs of one queue and runs their handlers. Made by `queue.process`. */
export class Worker<D = unknown, R = unknown> {
  /** The worker id, from the `workerId` option or a UUIDv7. */
  readonly id: string;
  /** The `concurrency` it was started with. */
  readonly concurrency: number;
  readonly #host: WorkerHost;
  readonly #handlers: ReadonlyMap<string | null, JobHandler>;
  readonly #names: Set<string | null>;
  readonly #opts: ResolvedWorkerOptions & Polling;
  readonly #delay: PollDelay;
  readonly #events: TypedEmitter<WorkerEvents<Job<D, R>, Jsonify<R>>>;
  /** Running attempts (keyed `id:token`: a stale handler and a newer attempt of the same job can both run here) and batches. */
  readonly #inFlight = new Map<string, Slot>();
  /** Releases in progress, with their job ids. */
  readonly #releasing = new Map<Promise<ReleaseOutcome>, string>();
  /** Store errors raised by releases during close; close rejects with them. */
  readonly #releaseErrors: SureQError[] = [];
  readonly #reporter: ReturnType<typeof createReporter>;
  readonly #keeper: LeaseKeeper;
  readonly #lifecycle = new Lifecycle();
  #closed: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  /** A wake-up arrived while no sleep was running (a claim was in flight): skip the next sleep. */
  #woken = false;
  /** Ends a claim-error backoff early; only close calls it. */
  #endBackoff: (() => void) | undefined;
  #lastStoreNow = 0;
  /** A claim whose outcome is unknown, to repeat with the same id. */
  #pendingClaim: { claimId: string; firstSentAt: number } | undefined;
  #loopDone: Promise<void> = Promise.resolve();
  #releaseSweeper: (() => Promise<void>) | undefined;
  /** Aborted by close: ends a wait for the store to come back. */
  readonly #closing = new AbortController();
  /** Aborted when a close with `timeoutMs` runs out: finalising writes stop retrying. */
  readonly #givenUp = new AbortController();
  /** This worker's own pause; the store is never told. */
  readonly #paused = new PauseFlag((paused, source) => this.#emitPause(paused, 'local', source));
  /** Counts `pause()` calls, so a claim that was out across a pause and a resume still gives its jobs back. */
  #pauses = 0;
  /** The claim in flight and the starting or release of what it returned; resolved while idle. */
  #cycle: Promise<void> = Promise.resolve();
  /** A failed progress write was reported and no progress write has been answered since. */
  #progressFailing = false;
  /** Monotonic time of the loop's last iteration; every wait in the loop is bounded by pollMax, so a live loop stamps it that often. */
  #lastTick: number | undefined;
  /** This worker's registry record, kept from `run()` on. */
  #registry: RegistryHeartbeat | undefined;
  /** @internal Set for a batch worker: claimed jobs are held until their batch closes. */
  protected readonly batching: Batching | undefined;

  /** @internal Use `queue.process`. */
  constructor(host: WorkerHost, handlers: ReadonlyMap<string | null, JobHandler>, opts: ResolvedWorkerOptions & Polling, batch?: BatchSetup) {
    this.#host = host;
    this.#handlers = handlers;
    // A batch worker takes unnamed jobs only.
    this.#names = new Set(batch ? [null] : handlers.keys());
    this.#opts = opts;
    // Claimers that block each other spread out: wider jitter, smaller batches (see #claim).
    const pollJitter = host.client.capabilities.skipLocked ? opts.pollJitter : Math.max(opts.pollJitter, SERIAL_POLL_JITTER);
    this.#delay = new PollDelay({ ...opts, pollJitter, random: opts.random ?? Math.random });
    this.id = opts.workerId ?? uuidv7();
    this.concurrency = opts.concurrency;
    this.#events = new TypedEmitter({ queue: host.name, logger: host.internals.logger });
    this.#reporter = createReporter({
      emit: (e) => this.#events.emit('error', e, { quiet: true }),
      logger: host.internals.logger,
      now: () => platform.monotonicMs(),
      queue: host.name,
      workerId: this.id,
    });
    this.#keeper = new LeaseKeeper(
      {
        client: host.client,
        scope: host.scope,
        report: (e, source, operation, jobId) => this.#report(e, source, operation, jobId),
        onLost: ({ job, token, reason }) => this.#emitLeaseLost(job, token, reason),
        onCancelled: (job) => host.internals.metrics.attemptEnded(job, 'cancelled', null),
        onStarted: (job, now) => host.internals.metrics.observeHeld(job, job.startedAt === null ? 0 : now - job.startedAt),
      },
      { leaseMsFor: host.leaseMsFor, ...(opts.random && { random: opts.random }) },
    );
    this.batching = batch && new Batching({
      keeper: this.#keeper,
      logger: host.internals.logger,
      ids: { queue: host.name, workerId: this.id },
      toClaimedJob: (rec) => toClaimedJob(rec, rec.startedAt ?? rec.createdAt, host.binding, () => this.#keeper.lease(rec.id, rec.lease!.token) ?? null),
      emitActive: (job) => this.#events.emit('active', { job: job as Job<D, R>, workerId: this.id }),
      settle: (rec, job, outcome) => this.#settle(rec, job as Job<D, R>, outcome).catch(async (e: unknown) => {
        await this.#failStranded(rec, job as Job<D, R>, e);
        return 'unconfirmed' as const;
      }),
      release: (rec, handlerStarted, reason) => this.#release(rec, handlerStarted, this.#keeper.deadline(rec.id, rec.lease!.token), reason),
      timeoutFor: (rec) => this.#timeoutFor(rec),
      progressChannel: (rec, field, signal) => this.#progressChannel(rec, field, signal),
      encodeProgress: (args, o) => this.#encodeProgress(args, o),
      addSlot: (slot) => void this.#inFlight.set(slot.key, slot),
      freed: (slot) => {
        this.#inFlight.delete(slot.key);
        this.#wakeUp();
      },
    }, batch);
    if (this.concurrency > CONCURRENCY_WARN_ABOVE) {
      host.internals.logger.warn(
        `worker concurrency ${this.concurrency} is above ${CONCURRENCY_WARN_ABOVE}: each claim batch runs in one event-loop turn, so timers and I/O can stall`,
        { queue: host.name, workerId: this.id, concurrency: this.concurrency },
      );
    }
  }

  /** Slots in flight: running handlers (a batch counts once). Compare with `concurrency`. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** @internal Wants store notifications. */
  get notifies(): boolean {
    return this.#opts.notify && (this.state === 'created' || this.state === 'running');
  }

  /** @internal Longest idle wait between claims. */
  get pollMax(): number {
    return this.#opts.pollMax;
  }

  /** @internal Job names this worker handles (`null` = unnamed jobs). */
  get jobNames(): ReadonlySet<string | null> {
    return this.#names;
  }

  /** `created`, `running`, `stopping` (close in progress) or `stopped`. */
  get state(): WorkerState {
    return this.#lifecycle.state;
  }

  /** `state === 'running'`; a paused worker is still running. */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /** @internal What `queue.health()` reports for this worker. */
  healthSnapshot(): WorkerSnapshot {
    return {
      state: this.state,
      paused: this.isPaused(),
      tickAgeMs: this.#lastTick === undefined ? null : platform.monotonicMs() - this.#lastTick,
      activeJobs: this.#activeJobs(),
      renewals: this.#keeper.renewals(),
      loopDeadAfterMs: loopDeadAfterMs(this.#opts.pollMax),
    };
  }

  /** Start the loop. Resolves once started, not when the worker closes. Idempotent while running. */
  async run(): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') throw new WorkerClosedError(`worker "${this.id}" is closed; create a new one`);
    if (this.state === 'running') return;
    this.#lifecycle.start();
    const { sweepInterval, sweepBatch, random = Math.random } = this.#opts;
    this.#releaseSweeper = this.#host.acquireSweeper({ sweepIntervalMs: sweepInterval, sweepBatch, random });
    this.#registry = this.#startRegistry();
    // The loop handles its own errors; this catch is the last line so nothing escapes as unhandled.
    this.#loopDone = this.#loop().catch((e: unknown) => this.#report(e, 'internal', 'loop'));
  }

  /**
   * Stop: claim nothing more, let running handlers finish for `timeoutMs` (default `shutdownTimeout`),
   * then abort the rest with ShutdownError, wait `shutdownAbortGrace`, and release their jobs to
   * `waiting` with the attempt refunded. Resolves once `stopped`: within timeout plus grace, plus at most
   * one second for the last releases to answer. Rejects with an AggregateError (after every step) when a
   * release raised a store error or was still unconfirmed at that deadline. Concurrent calls
   * share one promise.
   */
  close(opts: { timeoutMs?: number } = {}): Promise<void> {
    let timeoutMs: number | undefined;
    try {
      ({ timeoutMs } = validate(`Worker "${this.id}".close`, opts, closeOptionsSchema));
    } catch (e) {
      return Promise.reject(e as Error);
    }
    return (this.#closed ??= this.#close(timeoutMs ?? this.#opts.shutdownTimeout ?? this.#host.internals.shutdownTimeout));
  }

  async #close(timeoutMs: number): Promise<void> {
    const abortAt = platform.monotonicMs() + timeoutMs;
    const giveUpAt = abortAt + (this.#opts.shutdownAbortGrace ?? this.#host.internals.shutdownAbortGrace);
    const ids = { queue: this.#host.name, workerId: this.id };
    this.#lifecycle.beginStop();
    // The registry shows this worker draining before any of its jobs is released.
    const draining = this.#registry?.draining();
    // A forming batch runs now or goes back unrun, as `onShutdown` says.
    this.batching?.closing();
    this.#events.emit('closing', ids);
    this.#host.onClose?.(this as Worker);
    this.#endBackoff?.();
    this.#closing.abort();
    this.#wakeUp();
    // A claim in flight releases what it returns; the sweeper stops once no worker of the queue runs.
    // A hung claim or sweep must not delay the abort; a late claim is still awaited below.
    await this.#until(Promise.all([this.#loopDone, this.#releaseSweeper?.(), draining]), abortAt);
    // Running handlers finish normally until the timeout; heartbeats go on.
    await this.#until(this.#settled(), abortAt);
    // A cancelled or lost attempt is already aborted, and the store would refuse its release.
    const stuck = [...this.#inFlight.values()].filter((s) => s.running && s.shutdown(new ShutdownError('worker is shutting down')));
    if (stuck.length > 0) await this.#until(this.#settled(), giveUpAt);
    // Still running after the grace: release anyway and free the slot; the lease is kept until released.
    const ignored = stuck.filter((s) => s.running);
    const ignoredIds = ignored.flatMap((s) => s.jobIds);
    for (const s of ignored) {
      this.#inFlight.delete(s.key);
      void s.abandon();
    }
    if (ignored.length > 0) {
      this.#host.internals.logger.warn('handlers ignored the shutdown abort; their jobs were released while they still run', {
        ...ids, jobIds: ignoredIds.join(','),
      });
    }
    // A release sent at the end of the grace still gets one round trip.
    const lastAt = Math.max(giveUpAt, platform.monotonicMs() + RELEASE_MIN_MS);
    await this.#until(Promise.all([this.#loopDone, this.#settled(), ...this.#releasing.keys()]), lastAt);
    // Every job is done or released: the record goes, within the same bound; a failure is reported, not thrown.
    if (this.#registry) await this.#until(this.#registry.stop(), lastAt);
    // Out of time: whatever is still being written is given up.
    const unconfirmed = [...this.#releasing.values()];
    this.#givenUp.abort();
    for (const jobId of unconfirmed) {
      const message = `outcome of 'release' for job '${jobId}' is unconfirmed`;
      const error = new StoreUnavailableError(message, { operation: 'release', retryable: true, outcomeUnknown: true, jobId });
      this.#report(error, 'store', 'release', jobId);
      this.#releaseErrors.push(error);
    }
    // A lost or cancelled handler that still runs is left behind; its result is ignored.
    const left = [...this.#inFlight.values()].filter((s) => s.running);
    if (left.length > 0) {
      this.#host.internals.logger.debug('handlers whose lease was lost or job cancelled still ran at close; their results are ignored', {
        ...ids, jobIds: left.flatMap((s) => s.jobIds).join(','),
      });
    }
    // A write still hanging is given up (its late answer is dropped): free its slot.
    this.#inFlight.clear();
    this.#keeper.stop();
    this.#lifecycle.finish();
    this.#events.emit('closed', ids);
    if (this.#releaseErrors.length > 0) throw new AggregateError(this.#releaseErrors, 'shutdown: some leases could not be released');
  }

  /** Register this worker and keep its record fresh; the release and format versions are the store client's. */
  #startRegistry(): RegistryHeartbeat {
    const { client, scope, name } = this.#host;
    const { host, labels, heartbeatInterval } = this.#opts;
    const registry = new RegistryHeartbeat(
      // A registry call close gave up on is not reported after `closed`.
      { client, scope, report: (e, operation) => void (this.#givenUp.signal.aborted || this.#report(e, 'store', operation)) },
      () => ({
        activeJobs: this.#activeJobs(),
        concurrency: this.concurrency,
        status: this.state === 'stopping' || this.state === 'stopped' ? 'draining' : this.isPaused() ? 'paused' : 'running',
        scheduler: this.#host.schedulerRunning(),
      }),
      {
        workerId: this.id, queues: [name], names: [...this.#names], concurrency: this.concurrency, sureqVersion: client.__formatSupport.sureqVersion,
        formatVersion: client.__formatSupport.current, heartbeatIntervalMs: heartbeatInterval, host, pid: platform.pid(),
        labels: { ...labels }, scheduler: this.#host.schedulerRunning(),
      },
    );
    registry.start();
    return registry;
  }

  /** Jobs held by running attempts and batches. */
  #activeJobs(): number {
    return [...this.#inFlight.values()].reduce((n, s) => n + s.jobIds.length, 0);
  }

  /** Every running attempt's outcome recorded. */
  #settled(): Promise<unknown> {
    return Promise.all([...this.#inFlight.values()].map((s) => s.done));
  }

  /** Wait for `p`, but not past `at` (pod-monotonic ms); true when `p` settled first. */
  async #until(p: Promise<unknown>, at: number): Promise<boolean> {
    let timer: Timer | undefined;
    const expired = new Promise<boolean>((r) => (timer = platform.setTimer(() => r(false), Math.max(0, at - platform.monotonicMs()), { ref: true })));
    try {
      return await Promise.race([p.then(() => true, () => true), expired]);
    } finally {
      timer?.cancel();
    }
  }

  /**
   * Stop taking jobs on this worker only; nothing is written to the store. Running jobs carry on, with
   * their leases renewed. Resolves once no claim is in flight: jobs returned by a claim in flight are given
   * back unrun, attempt refunded. A batch worker keeps the jobs already held in a forming batch: that batch
   * still runs when it closes (its `batchDelay`, `batchMaxWait`, size or `batch.flush()`). With `waitForActive`,
   * also waits for the jobs running when it was called. Pausing a paused worker does nothing more.
   */
  async pause(opts: { waitForActive?: boolean } = {}): Promise<void> {
    const { waitForActive } = validate(`Worker "${this.id}".pause`, opts, pauseOptionsSchema);
    this.#assertOpen();
    this.#pauses++;
    this.#paused.set(true, 'self');
    const running = waitForActive ? [...this.#inFlight.values()].map((s) => s.done) : [];
    await this.#cycle;
    await Promise.all(running);
  }

  /** Take jobs again at once; does nothing when not paused. */
  resume(): void {
    this.#assertOpen();
    if (this.#paused.set(false, 'self')) this.#wakeUp();
  }

  /** Paused locally or (as last seen) globally; `scope` asks for one of them. */
  isPaused(scope?: PauseScope): boolean {
    if (scope === 'local') return this.#paused.value;
    const global = this.#host.internals.isGloballyPaused();
    return scope === 'global' ? global : global || this.#paused.value;
  }

  /** @internal The queue's global flag changed. */
  onGlobalPause(paused: boolean, source: 'self' | 'observed'): void {
    this.#emitPause(paused, 'global', source);
  }

  #emitPause(paused: boolean, scope: PauseScope, source: 'self' | 'observed'): void {
    if (this.state === 'stopping' || this.state === 'stopped') return;
    this.#events.emit(paused ? 'paused' : 'resumed', { scope, queue: this.#host.name, workerId: this.id, source, at: Date.now() });
  }

  #assertOpen(): void {
    if (this.state === 'stopping' || this.state === 'stopped') throw new WorkerClosedError(`worker "${this.id}" is closed; create a new one`);
  }

  /** @internal The job was cancelled: abort its attempts here with `reason` and drop their outcome. True when one ran here. */
  abortJob(id: string, reason: Error): boolean {
    let hit = false;
    for (const s of this.#inFlight.values()) if (s.abortJob(id, reason)) hit = true;
    return hit;
  }

  /** @internal New work may be claimable (a local add, a store notification): skip the rest of the poll wait. */
  wake(source: 'local' | 'push' = 'local'): void {
    if (source === 'push' && !this.#opts.notify) return;
    // While the queue is known paused, a local add finds nothing to claim: keep the slow paused poll.
    if (source === 'local' && this.#host.internals.isGloballyPaused()) return;
    this.#wakeUp();
  }

  /** Listen for a worker event; returns a function that stops listening. */
  on<K extends keyof WorkerEvents & string>(event: K, fn: Listener<D, R, K>): Unsubscribe {
    return this.#events.on(event, fn);
  }

  /** Listen for the next occurrence of a worker event only. */
  once<K extends keyof WorkerEvents & string>(event: K, fn: Listener<D, R, K>): Unsubscribe {
    return this.#events.once(event, fn);
  }

  /** Stop a listener added with `on` or `once`. */
  off<K extends keyof WorkerEvents & string>(event: K, fn: Listener<D, R, K>): void {
    this.#events.off(event, fn);
  }

  /** Claim for free slots until nothing is claimable, then sleep until woken or the poll delay passes. */
  async #loop(): Promise<void> {
    let claimBackoff = 0; // ms to wait after a failed claim; 0 after a success
    const { pollMax } = this.#opts;
    while (this.state === 'running') {
      // Liveness: only a claim that hangs while connected, or a loop that ended, stops this.
      this.#lastTick = platform.monotonicMs();
      // An outage pauses claiming; the client's probe says when the store is back.
      if (this.#storeDown()) {
        await this.#waitConnected(pollMax);
        continue;
      }
      const free = this.#wanted();
      if (free <= 0) {
        await this.#sleep(pollMax); // a freed slot or close wakes it sooner
        continue;
      }
      if (this.#paused.value) {
        await this.#sleep(pollMax); // resume or close wakes it sooner
        continue;
      }
      // The store moved to a format this pod cannot read: claim nothing; running jobs finish.
      if (this.#host.internals.isDegraded()) {
        await this.#sleep(pollMax);
        continue;
      }
      let res: ClaimResult | 'stopped' | 'paused';
      try {
        res = await this.#claimAndStart(free);
        claimBackoff = 0;
      } catch (e) {
        // Close gave up on this claim: it is not reported after `closed`; the sweeper recovers what it took.
        if (this.#givenUp.signal.aborted) break;
        // The store's format is one this release cannot read: a refusal for good, so report it once and stop.
        if (e instanceof StoreFormatError && e.recordKind === 'meta') {
          this.#report(e, 'store', 'claim');
          void this.close();
          break;
        }
        // The queue is being obliterated: nothing to claim and nothing to report.
        if (isObliterating(e)) {
          await this.#sleep(pollMax);
          continue;
        }
        // A store error never ends the loop: report, back off (100 ms ×2, at most 5 s) and try again.
        // After a connection error the loop then also waits for the store to come back.
        this.#report(e, 'store', 'claim');
        claimBackoff = Math.min(CLAIM_BACKOFF_MAX_MS, claimBackoff === 0 ? CLAIM_BACKOFF_MS : claimBackoff * 2);
        // Wake-ups do not cut this short, so an outage is not hammered at the rate of adds; close does.
        if (this.state === 'running') {
          await new Promise<void>((resolve) => {
            const t = platform.setTimer(done, claimBackoff, { ref: true });
            function done() {
              t?.cancel();
              resolve();
            }
            this.#endBackoff = done;
          });
          this.#endBackoff = undefined;
        }
        continue;
      }
      if (res === 'stopped') break;
      if (res === 'paused') continue;
      // While the queue is known to be paused, an empty claim polls slowly and checks the flag.
      const pausedEmpty = res.jobs.length === 0 && this.#host.internals.isGloballyPaused();
      if (pausedEmpty && !res.paused) this.#host.internals.checkPaused();
      const wait = this.#delay.next(pausedEmpty ? { ...res, paused: true } : res);
      // Jobs came back and slots remain: the queue may have more, so claim again without sleeping.
      if (res.jobs.length === 0 || this.#wanted() <= 0) {
        await this.#sleep(this.#wanted() > 0 ? wait : pollMax);
      }
      // MemoryStore answers in microtasks; yield a macrotask per batch so timers and I/O in the
      // same process are not starved while a backlog drains.
      if (res.jobs.length > 0 && this.state === 'running') await new Promise<void>((r) => platform.defer(r));
    }
  }

  /** Jobs the next claim may take: free slots, or for a batch worker what its batches can still hold. */
  #wanted(): number {
    const free = this.concurrency - this.#inFlight.size;
    return this.batching ? this.batching.wanted(free) : free;
  }

  /**
   * One claim, then its jobs started, or given back unrun (attempt refunded) when close or a pause came
   * meanwhile. `pause()` waits for this (`#cycle`).
   */
  async #claimAndStart(free: number): Promise<ClaimResult | 'stopped' | 'paused'> {
    const pauses = this.#pauses;
    let endCycle!: () => void;
    this.#cycle = new Promise((r) => (endCycle = r));
    try {
      const { res, sentAt, seq } = await this.#claim(free);
      const claim = { now: res.now, sentAt };
      if (this.state !== 'running') {
        await this.#releaseUnstarted(res.jobs, claim, 'shutdown');
        return 'stopped';
      }
      // The store says paused only when it holds back a job; jobs it handed out mean it is not paused.
      if (res.paused) this.#host.internals.observePaused(true, seq);
      else if (res.jobs.length > 0 && !res.recovered) this.#host.internals.observePaused(false, seq);
      // A pause came while the claim was out, even if a resume followed.
      if (this.#pauses !== pauses) {
        await this.#releaseUnstarted(res.jobs, claim, 'pause');
        return 'paused';
      }
      if (res.jobs.length > 0) this.#host.internals.drainedLatch.arm();
      let held = 0;
      for (const rec of res.jobs) {
        if (!this.#names.has(rec.name)) void this.#releaseUnhandled(rec, claim);
        else if (!this.batching) this.#start(rec, claim);
        else if (this.batching.hold(rec, claim)) {
          held++;
          this.#host.internals.metrics.attemptStarted(rec);
        }
      }
      this.batching?.afterClaim(held);
      return res;
    } finally {
      endCycle();
    }
  }

  /**
   * One claim request. Its `claimId` is reused only to repeat a claim whose outcome is unknown, while
   * any lease it may have taken can still be live, so the store returns those jobs instead of new ones.
   */
  async #claim(free: number): Promise<{ res: ClaimResult; sentAt: number; seq: number }> {
    const { client, scope } = this.#host;
    const pending = this.#pendingClaim;
    this.#pendingClaim = undefined;
    const claim = pending && platform.monotonicMs() - pending.firstSentAt < this.#host.minLeaseMs
      ? pending
      : { claimId: uuidv7(this.#lastStoreNow), firstSentAt: platform.monotonicMs() };
    const req = {
      workerId: this.id, limit: Math.min(free, client.capabilities.limits.maxClaimLimit, client.capabilities.skipLocked ? Infinity : SERIAL_CLAIM_LIMIT), leaseMs: this.#host.leaseMsFor(null),
      ...(this.#host.leaseMsByName && { leaseMsByName: this.#host.leaseMsByName }), names: [...this.#names], order: this.#host.internals.order, claimId: claim.claimId,
      maxFormat: client.__formatSupport.maxReadable,
      // The claim opens the attempt record, so it alone names the host.
      history: this.#host.internals.history && { ...this.#host.internals.history, host: this.#host.internals.host },
      ...(this.batching && { hold: true }),
    };
    try {
      const sentAt = platform.monotonicMs();
      const seq = this.#host.internals.pauseReadSeq();
      const res = await client.call('claim', scope, req);
      this.#lastStoreNow = res.now;
      return { res, sentAt, seq };
    } catch (e) {
      if (isStoreError(e) && e.outcomeUnknown) this.#pendingClaim = claim;
      throw e;
    }
  }

  /** A finalising write's wait between tries; a timed-out close ends it. Never keeps the process alive. */
  #retryWait(ms: number): Promise<void> {
    const signal = this.#givenUp.signal;
    return new Promise((resolve) => {
      const done = () => {
        t?.cancel();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const t = platform.setTimer(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** Wait for the store to come back, at most `ms`; close ends it too. */
  async #waitConnected(ms: number): Promise<void> {
    const bound = new AbortController();
    const timer = platform.setTimer(() => bound.abort(), ms, { ref: true });
    try {
      await this.#host.client.waitConnected(AbortSignal.any([this.#closing.signal, bound.signal]));
    } finally {
      timer?.cancel();
    }
  }

  #storeDown(): boolean {
    return this.#host.client.state === 'reconnecting';
  }

  /** The store returned a job this worker has no handler for: give it back unspent and report it. */
  async #releaseUnhandled(rec: JobRecord, claim: { now: number; sentAt: number }): Promise<void> {
    const message = `claimed job "${rec.id}" has name ${JSON.stringify(rec.name)}, which this worker has no handler for; released`;
    this.#report(new InternalError(message, { details: { jobId: rec.id, name: rec.name } }), 'internal', 'claim', rec.id);
    await this.#release(rec, false, leaseDeadline(rec, claim));
  }

  /** Give back claimed jobs whose handlers never started. */
  async #releaseUnstarted(recs: JobRecord[], claim: { now: number; sentAt: number }, reason: 'shutdown' | 'pause'): Promise<void> {
    await Promise.all(recs.map((rec) => this.#release(rec, false, leaseDeadline(rec, claim), reason)));
  }

  /** Release a started attempt once, however many paths ask. */
  #releaseStarted(a: Attempt, reason: 'shutdown' | 'pause' = 'shutdown'): Promise<ReleaseOutcome> {
    return (a.release ??= this.#release(a.rec, true, this.#keeper.deadline(a.rec.id, a.rec.lease!.token), reason));
  }

  /**
   * A fenced release with the attempt refunded, repeated after an unknown outcome until `deadline` (the
   * local lease deadline) or a close that ran out of time. A store error raised during close is kept for
   * close's AggregateError; otherwise it is reported.
   */
  #release(rec: JobRecord, handlerStarted: boolean, deadline: number | undefined, reason?: 'shutdown' | 'pause'): Promise<ReleaseOutcome> {
    const { client, scope } = this.#host;
    const req = { id: rec.id, token: rec.lease!.token, refundAttempt: true, handlerStarted, ...(reason && { reason }), history: this.#host.internals.history };
    const report = (e: SureQError) => this.#report(e, 'store', 'release', rec.id);
    const p = releaseLease(client, scope, req, {
      deadline,
      now: () => platform.monotonicMs(),
      sleep: (ms) => this.#retryWait(ms),
      signal: this.#givenUp.signal,
      // An unconfirmed release (its lease deadline came first) during close is also one of close's errors.
      report: (e) => {
        report(e);
        if (this.state === 'stopping') this.#releaseErrors.push(e);
      },
      raised: (e) => (this.state === 'stopping' ? this.#releaseErrors.push(e) : report(e)),
    });
    this.#releasing.set(p, rec.id);
    const done = () => void this.#releasing.delete(p);
    p.then(done, done);
    return p;
  }

  /** Wait `ms` (or until woken when undefined); returns at once if a wake-up came in since the last sleep. The poll loop's waits are ref'd: a running worker holds the process open. */
  #sleep(ms: number | undefined): Promise<void> {
    if (this.#woken) {
      // The wake came while a claim was out and that claim's result already moved the poll on: start over.
      this.#woken = false;
      this.#delay.reset();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        timer?.cancel();
        this.#wake = undefined;
        resolve();
      };
      const timer = ms === undefined ? undefined : platform.setTimer(done, ms, { ref: true });
      this.#wake = done;
    });
  }

  /** End the current sleep (or the next one, if none is running) and poll fast again. */
  #wakeUp(): void {
    if (this.#wake) {
      this.#delay.reset();
      this.#wake();
    } else this.#woken = true;
  }

  #start(rec: JobRecord, claim: { now: number; sentAt: number }): void {
    const token = rec.lease!.token;
    const attempt = `${rec.id}:${token}`;
    // The store handed back an attempt that is already running here: it runs once.
    if (this.#inFlight.has(attempt)) return;
    this.#host.internals.metrics.attemptStarted(rec);
    const abort = new AbortController();
    this.#keeper.track(rec, abort, claim);
    // The handler's job shows the lease as of the last renewal, and null once this attempt is untracked.
    const liveLease = () => this.#keeper.lease(rec.id, token) ?? null;
    // Stored data that cannot be read fails the attempt for good, without running the handler.
    const { job, poison } = toClaimedJob<D, R>(rec, rec.startedAt ?? rec.createdAt, this.#host.binding, liveLease);
    this.#events.emit('active', { job, workerId: this.id });
    const handler = this.#handlers.get(rec.name)!;
    const progress = this.#progressChannel(rec, 'progress', abort.signal);
    const ctx = createContext(job as Job, this.id, abort.signal, token, async (...args) => progress.push(this.#encodeProgress(args)));
    // Set once the handler returned or threw: a progress call after that is refused.
    let returned = false;
    const { timeoutMs, graceMs } = this.#timeoutFor(rec);
    // Resolved only when the grace runs out: the attempt fails without waiting for the handler.
    let abandoned: Promise<Outcome> = new Promise(() => {});
    let timer: { settled(): void } | undefined;
    if (timeoutMs !== undefined) {
      abandoned = new Promise((resolve) => {
        timer = startTimeout({
          timeoutMs, graceMs, abort, jobId: rec.id, attempt: rec.attempt,
          onAbandon: (err) => {
            // A lost (or cancelled) attempt fails nothing: its outcome is dropped, so there is nothing to warn about here.
            if (!this.#keeper.isLost(rec.id, token)) this.#host.internals.logger.warn('handler ignored its abort signal; the attempt is failed and the handler abandoned', {
              queue: this.#host.name, workerId: this.id, jobId: rec.id, attempt: rec.attempt,
            });
            resolve({ ok: false, err });
          },
        });
      });
    }
    // A lost (or cancelled) attempt's outcome is dropped anyway: one that ignores its abort frees its slot after the grace.
    let lostTimer: Timer | undefined;
    const dropped = new Promise<Outcome>((resolve) => {
      abort.signal.addEventListener('abort', () => {
        if (!this.#keeper.isLost(rec.id, token)) return;
        progress.close(abort.signal.reason as Error);
        lostTimer = platform.setTimer(() => {
          this.#host.internals.logger.warn('handler ignored its abort signal after its lease was lost or its job cancelled; its slot is freed and its result ignored', {
            queue: this.#host.name, workerId: this.id, jobId: rec.id, attempt: rec.attempt,
          });
          resolve({ ok: false, err: abort.signal.reason });
        }, graceMs);
      }, { once: true });
    });
    // Once the signal aborted for the timeout, whatever the handler did is replaced by the timeout.
    const timedOut = (outcome: Outcome): Outcome => {
      timer?.settled();
      const own = failRecordOr(ctx, outcome);
      const reason: unknown = abort.signal.reason;
      if (!(reason instanceof JobTimeoutError)) return own;
      const fields = { jobId: reason.jobId, attempt: reason.attempt, timeoutMs: reason.timeoutMs, graceMs: reason.graceMs, abandoned: false };
      return { ok: false, err: new JobTimeoutError(fields, own.ok ? {} : { cause: own.err }) };
    };
    // The handler promise never rejects, so an abandoned handler failing later is never unhandled.
    let ran: Promise<Outcome>;
    if (poison) {
      returned = true;
      timer?.settled();
      ran = Promise.resolve({ ok: false, err: poison, retry: false });
    } else {
      ran = Promise.resolve()
        .then(() => handler(job as Job, ctx))
        .then(
          (value): Outcome => ((returned = true), timedOut({ ok: true, value })),
          (err: unknown): Outcome => ((returned = true), timedOut({ ok: false, err })),
        );
    }
    // Closing first drops the answer of a progress write still out, so its refusal after the release is no lost lease.
    const giveBack = () => {
      progress.close(abort.signal.reason as Error);
      return this.#releaseStarted(a);
    };
    const a: Attempt = {
      key: attempt, rec, done: Promise.resolve(), running: true, discarded: false, jobIds: [rec.id],
      shutdown: (reason) => {
        if (this.#keeper.isLost(rec.id, token)) return false;
        a.discarded = true;
        abort.abort(reason);
        progress.close(reason);
        return true;
      },
      abandon: () => giveBack().then(() => this.#keeper.untrack(rec.id, token)),
      abortJob: (id, reason) => id === rec.id && this.#keeper.discard(id, reason, token),
    };
    a.done = Promise.race([ran, abandoned, dropped])
      .then(async (outcome) => {
        a.running = false;
        // A lost lease discards the outcome: no write, no event.
        if (this.#keeper.isLost(rec.id, token)) return this.#keeper.stopHeartbeat(rec.id, token);
        // Aborted by shutdown: the outcome is not trusted; the job goes back, keeping its lease until then.
        if (a.discarded) return void (await giveBack());
        // The last value lands before complete or fail, which would refuse it once the job left active.
        // Not past the lease deadline: a hung progress write must not hold back the fenced finalising write.
        await progress.flush(this.#keeper.deadline(rec.id, token), abort.signal.aborted ? (abort.signal.reason as Error) : undefined);
        progress.close(returned ? undefined : (abort.signal.reason as Error));
        if (this.#keeper.isLost(rec.id, token)) return this.#keeper.stopHeartbeat(rec.id, token);
        this.#keeper.stopHeartbeat(rec.id, token);
        await this.#settle(rec, job, outcome);
      })
      .catch((e: unknown) => this.#failStranded(rec, job, e))
      .finally(() => {
        lostTimer?.cancel();
        progress.close();
        this.#keeper.untrack(rec.id, token);
        this.#inFlight.delete(attempt);
        this.#wakeUp();
      });
    this.#inFlight.set(attempt, a);
  }

  /**
   * The progress writes of one attempt's `field`. A refused write is a lost lease or a cancel: it aborts `signal`,
   * and the waiting calls reject with its reason. A store error drops the value and is reported once per outage
   * (failed writes of any of this worker's jobs in a row, until one gets an answer).
   */
  #progressChannel(rec: JobRecord, field: NonNullable<SetProgressRequest['field']>, signal: AbortSignal): ProgressChannel {
    const { client, scope, binding } = this.#host;
    const token = rec.lease!.token;
    return new ProgressChannel({
      intervalMs: this.#opts.progressInterval,
      now: () => platform.monotonicMs(),
      write: async (p) => {
        const res = await client.call('setProgress', scope, { id: rec.id, token, progress: p, ...(field === 'batchProgress' && { field }) });
        this.#progressFailing = false;
        return res;
      },
      onWritten: (value, updatedAt) => {
        if (field !== 'progress') return;
        const job = toJob<D, R>({ ...rec, progress: { value, updatedAt } }, updatedAt, binding);
        this.#events.emit('progress', { job, progress: job.progress! });
      },
      onRejected: async (r) => {
        // The attempt stays tracked: the handler is still running, and its end sees the loss.
        await this.#fenced(rec, r, false);
        return (signal.reason as Error | undefined) ?? new LeaseLostError({ jobId: rec.id, token, reason: r.reason });
      },
      // an obliterating queue refuses the write; the fence ends the attempt, so there is nothing to report
      onError: (e) => {
        if (isObliterating(e) || this.#progressFailing) return;
        this.#progressFailing = true;
        this.#report(e, 'store', 'setProgress', rec.id);
      },
    });
  }

  /** One progress call's arguments, validated and encoded; throws for a bad call, which then changes nothing. */
  #encodeProgress(args: readonly unknown[], o: { baseAt?: number; scope?: string } = {}): string {
    return encodeProgress(args, { maxBytes: this.#opts.maxProgressBytes, queue: this.#host.name, ...o });
  }

  #timeoutFor(rec: JobRecord): { timeoutMs: number | undefined; graceMs: number } {
    return resolveTimeout(
      rec,
      { timeoutMs: this.#opts.timeout, graceMs: this.#opts.timeoutGrace },
      { timeoutMs: this.#host.internals.timeout, graceMs: this.#host.internals.timeoutGrace },
    );
  }

  /** Record one attempt's outcome: the result or the failure decision, written through the finalising retry. */
  async #settle(rec: JobRecord, active: Job<D, R>, outcome: Outcome): Promise<Settled> {
    const { client, scope } = this.#host;
    const { maxErrorBytes, storeStacks, history, deadLetter, retention } = this.#host.internals;
    const token = rec.lease!.token;
    let failure: unknown;
    // A result that cannot be stored fails the job for good: re-running the handler would produce it again.
    let unrecoverable = false;
    if (outcome.ok) {
      let encoded: { result: string | null } | undefined;
      try {
        encoded = { result: encodeResult(outcome.value, this.#host.internals.maxResultBytes, rec.id) ?? null };
      } catch (e) {
        failure = e;
        unrecoverable = true;
      }
      if (encoded !== undefined) {
        const ext = finishExt(retention, rec, 'completed');
        const removed = ext.retention?.discard === true;
        const complete = { id: rec.id, token, ...encoded, history, ...ext };
        return this.#finalize('complete', rec, () => client.call('complete', scope, complete), async (now) => {
          // Listeners see what a later getJob sees: the stored, round-tripped result and store-time duration.
          const job = removed ? this.#removedJob(rec, { state: 'completed', result: complete.result }, now) : await this.#snapshot(rec.id, active, now);
          const durationMs = job.finishedAt !== null && job.startedAt !== null ? Math.max(0, job.finishedAt - job.startedAt) : 0;
          this.#events.emit('completed', { job, result: job.result as Jsonify<R>, durationMs, ...(removed && { removed }) });
          await this.#evaluateDrained();
        });
      }
    } else failure = outcome.err;
    // Result errors behave exactly like ctx.fail(err, { retry: false }).
    const ctxRetry = unrecoverable ? false : !outcome.ok ? outcome.retry : undefined;
    const decision = await decideFailure({
      err: failure,
      job: active as Job,
      ...(ctxRetry !== undefined && { ctxFail: { retry: ctxRetry } }),
      ...(this.#opts.retryIf && { retryIf: this.#opts.retryIf }),
      attempt: rec.attempt,
      maxAttempts: rec.maxAttempts,
      unwrapCause: this.#opts.unwrapCause,
      backoff: parsePayload(rec.backoff) as StoredBackoff,
      strategies: this.#opts.backoffStrategies ?? {},
      random: this.#opts.random ?? Math.random,
    });
    for (const r of decision.reports) this.#report(r.error, r.source, 'retry', rec.id);
    const error = serializeError(toError(failure), { maxErrorBytes, storeStacks });
    const stored = JSON.stringify(error);
    if (decision.action === 'retry') {
      const { delayMs } = decision;
      // The store fails it for good when it has no attempts left after all, so the reason goes with the retry.
      const dl = deadLetterExt(deadLetter, rec, 'exhausted');
      // Only the retention: a retry closes its history as usual; the store applies it if it fails the job for good after all.
      const kept = dl === false ? finishExt(retention, rec, 'failed').retention : undefined;
      const fail = { id: rec.id, token, error: stored, retryInMs: delayMs, history, deadLetter: dl, ...(kept && { retention: kept }) };
      return this.#finalize('fail', rec, () => client.call('fail', scope, fail), async (now) => {
        const job = await this.#snapshot(rec.id, active, now);
        this.#events.emit('retrying', { job, error, delayMs, runAt: job.runAt });
      });
    }
    const { reason } = decision;
    const { fail, removed } = this.#finalFail(rec, token, stored, DEAD_LETTER_REASON[reason]);
    return this.#finalize('fail', rec, () => client.call('fail', scope, fail), async (now) => {
      const job = removed ? this.#removedJob(rec, { state: 'failed', error: stored }, now) : await this.#snapshot(rec.id, active, now);
      this.#events.emit('failed', { job, error, reason, ...(removed && { removed }) });
      this.#emitDeadLettered(job);
      await this.#evaluateDrained();
    });
  }

  /**
   * Write an attempt's outcome, repeated until the local lease deadline; `emit` runs once it landed.
   * The slot stays taken until then. An outcome that cannot be confirmed is reported and dropped.
   */
  async #finalize(operation: 'complete' | 'fail', rec: JobRecord, write: () => Promise<FinalResult>, emit: (now: number) => Promise<void>): Promise<Settled> {
    const jobId = rec.id;
    const r = await finalize(write, {
      operation,
      jobId,
      // The heartbeat has stopped, so this is the deadline as of the handler's end.
      deadline: this.#keeper.deadline(jobId, rec.lease!.token),
      now: () => platform.monotonicMs(),
      sleep: (ms) => this.#retryWait(ms),
      signal: this.#givenUp.signal,
      report: (e) => this.#report(e, 'store', operation, jobId),
    });
    if ('unconfirmed' in r) return 'unconfirmed';
    if (!r.ok) return this.#fenced(rec, r);
    const outcome = operation === 'complete' ? 'completed' : (r as Extract<FailResult, { ok: true }>).state === 'failed' ? 'failed' : 'retried';
    this.#host.internals.metrics.attemptEnded(rec, outcome, r.now);
    await emit(r.now);
    return 'committed';
  }

  /**
   * The store refused a finalising write: the job was cancelled (abort with JobCancelledError, nothing
   * reported), or the lease is gone, which is `leaseLost`, never a failure. When the attempt is no longer
   * tracked, the event is emitted here. `untrack: false` keeps a running handler's attempt tracked.
   */
  async #fenced(rec: JobRecord, rejection: FencedRejection, untrack = true): Promise<'lost' | 'cancelled'> {
    const token = rec.lease!.token;
    const { reason } = rejection;
    if ((await lossReason(this.#host.client, this.#host.scope, rec.id, rejection)) === 'cancelled') {
      this.#keeper.discard(rec.id, new JobCancelledError({ jobId: rec.id }), token);
      return 'cancelled';
    }
    if (this.#keeper.lease(rec.id, token)) {
      this.#keeper.lost(rec.id, reason, token);
      if (untrack) this.#keeper.untrack(rec.id, token);
    } else this.#emitLeaseLost(rec, token, reason);
    return 'lost';
  }

  /** The event's job shows `lease: null`: this attempt no longer holds it. */
  #emitLeaseLost(rec: JobRecord, token: number, reason: FencedRejection['reason']): void {
    // Runs from the lease timer and from detached renews, so it must not throw on a job with unreadable stored data.
    const { job } = toClaimedJob<D, R>({ ...rec, lease: null }, rec.startedAt ?? rec.createdAt, this.#host.binding);
    this.#events.emit('leaseLost', { job, token, reason });
  }

  /**
   * Recording an attempt's outcome threw (a bug or a hostile value): report it and still fail the
   * job for good, so nothing is left `active` with no one to finish it.
   */
  async #failStranded(rec: JobRecord, active: Job<D, R>, e: unknown): Promise<void> {
    this.#report(e, 'internal', 'settle', rec.id);
    const { client, scope } = this.#host;
    const { maxErrorBytes, storeStacks } = this.#host.internals;
    const err = new InternalError('the job outcome could not be recorded', { cause: e });
    const error = serializeError(err, { maxErrorBytes, storeStacks });
    const stored = JSON.stringify(error);
    const { fail, removed } = this.#finalFail(rec, rec.lease!.token, stored, 'unrecoverable');
    try {
      await this.#finalize('fail', rec, () => client.call('fail', scope, fail), async (now) => {
        const job = removed ? this.#removedJob(rec, { state: 'failed', error: stored }, now) : await this.#snapshot(rec.id, active, now);
        this.#events.emit('failed', { job, error, reason: 'unrecoverable', ...(removed && { removed }) });
        this.#emitDeadLettered(job);
        await this.#evaluateDrained();
      });
    } catch (again) {
      this.#report(again, 'internal', 'settle', rec.id);
    }
  }

  /** A final fail: a dead letter, or (not dead-lettered) the failed policy; `removed` when the store deletes the job with it. */
  #finalFail(rec: JobRecord, token: number, error: string, reason: Exclude<DeadLetterReason, 'crashLimit' | 'legacy'>): { fail: FailRequest; removed: boolean } {
    const { history, deadLetter, retention } = this.#host.internals;
    const dl = deadLetterExt(deadLetter, rec, reason);
    const ext = dl === false ? finishExt(retention, rec, 'failed') : {};
    return { fail: { id: rec.id, token, error, history, deadLetter: dl, ...ext }, removed: ext.retention?.discard === true };
  }

  /** The job as a write that deleted it left it (`retention.discard`), from the claimed record: the store has nothing to read. */
  #removedJob(rec: JobRecord, patch: Pick<JobRecord, 'state'> & Partial<JobRecord>, now: number): Job<D, R> {
    return toClaimedJob<D, R>({ ...rec, ...patch, lease: null, finishedAt: now }, now, this.#host.binding).job;
  }

  /** Right after `failed`: `deadLettered` when the stored job carries the marker. */
  #emitDeadLettered(job: Job<D, R>): void {
    if (job.deadLetter) this.#events.emit('deadLettered', { job, reason: job.deadLetter.reason });
  }

  /** After a job left for good: emit `drained` if the queue has just become empty. */
  async #evaluateDrained(): Promise<void> {
    try {
      await this.#host.internals.drainedLatch.evaluate(() => this.#events.emit('drained', { queue: this.#host.name }));
    } catch (e) {
      this.#report(e, 'store', 'counts');
    }
  }

  /**
   * The job as stored now; the active snapshot when the store cannot be read (it may be down). `now` is the
   * store time of the write just made: a retry due by then reads `waiting`.
   */
  async #snapshot(id: string, fallback: Job<D, R>, now: number): Promise<Job<D, R>> {
    const { client, scope } = this.#host;
    try {
      const rec = await client.call('get', scope, id);
      return rec ? toJob<D, R>(rec, now, this.#host.binding) : fallback;
    } catch {
      return fallback;
    }
  }

  #report(e: unknown, source: ErrorSource, operation: string, jobId?: string): void {
    const error: SureQError = isSureQError(e) ? e : new InternalError(`worker ${operation} failed`, { cause: e });
    this.#reporter(error, source, { operation, ...(jobId !== undefined && { jobId }) });
  }
}

/** A worker that hands its handler up to `batchSize` jobs at once. Made by `queue.processBatch`. */
export class BatchWorker<D = unknown, R = unknown> extends Worker<D, R> {
  /** `flush()` closes the forming batch now and resolves with the jobs handed to the handler; `held` counts the jobs waiting for it. */
  readonly batch: { flush(): Promise<number>; readonly held: number };

  /** @internal Use `queue.processBatch`. */
  constructor(host: WorkerHost, setup: BatchSetup, opts: ResolvedWorkerOptions & Polling) {
    super(host, new Map(), opts, setup);
    const batching = this.batching!;
    this.batch = Object.freeze({
      flush: () => batching.flush(),
      get held() {
        return batching.held;
      },
    });
  }
}
