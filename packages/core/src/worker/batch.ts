import { AlreadySettledError, BatchResultMismatchError, InvalidOptionError, JobCancelledError, JobTimeoutError, LeaseLostError, type ShutdownError } from '../errors/catalog.js';
import type { Job } from '../job/job.js';
import type { Logger } from '../logger/logger.js';
import type { JobRecord } from '../store/contract.js';
import { uuidv7 } from '../util/uuidv7.js';
import type { LeaseKeeper } from './lease.js';
import type { ProgressChannel, ProgressObject } from './progress.js';
import type { ReleaseOutcome } from './lifecycle.js';
import type { Settled, Slot } from './slot.js';
import { startTimeout } from './timeout.js';
import { platform, type Timer } from '../platform/index.js';

/** One job of a batch: the job plus its own abort signal. */
export type BatchJob<D = unknown, R = unknown> = Job<D, R> & {
  /** Aborted for this job only: its lease was lost (LeaseLostError) or it was cancelled (JobCancelledError). */
  readonly signal: AbortSignal;
  /** The job was cancelled while in this batch; its outcome is discarded. */
  readonly cancelled: boolean;
};

/** The jobs handed to one batch handler call, in claim order; never empty. */
export interface Batch<D = unknown, R = unknown> {
  /** The batch id, also written to each job's attempt record. */
  readonly id: string;
  /** The jobs in the batch, in claim order. */
  readonly jobs: ReadonlyArray<BatchJob<D, R>>;
}

/** What a batch handler gets besides the batch. */
export interface BatchContext<D = unknown, R = unknown> {
  /** Aborted for the whole batch: shutdown, the handler timeout, or every job lost or cancelled. */
  readonly signal: AbortSignal;
  /** Complete one job now; its result is written at once. */
  complete(job: BatchJob<D, R>, result: R): Promise<void>;
  /** Fail one job now; `{ retry: false }` makes it final. */
  fail(job: BatchJob<D, R>, error: unknown, opts?: { retry?: boolean }): Promise<void>;
  /** The job's outcome was given, early or at the end of the batch. */
  isSettled(job: BatchJob<D, R>): boolean;
  /** Report one job's progress, stored in its `progress` field; rejects with that job's reason once it is lost or cancelled. */
  progress(job: BatchJob<D, R>, n: number, total?: number, message?: string): Promise<void>;
  /** Report one job's progress as a plain object of your own, such as `{ stage: 'render' }`. */
  progress(job: BatchJob<D, R>, value: ProgressObject): Promise<void>;
  /**
   * Report the batch's progress, stored in the `batchProgress` field of every job not settled, lost or cancelled;
   * its ETA runs from the batch's earliest start. Rejects only for bad arguments.
   */
  batchProgress(n: number, total?: number, message?: string): Promise<void>;
  /** Report the batch's progress as a plain object of your own, such as `{ stage: 'render' }`. */
  batchProgress(value: ProgressObject): Promise<void>;
}

/** One element per job, in the batch's order; a TaskFailure fails that job. */
export type BatchResults<R> = ReadonlyArray<R | TaskFailure>;

/** Runs one batch. Returning nothing completes every job not settled yet; a throw fails them all. */
export type BatchHandler<D = unknown, R = unknown> = (batch: Batch<D, R>, ctx: BatchContext<D, R>) => Promise<BatchResults<R> | void>;

/** A batch result element that fails its job; `retry: false` makes it final. */
export class TaskFailure {
  /** The job's error. */
  readonly error: unknown;
  /** False makes the failure final; otherwise the job's retry rules apply. */
  readonly retry: boolean | undefined;
  constructor(error: unknown, opts?: { retry?: boolean }) {
    this.error = error;
    this.retry = opts?.retry;
  }
}

export type Outcome = { ok: true; value: unknown } | { ok: false; err: unknown; retry?: boolean };

/** A batch worker's settings, resolved. */
export interface BatchSetup {
  readonly handler: BatchHandler;
  readonly size: number;
  readonly delayMs: number;
  readonly maxWaitMs: number;
  readonly onShutdown: 'flush' | 'release';
}

/** What batching needs from its worker. */
export interface BatchHost {
  readonly keeper: LeaseKeeper;
  readonly logger: Logger;
  readonly ids: { queue: string; workerId: string };
  /** The handler's view of a claimed job, its lease live. */
  /** The job a handler sees; `poison` when its stored data cannot be deserialized. */
  toClaimedJob(rec: JobRecord): { job: Job; poison?: Error };
  emitActive(job: Job): void;
  /** Record one job's outcome: retry decision, fenced write, events. */
  settle(rec: JobRecord, job: Job, outcome: Outcome): Promise<Settled>;
  /** Give a job back with its attempt refunded, retried until its local lease deadline. */
  release(rec: JobRecord, handlerStarted: boolean, reason?: 'shutdown' | 'pause'): Promise<ReleaseOutcome>;
  /** The job's time limit, as a single-job handler would have it. */
  timeoutFor(rec: JobRecord): { timeoutMs: number | undefined; graceMs: number };
  /** The progress writes of one job's `field`; a refused write aborts `signal`. */
  progressChannel(rec: JobRecord, field: 'progress' | 'batchProgress', signal: AbortSignal): ProgressChannel;
  /** Validate and encode one progress call; throws for a bad one. */
  encodeProgress(args: readonly unknown[], o?: { baseAt?: number; scope?: string }): string;
  addSlot(slot: Slot): void;
  /** The slot is done: free it and wake the loop. */
  freed(slot: Slot): void;
}

type Claim = { now: number; sentAt: number };

interface Entry {
  readonly rec: JobRecord;
  readonly token: number;
  readonly abort: AbortController;
}

/** A job of a running batch; `settled` is set by the first settle and is the single source of the double-settle rule. */
interface Task {
  readonly entry: Entry;
  readonly job: Job;
  readonly batchJob: BatchJob;
  /** The job's own progress and the batch roll-up, flushed before its outcome is written. */
  readonly channels: { progress: ProgressChannel; batchProgress: ProgressChannel };
  settled: Promise<Settled> | undefined;
  /** Set when the job's stored data cannot be deserialized: it fails for good and stays out of the batch. */
  readonly poison?: Error;
}

/** A worker's batching: at most one forming batch, filled by the worker's claims. */
export class Batching {
  readonly #host: BatchHost;
  readonly #setup: BatchSetup;
  #forming: BatchSlot | undefined;

  constructor(host: BatchHost, setup: BatchSetup) {
    this.#host = host;
    this.#setup = setup;
  }

  /** Jobs the next claim may take: what the forming batch still lacks, else a whole batch when a slot is free. */
  wanted(freeSlots: number): number {
    // ponytail: one forming batch per worker, not one per free slot; it holds a slot from its first job, so
    // held plus running jobs stay within concurrency x batchSize. Form one per slot if partial batches pile up.
    if (this.#forming) return this.#setup.size - this.#forming.held;
    return freeSlots > 0 ? this.#setup.size : 0;
  }

  /** Jobs claimed and waiting for their batch to close. */
  get held(): number {
    return this.#forming?.held ?? 0;
  }

  /** Hold one claimed job in the forming batch (a new one when none forms); false when it is already here. */
  hold(rec: JobRecord, claim: Claim): boolean {
    // The store returned an attempt already held or running here (a repeated claim): it runs once.
    if (this.#host.keeper.lease(rec.id, rec.lease!.token)) return false;
    if (!this.#forming) {
      const slot = new BatchSlot(this.#host, this.#setup, () => {
        if (this.#forming === slot) this.#forming = undefined;
      });
      this.#forming = slot;
      this.#host.addSlot(slot);
    }
    this.#forming.hold(rec, claim);
    return true;
  }

  /** One claim's jobs are held: close on size, or restart the quiet timer. */
  afterClaim(added: number): void {
    this.#forming?.afterClaim(added);
  }

  /** Close the forming batch now; resolves with the jobs handed to the handler. */
  flush(): Promise<number> {
    return this.#forming?.close() ?? Promise.resolve(0);
  }

  /** The worker is closing: run the forming batch now (`'flush'`) or give its jobs back unrun (`'release'`). */
  closing(): void {
    if (this.#setup.onShutdown === 'flush') void this.#forming?.close();
    else this.#forming?.release();
  }
}

/** One batch: forming while it holds claimed jobs, then running its handler once. */
export class BatchSlot implements Slot {
  readonly key = uuidv7();
  readonly done: Promise<void>;
  readonly #host: BatchHost;
  readonly #setup: BatchSetup;
  readonly #closed: () => void;
  readonly #entries = new Map<string, Entry>();
  readonly #beforeSettle = new Map<string, Array<() => Promise<void>>>();
  readonly #onAbort = new Map<string, Array<(reason: Error) => void>>();
  /** Shutdown aborted the handler: unsettled jobs are released whatever it returns. */
  #discarded = false;
  #givingBack: Promise<void> | undefined;
  /** The running batch's jobs, kept after the handler ends so `jobIds` counts only the unsettled ones. */
  #tasks: Task[] | undefined;
  /** Set while the handler runs. */
  #handlerRun: { batchAbort: AbortController; tasks: Task[]; dropped(): void; clear?: () => void } | undefined;
  #phase: 'forming' | 'starting' | 'running' | 'over' = 'forming';
  #quiet: Timer | undefined;
  #maxWait: Timer | undefined;
  #delivered: Promise<number> | undefined;
  #end!: () => void;

  constructor(host: BatchHost, setup: BatchSetup, closed: () => void) {
    this.#host = host;
    this.#setup = setup;
    this.#closed = closed;
    this.done = new Promise((r) => (this.#end = r));
  }

  get running(): boolean {
    return this.#phase === 'forming' || this.#phase === 'starting' || this.#handlerRun !== undefined;
  }

  /** Jobs held or not settled yet. */
  get jobIds(): readonly string[] {
    const tasks = this.#handlerRun?.tasks ?? this.#tasks;
    if (!tasks) return [...this.#entries.keys()];
    return tasks.filter((t) => t.settled === undefined).map((t) => t.entry.rec.id);
  }

  get held(): number {
    return this.#phase === 'forming' ? this.#entries.size : 0;
  }

  hold(rec: JobRecord, claim: Claim): void {
    const token = rec.lease!.token;
    const abort = new AbortController();
    const entry: Entry = { rec, token, abort };
    this.#host.keeper.track(rec, abort, claim);
    this.#entries.set(rec.id, entry);
    abort.signal.addEventListener('abort', () => this.#aborted(entry), { once: true });
    if (this.#entries.size === 1) this.#maxWait = platform.setTimer(() => void this.close(), this.#setup.maxWaitMs);
  }

  afterClaim(added: number): void {
    if (this.#phase !== 'forming' || added === 0) return;
    if (this.#entries.size >= this.#setup.size || this.#setup.delayMs === 0) return void this.close();
    this.#quiet?.cancel();
    this.#quiet = platform.setTimer(() => void this.close(), this.#setup.delayMs);
  }

  /** Close the batch (once): start every job, then run the handler. Resolves with the jobs handed to it. */
  close(): Promise<number> {
    return (this.#delivered ??= this.#start());
  }

  /** Close's timeout: abort `ctx.signal`; whatever the handler does now, its unsettled jobs are released. */
  shutdown(reason: ShutdownError): boolean {
    // Still sending the started renews: the handler never runs; the jobs go back unrun.
    if (this.#phase === 'starting') {
      this.#discarded = true;
      return true;
    }
    const run = this.#handlerRun;
    if (!run || run.tasks.every((t) => t.entry.abort.signal.aborted)) return false;
    this.#discarded = true;
    run.batchAbort.abort(reason);
    for (const t of run.tasks) for (const c of Object.values(t.channels)) c.close(reason);
    return true;
  }

  /** The handler ignored the shutdown abort: release its unsettled jobs now, handler started. */
  async abandon(): Promise<void> {
    if (this.#phase === 'starting') return this.#releaseHeld();
    await Promise.all((this.#handlerRun?.tasks ?? []).map((t) => t.settled ?? this.#giveBack(t)));
  }

  /** Give the held jobs back unrun, attempts refunded, and end the batch. */
  release(): void {
    if (this.#phase !== 'forming') return;
    this.#phase = 'starting';
    this.#quiet?.cancel();
    this.#maxWait?.cancel();
    this.#closed();
    void this.#releaseHeld().finally(() => this.#finish());
  }

  /** Release every held job (once): handler not started, attempt refunded. */
  #releaseHeld(): Promise<void> {
    const { keeper } = this.#host;
    return (this.#givingBack ??= Promise.all([...this.#entries.values()].map(async ({ rec, token }) => {
      keeper.stopHeartbeat(rec.id, token);
      try {
        await this.#host.release(rec, false, 'shutdown');
      } finally {
        keeper.untrack(rec.id, token);
      }
    })).then(() => undefined));
  }

  abortJob(id: string, reason: Error): boolean {
    const entry = this.#entries.get(id);
    return entry !== undefined && this.#host.keeper.discard(id, reason, entry.token);
  }

  /** Run `fn` once when this job is lost or cancelled while its batch runs. */
  onAbort(jobId: string, fn: (reason: Error) => void): void {
    const list = this.#onAbort.get(jobId) ?? [];
    this.#onAbort.set(jobId, [...list, fn]);
  }

  /**
   * A job was lost or cancelled. While forming it just leaves the batch. While the handler runs only its own
   * signal aborts; once every job is gone `ctx.signal` aborts too, and a handler ignoring it frees the slot after the grace.
   */
  #aborted(entry: Entry): void {
    if (this.#phase === 'forming') {
      this.#drop(entry);
      if (this.#entries.size === 0) this.#finish();
      return;
    }
    const reason = entry.abort.signal.reason as Error;
    for (const fn of this.#onAbort.get(entry.rec.id) ?? []) fn(reason);
    const run = this.#handlerRun;
    if (!run || run.batchAbort.signal.aborted || !run.tasks.every((t) => t.entry.abort.signal.aborted)) return;
    run.batchAbort.abort(reason);
    const timer = platform.setTimer(() => {
      this.#host.logger.warn('batch handler ignored its abort signal after every job was lost or cancelled; its slot is freed', { ...this.#host.ids, batchId: this.key });
      run.dropped();
    }, this.#host.timeoutFor(entry.rec).graceMs);
    run.clear = () => timer?.cancel();
  }

  #drop(entry: Entry): void {
    this.#entries.delete(entry.rec.id);
    this.#host.keeper.untrack(entry.rec.id, entry.token);
  }

  async #start(): Promise<number> {
    this.#quiet?.cancel();
    this.#maxWait?.cancel();
    this.#closed();
    if (this.#phase !== 'forming') return 0;
    this.#phase = 'starting';
    const { keeper } = this.#host;
    const held = [...this.#entries.values()];
    const started = await Promise.all(held.map((e) => keeper.markStarted(e.rec.id, e.token, this.key)));
    held.forEach((e, i) => {
      if (!started[i] || e.abort.signal.aborted) this.#drop(e);
    });
    // Close's timeout came while the jobs were being started: give them back instead of running the handler.
    if (this.#discarded) {
      await this.#releaseHeld();
      this.#finish();
      return 0;
    }
    const live = [...this.#entries.values()];
    if (live.length === 0) {
      this.#finish();
      return 0;
    }
    this.#phase = 'running';
    void this.#run(live);
    return live.length;
  }

  async #run(live: Entry[]): Promise<void> {
    const batchAbort = new AbortController();
    const tasks: Task[] = live.map((entry) => {
      const { job, poison } = this.#host.toClaimedJob(entry.rec);
      const signal = entry.abort.signal;
      const batchJob = Object.freeze(Object.defineProperties({}, {
        ...Object.getOwnPropertyDescriptors(job),
        signal: { value: signal, enumerable: true },
        cancelled: { get: () => signal.aborted && signal.reason instanceof JobCancelledError, enumerable: true },
      })) as BatchJob;
      const channels = {
        progress: this.#host.progressChannel(entry.rec, 'progress', signal),
        batchProgress: this.#host.progressChannel(entry.rec, 'batchProgress', signal),
      };
      const both = [channels.progress, channels.batchProgress];
      this.beforeSettle(entry.rec.id, async () => {
        // Not past the job's lease deadline: a hung progress write must not hold back its fenced outcome.
        const deadline = this.#host.keeper.deadline(entry.rec.id, entry.token);
        const { signal } = entry.abort;
        await Promise.all(both.map((c) => c.flush(deadline, signal.aborted ? (signal.reason as Error) : undefined)));
        for (const c of both) c.close();
      });
      this.onAbort(entry.rec.id, (reason) => {
        for (const c of both) c.close(reason);
      });
      return { entry, job, batchJob, channels, settled: undefined, ...(poison && { poison }) };
    });
    // The batch's ETA baseline: a reader of one job cannot see when the others started.
    const baseAt = Math.min(...live.map((e) => e.rec.startedAt ?? e.rec.createdAt));
    this.#tasks = tasks;
    // Jobs whose stored data cannot be read fail for good now; the handler gets the rest.
    const runnable = tasks.filter((t) => !t.poison);
    const byJob = new Map(runnable.map((t) => [t.batchJob, t]));
    const early = (job: BatchJob, outcome: Outcome): Promise<void> => {
      const t = byJob.get(job);
      if (!t) return Promise.reject(new InvalidOptionError('BatchContext', [{ path: 'job', code: 'invalid_value', message: 'expected a job of this batch' }]));
      if (t.settled) return Promise.reject(new AlreadySettledError({ jobId: t.entry.rec.id }));
      const { signal } = t.entry.abort;
      const { rec, token } = t.entry;
      // A lost or cancelled job's outcome is discarded: the call rejects with why.
      const why = (): Error => (signal.reason as Error | undefined) ?? new LeaseLostError({ jobId: rec.id, token, reason: 'expired' });
      if (signal.aborted) return Promise.reject(why());
      // Aborted by shutdown: as for a single job, nothing the handler reports now is written.
      if (this.#discarded) return Promise.reject(batchAbort.signal.reason as Error);
      return this.#settle(t, outcome).then((r) => {
        if (r === 'lost' || r === 'cancelled') throw why();
      });
    };
    const ctx: BatchContext = Object.freeze({
      signal: batchAbort.signal,
      complete: (job: BatchJob, result: unknown) => early(job, { ok: true, value: result }),
      fail: (job: BatchJob, err: unknown, opts?: { retry?: boolean }) => {
        const retry: unknown = opts?.retry;
        if (retry !== undefined && typeof retry !== 'boolean') {
          return Promise.reject(new InvalidOptionError('BatchContext.fail', [{ path: 'retry', code: 'invalid_type', message: 'expected boolean', expected: 'boolean' }]));
        }
        return early(job, retry === undefined ? { ok: false, err } : { ok: false, err, retry });
      },
      isSettled: (job: BatchJob) => byJob.get(job)?.settled !== undefined,
      progress: async (job: BatchJob, ...args: unknown[]) => {
        const t = byJob.get(job);
        if (!t) throw new InvalidOptionError('BatchContext', [{ path: 'job', code: 'invalid_value', message: 'expected a job of this batch' }]);
        const payload = this.#host.encodeProgress(args);
        if (t.entry.abort.signal.aborted) throw t.entry.abort.signal.reason as Error;
        if (t.settled) throw new AlreadySettledError({ jobId: t.entry.rec.id });
        return t.channels.progress.push(payload);
      },
      batchProgress: async (...args: unknown[]) => {
        const payload = this.#host.encodeProgress(args, { baseAt, scope: 'ctx.batchProgress' });
        const live = tasks.filter((t) => t.settled === undefined && !t.entry.abort.signal.aborted);
        // A lost or cancelled job rejects only its own write; its signal already says why.
        await Promise.all(live.map((t) => t.channels.batchProgress.push(payload).catch(() => {})));
      },
    });
    for (const { job } of tasks) this.#host.emitActive(job);
    for (const t of tasks) if (t.poison) void this.#settle(t, { ok: false, err: t.poison, retry: false });
    if (runnable.length === 0) {
      await Promise.all(tasks.map((t) => t.settled));
      for (const t of tasks) for (const c of Object.values(t.channels)) c.close();
      this.#finish();
      return;
    }
    const batch: Batch = Object.freeze({ id: this.key, jobs: Object.freeze(runnable.map((t) => t.batchJob)) });
    // Resolved only when the grace after the timeout runs out: the unsettled jobs fail without waiting for the handler.
    let abandon!: () => void;
    const abandoned = new Promise<'abandoned'>((r) => (abandon = () => r('abandoned')));
    let dropped!: () => void;
    const allGone = new Promise<'dropped'>((r) => (dropped = () => r('dropped')));
    this.#handlerRun = { batchAbort, tasks, dropped };
    const timer = this.#timeout(live, batchAbort, abandon);
    // Never rejects, so a handler failing after it was abandoned is never unhandled.
    const ran = Promise.resolve()
      .then(() => this.#setup.handler(batch, ctx))
      .then((value): Outcome => ({ ok: true, value }), (err: unknown): Outcome => ({ ok: false, err }));
    const end = await Promise.race([ran, abandoned, allGone]);
    timer?.settled();
    this.#handlerRun?.clear?.();
    this.#handlerRun = undefined;
    const outcomes = this.#outcomes(runnable, end, batchAbort.signal.reason);
    const outcomeOf = new Map(runnable.map((t, i) => [t, outcomes[i]!]));
    // Aborted by shutdown: the outcome is not trusted; unsettled jobs go back, keeping their leases until then.
    const results = await Promise.all(tasks.map((t) => t.settled ?? (this.#discarded ? this.#giveBack(t) : this.#settle(t, outcomeOf.get(t)!))));
    results.forEach((r, i) => {
      if (r === 'lost' || r === 'cancelled') this.#host.logger.warn('batch task outcome discarded', { ...this.#host.ids, jobId: tasks[i]!.entry.rec.id, batchId: this.key });
    });
    for (const t of tasks) for (const c of Object.values(t.channels)) c.close();
    this.#finish();
  }

  /** Each job's outcome from what the handler returned or threw; the timeout replaces it. */
  #outcomes(tasks: Task[], end: Outcome | 'abandoned' | 'dropped', reason: unknown): Outcome[] {
    if (reason instanceof JobTimeoutError) {
      const { timeoutMs, graceMs } = reason;
      return tasks.map(({ entry: { rec } }) => {
        const err = new JobTimeoutError({ jobId: rec.id, attempt: rec.attempt, timeoutMs, graceMs, abandoned: end === 'abandoned' });
        return { ok: false, err };
      });
    }
    // Abandoned without a timeout cannot happen; dropped means every job is lost or cancelled, so nothing is written.
    if (end === 'abandoned' || end === 'dropped') return tasks.map(() => ({ ok: false, err: reason }));
    if (!end.ok) return tasks.map(() => end);
    const value = end.value;
    if (value === undefined) return tasks.map(() => ({ ok: true, value: undefined }));
    if (!Array.isArray(value) || value.length !== tasks.length) {
      const err = new BatchResultMismatchError({ expected: tasks.length, got: Array.isArray(value) ? value.length : 1 });
      return tasks.map(() => ({ ok: false, err }));
    }
    return value.map((v: unknown): Outcome => {
      if (!(v instanceof TaskFailure)) return { ok: true, value: v };
      return v.retry === undefined ? { ok: false, err: v.error } : { ok: false, err: v.error, retry: v.retry };
    });
  }

  /** Settle one job once: the hooks run, its heartbeat stops, then its own retry decision and fenced write. */
  #settle(t: Task, outcome: Outcome): Promise<Settled> {
    return (t.settled ??= (async (): Promise<Settled> => {
      const { keeper } = this.#host;
      const { rec, token, abort } = t.entry;
      try {
        const gone = () => (abort.signal.reason instanceof JobCancelledError ? 'cancelled' : 'lost');
        if (keeper.isLost(rec.id, token)) return gone();
        // The hooks run while the lease is still renewed; a loss during them drops the outcome.
        for (const fn of this.#beforeSettle.get(rec.id) ?? []) await fn();
        if (keeper.isLost(rec.id, token)) return gone();
        keeper.stopHeartbeat(rec.id, token);
        return await this.#host.settle(rec, t.job, outcome);
      } finally {
        keeper.untrack(rec.id, token);
      }
    })());
  }

  /** Release one job of the running batch (handler started, attempt refunded) instead of settling it. */
  #giveBack(t: Task): Promise<Settled> {
    return (t.settled ??= (async (): Promise<Settled> => {
      const { keeper } = this.#host;
      const { rec, token } = t.entry;
      try {
        if (keeper.isLost(rec.id, token)) return 'lost';
        keeper.stopHeartbeat(rec.id, token);
        // Closing first drops the answer of a progress write still out, so its refusal after the release is no lost lease.
        for (const c of Object.values(t.channels)) c.close();
        const r = await this.#host.release(rec, true, 'shutdown');
        return r === 'released' ? 'committed' : r === 'rejected' ? 'lost' : 'unconfirmed';
      } finally {
        keeper.untrack(rec.id, token);
      }
    })());
  }

  /** Run `fn` right before this job's outcome is written, early or at the end of the batch. */
  beforeSettle(jobId: string, fn: () => Promise<void>): void {
    const list = this.#beforeSettle.get(jobId) ?? [];
    this.#beforeSettle.set(jobId, [...list, fn]);
  }

  /** The batch's limit: the smallest of its jobs' timeouts, with that job's grace. */
  #timeout(live: Entry[], batchAbort: AbortController, onAbandon: () => void): { settled(): void } | undefined {
    let pick: { rec: JobRecord; timeoutMs: number; graceMs: number } | undefined;
    for (const { rec } of live) {
      const { timeoutMs, graceMs } = this.#host.timeoutFor(rec);
      if (timeoutMs !== undefined && (!pick || timeoutMs < pick.timeoutMs)) pick = { rec, timeoutMs, graceMs };
    }
    if (!pick) return undefined;
    const { rec, timeoutMs, graceMs } = pick;
    return startTimeout({ timeoutMs, graceMs, abort: batchAbort, jobId: rec.id, attempt: rec.attempt, onAbandon });
  }

  #finish(): void {
    if (this.#phase === 'over') return;
    this.#phase = 'over';
    this.#quiet?.cancel();
    this.#maxWait?.cancel();
    this.#closed();
    this.#end();
    this.#host.freed(this);
  }
}
