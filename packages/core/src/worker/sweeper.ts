import { isObliterating } from '../admin/obliterate.js';
import { StalledJobError } from '../errors/catalog.js';
import type { ErrorSource, QueueEvents } from '../events/types.js';
import { storedError, type Job } from '../job/job.js';
import type { SerializedError } from '../serialize/error.js';
import type { StoreClient } from '../store/client.js';
import type { PodMetrics } from '../metrics/metrics.js';
import type { HistoryOption, JobRecord, Scope, SweepRequest, SweptJob } from '../store/contract.js';
import { platform, type Timer } from '../platform/index.js';

/** Full batches swept back to back in one tick, at most. */
const MAX_ROUNDS = 10;
const JITTER = 0.2;
const STALLED: SerializedError = Object.freeze({ v: 1, name: 'StalledJobError', code: 'JOB_STALLED', message: new StalledJobError().message });

/** What a Sweeper needs from its queue. */
export interface SweeperHost {
  readonly client: StoreClient;
  readonly scope: Scope;
  toJob(rec: JobRecord, now: number): Job;
  /** The newest record format this pod reads; newer jobs are left for a pod that reads them. */
  maxFormat(): number;
  /** The store moved to a format this pod cannot read: sweep nothing. */
  isDegraded(): boolean;
  emit<K extends 'stalled' | 'failed' | 'deadLettered'>(event: K, payload: QueueEvents<Job>[K]): void;
  report(e: unknown, source: ErrorSource, operation: string): void;
  /** A job left for good: emit `drained` if the queue has just become empty. Never rejects. */
  evaluateDrained(): Promise<void>;
  /** This pod's metrics: a swept attempt counts as crashed. */
  readonly metrics: PodMetrics;
  /**
   * The queue's own upkeep, started after every tick without a store failure (none while degraded or unreachable), with
   * the store time of the tick's last sweep. It runs beside the sweeps, one at a time: a tick that ends while it still
   * runs starts none. Never rejects.
   */
  afterTick(now: number): Promise<void>;
}

/**
 * The stored errors one sweep request carries for every job it fails. They hold nothing per job:
 * the poison error gets its job id and crash count from the record when read back.
 */
function sweepErrors(maxCrashes: number): Pick<SweepRequest, 'failError' | 'poisonError'> {
  const poison: SerializedError = {
    v: 1, name: 'PoisonPillError', code: 'POISON_PILL', message: `Job crashed its worker too many times (limit ${maxCrashes})`, props: { maxCrashes },
  };
  return { failError: JSON.stringify(STALLED), poisonError: JSON.stringify(poison) };
}

/**
 * Returns jobs whose lease expired to `waiting` (or fails them) every `sweepIntervalMs` ±20 %, and
 * emits `stalled` for each. Never throws: store failures are reported once per outage.
 */
export class Sweeper {
  readonly #host: SweeperHost;
  readonly #intervalMs: number;
  readonly #random: () => number;
  readonly #req: SweepRequest;
  #timer: Timer | undefined;
  #tick: Promise<void> = Promise.resolve();
  /** The upkeep in flight, if any. */
  #upkeep: Promise<void> | undefined;
  #running = false;
  #outage = false;
  /** `platform.monotonicMs()` of the start and of the last finished tick, for `health()`. */
  readonly ticks: { lastTickAt: number | undefined; startedAt: number; intervalMs: number };

  constructor(
    host: SweeperHost,
    opts: {
      sweepIntervalMs: number; sweepBatch: number; maxCrashes: number; random: () => number; history?: HistoryOption; deadLetter?: SweepRequest['deadLetter'];
      retention?: SweepRequest['retention'];
    },
  ) {
    this.#host = host;
    this.#intervalMs = opts.sweepIntervalMs;
    this.#random = opts.random;
    this.ticks = { lastTickAt: undefined, startedAt: platform.monotonicMs(), intervalMs: opts.sweepIntervalMs };
    this.#req = {
      limit: opts.sweepBatch, maxCrashes: opts.maxCrashes, ...sweepErrors(opts.maxCrashes),
      ...(opts.history !== undefined && { history: opts.history }), ...(opts.deadLetter !== undefined && { deadLetter: opts.deadLetter }),
      ...(opts.retention !== undefined && { retention: opts.retention }),
    };
  }

  /** False once `stop()` was called. */
  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.ticks.startedAt = platform.monotonicMs();
    this.#schedule();
  }

  /** No tick after this; resolves once a tick and an upkeep in flight have finished. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#timer?.cancel();
    await this.#tick;
    await this.#upkeep;
  }

  #schedule(): void {
    const delay = this.#intervalMs * (1 + JITTER * (2 * this.#random() - 1));
    this.#timer = platform.setTimer(() => {
      this.#tick = this.#sweep().then(() => {
        if (this.#running) this.#schedule();
      });
    }, delay);
  }

  /** One tick: sweep again at once while a round comes back full. Resolves, never rejects. */
  async #sweep(): Promise<void> {
    const { client, scope } = this.#host;
    // The store is unreachable: skip this tick; the next one runs on schedule.
    if (client.state === 'reconnecting' || this.#host.isDegraded()) return;
    let at: number | undefined;
    for (let round = 0; round < MAX_ROUNDS && this.#running; round++) {
      let swept: SweptJob[];
      let now: number;
      try {
        ({ swept, now } = await client.call('sweep', scope, { ...this.#req, maxFormat: this.#host.maxFormat() }));
      } catch (e) {
        // the queue is being obliterated: skip this tick quietly
        if (!isObliterating(e)) this.#storeFailed(e);
        return;
      }
      at = now;
      // The batch is already swept: every job of it is announced even when one read fails.
      let readFailed = false;
      for (const s of swept) if (!(await this.#announce(s, now))) readFailed = true;
      // The store is failing: no further round; the outage goes on.
      if (readFailed) return;
      if (swept.length < this.#req.limit) break;
    }
    // Stopped before the first round (no tick happened) or during the tick: no upkeep after a stop.
    if (at === undefined || !this.#running) return;
    // A tick without a store failure ends the outage.
    this.#outage = false;
    this.ticks.lastTickAt = platform.monotonicMs();
    // Detached, so a slow upkeep step never delays or stalls the sweeps; skipped while the last one still runs.
    this.#upkeep ??= this.#host.afterTick(at).finally(() => (this.#upkeep = undefined));
  }

  /** Report a store failure once per outage (consecutive failing ticks). */
  #storeFailed(e: unknown): void {
    if (!this.#outage) this.#host.report(e, 'store', 'sweep');
    this.#outage = true;
  }

  /**
   * Tell listeners about one swept job; false when its read failed twice and it was skipped. One retry
   * rides out a blip on one read; in a real outage each job costs two quick failed reads and one report.
   */
  async #announce(s: SweptJob, now: number): Promise<boolean> {
    const { client, scope } = this.#host;
    let rec: JobRecord | null;
    try {
      rec = await client.call('get', scope, s.id).catch(() => client.call('get', scope, s.id));
    } catch (e) {
      this.#storeFailed(e);
      return false;
    }
    // Removed before it could be read: nothing to tell.
    if (!rec) return true;
    // ponytail: a swept held batch job (its handler never ran) also counts as crashed, and its held time lands in the
    // processing histogram as a crashed sample; the sweep result does not say the lease was held. The fix is a `held`
    // flag on SweptJob, which is a store contract change.
    this.#host.metrics.attemptEnded(rec, 'crashed', rec.startedAt === null ? null : now);
    try {
      const job = this.#host.toJob(rec, now);
      this.#host.emit('stalled', { job, previousWorkerId: s.previousOwner, crashCount: s.crashCount, action: s.action });
      if (s.action === 'failed') {
        const reason = s.crashCount >= this.#req.maxCrashes ? 'unrecoverable' : 'attempts-exhausted';
        // A store that failed the job without storing the error it was sent: report what it was sent.
        this.#host.emit('failed', { job, error: storedError(rec) ?? STALLED, reason });
        if (job.deadLetter) this.#host.emit('deadLettered', { job, reason: job.deadLetter.reason });
        await this.#host.evaluateDrained();
      }
    } catch (e) {
      this.#host.report(e, 'internal', 'sweep');
    }
    return true;
  }
}
