import { isObliterating } from '../admin/obliterate.js';
import { InternalError, isStoreError, StoreFormatError } from '../errors/catalog.js';
import type { ErrorSource, QueueEvents } from '../events/types.js';
import type { StoreClient } from '../store/client.js';
import type { FireScheduleResult, NewJob, ScheduleRecord, Scope } from '../store/contract.js';
import { nextRunAfter } from './schedules.js';
import { platform, type Timer } from '../platform/index.js';

const JITTER = 0.1;

/** What a Scheduler needs from its queue. */
export interface SchedulerHost {
  readonly client: StoreClient;
  readonly scope: Scope;
  buildJob(rec: ScheduleRecord, scheduledFor: number, now: number): NewJob;
  /** The store moved to a format this pod cannot read: fire nothing, since a fired job is written at this pod's format. */
  isDegraded(): boolean;
  emit<K extends 'scheduleFired' | 'scheduleSkipped' | 'scheduleQueued'>(event: K, payload: QueueEvents[K]): void;
  report(e: unknown, source: ErrorSource, operation: string): void;
  /** The store format is refused for good; the loop has stopped. */
  refused(e: StoreFormatError): void;
}

/** How one schedule's turn went: `failed` (a store outage or the schedule's own failure); `moved` means a tick fired, skipped or queued. */
type Step = { failed: boolean; moved: boolean };

/**
 * One queue's schedule loop: each turn lists the due schedules by store time and fires each one in an atomic
 * store step, so every tick becomes exactly one job across any number of pods. It sleeps until the next due
 * tick, at most `tickMs`, ±10 %. Never reads the pod clock for timing a tick; never throws: store failures
 * are reported once per outage. A degraded pod skips its turns; a store format this release refuses stops the loop.
 */
export class Scheduler {
  readonly #host: SchedulerHost;
  readonly #tickMs: number;
  readonly #batchSize: number;
  readonly #random: () => number;
  #timer: Timer | undefined;
  #turn: Promise<void> = Promise.resolve();
  #running = false;
  /** Bumped by every start and stop: a turn of an older generation ends without arming a timer. */
  #gen = 0;
  /** A store failure was reported and no turn has since run without one. */
  #storeOutage = false;
  #storeFailedThisTurn = false;
  /** The last internal failure reported per schedule key; cleared when that schedule moves again. */
  readonly #broken = new Map<string, string>();
  #lastTurnAt: number | undefined;
  #startedAt = 0;

  constructor(host: SchedulerHost, opts: { tickMs: number; batchSize: number; random: () => number }) {
    this.#host = host;
    this.#tickMs = opts.tickMs;
    this.#batchSize = opts.batchSize;
    this.#random = opts.random;
  }

  get running(): boolean {
    return this.#running;
  }

  /** `platform.monotonicMs()` at the end of the last turn. */
  get lastTurnAt(): number | undefined {
    return this.#lastTurnAt;
  }

  /** `platform.monotonicMs()` at the last start. */
  get startedAt(): number {
    return this.#startedAt;
  }

  get tickMs(): number {
    return this.#tickMs;
  }

  /** Idempotent; the first turn runs at once. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#startedAt = platform.monotonicMs();
    this.#lastTurnAt = undefined;
    const gen = ++this.#gen;
    // a turn still finishing from before a stop is waited for, so two turns never overlap
    this.#turn = this.#turn.then(() => this.#run(gen));
  }

  /** No turn after this; resolves when the turn in flight (its current fire included) has ended. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#gen++;
    this.#timer?.cancel();
    await this.#turn;
  }

  async #run(gen: number): Promise<void> {
    if (gen !== this.#gen) return;
    const sleep = await this.#once(gen);
    if (gen !== this.#gen) return;
    this.#lastTurnAt = platform.monotonicMs();
    this.#timer = platform.setTimer(() => (this.#turn = this.#run(gen)), sleep, { ref: true });
  }

  #jitter(ms: number): number {
    return ms * (1 + JITTER * (2 * this.#random() - 1));
  }

  /** One turn; resolves to the sleep before the next. */
  async #once(gen: number): Promise<number> {
    const { client, scope } = this.#host;
    // The store is unreachable: skip this turn; the client probes it. Degraded: wait for a readable format.
    if (client.state === 'reconnecting' || this.#host.isDegraded()) return this.#jitter(this.#tickMs);
    this.#storeFailedThisTurn = false;
    let list;
    try {
      list = await client.call('listDueSchedules', scope, { limit: this.#batchSize });
    } catch (e) {
      // a refusal is for good (the client keeps it): stop, and let the queue decide who reports it
      if (e instanceof StoreFormatError && e.recordKind === 'meta') {
        this.#running = false;
        this.#gen++;
        this.#host.refused(e);
        return 0;
      }
      this.#failed(e, 'store', 'listDueSchedules');
      return this.#jitter(this.#tickMs);
    }
    // a complete list without a broken key: that schedule was deleted or moved on, so a new failure of it is news again
    if (list.due.length < this.#batchSize) {
      const due = new Set(list.due.map((r) => r.key));
      for (const key of this.#broken.keys()) if (!due.has(key)) this.#broken.delete(key);
    }
    let failed = false;
    let moved = false;
    for (const rec of list.due) {
      if (gen !== this.#gen || this.#host.isDegraded()) break;
      const step = await this.#schedule(rec, list.now);
      failed ||= step.failed;
      moved ||= step.moved;
    }
    if (!this.#storeFailedThisTurn) this.#storeOutage = false;
    // An outage sleeps the full tick. A broken schedule does not hold back the others: the turn goes on as usual
    // unless nothing moved, since that schedule stays due and would make the next turn start at once.
    if (this.#storeFailedThisTurn || (failed && !moved)) return this.#jitter(this.#tickMs);
    // a full batch may have more due behind it; a batch where nothing moved (all busy) must not spin
    if (list.due.length === this.#batchSize && moved) return 0;
    const wait = list.nextDueAt === null ? this.#tickMs : Math.min(Math.max(list.nextDueAt - list.now, 0), this.#tickMs);
    return this.#jitter(wait);
  }

  /** Fire one due schedule: a tick when it is due, else its oldest backlog tick; one retry after a conflict. */
  async #schedule(due: ScheduleRecord, now: number): Promise<Step> {
    let rec = due;
    for (let attempt = 0; ; attempt++) {
      const tick = rec.nextRunAt <= now;
      if (!tick && rec.queuedTicks.length === 0) return { failed: false, moved: false };
      const res = await this.#fire(rec, tick ? 'tick' : 'backlog', now);
      if (res === undefined) return { failed: true, moved: false };
      if (res.outcome === 'conflict') {
        if (attempt > 0) return { failed: false, moved: false };
        let fresh: ScheduleRecord | null;
        try {
          fresh = await this.#host.client.call('getSchedule', this.#host.scope, { key: rec.key });
        } catch (e) {
          this.#failed(e, 'store', 'getSchedule', rec.key);
          return { failed: true, moved: false };
        }
        if (!fresh || fresh.paused) return { failed: false, moved: false };
        rec = fresh;
        continue;
      }
      if (!('schedule' in res)) return { failed: false, moved: false };
      // the tick went into (or past) a backlog that can run now: the oldest backlog tick goes first
      if (tick && res.schedule.queuedTicks.length > 0) {
        const after = await this.#fire(res.schedule, 'backlog', now);
        return { failed: after === undefined, moved: true };
      }
      return { failed: false, moved: true };
    }
  }

  /** One `fireSchedule` call and its event; undefined when it could not be sent or failed (reported). */
  async #fire(rec: ScheduleRecord, mode: 'tick' | 'backlog', now: number): Promise<FireScheduleResult | undefined> {
    const { client, scope } = this.#host;
    const scheduledFor = mode === 'tick' ? rec.nextRunAt : rec.queuedTicks[0]!;
    let job: NewJob;
    let nextRunAt: number | null = null;
    try {
      job = this.#host.buildJob(rec, scheduledFor, now);
      // the first tick after the list's store now: every tick missed meanwhile collapses into this one
      if (mode === 'tick' && (nextRunAt = nextRunAfter(rec, now)) === null) {
        // the time goes in details: a message that changed every turn would be reported every turn
        throw new InternalError(`schedule "${rec.key}" has no tick after the store time`, { details: { key: rec.key, now } });
      }
    } catch (e) {
      this.#failed(e, 'internal', 'fireSchedule', rec.key);
      return undefined;
    }
    let res: FireScheduleResult;
    try {
      res = await client.call('fireSchedule', scope, { key: rec.key, expectedRev: rec.rev, mode, ...(nextRunAt !== null && { nextRunAt }), job });
    } catch (e) {
      // the queue is being obliterated: its schedules go with it, so this tick is dropped quietly
      if (!isObliterating(e)) this.#failed(e, 'store', 'fireSchedule', rec.key);
      return undefined;
    }
    const key = rec.key;
    if (res.outcome === 'fired' || res.outcome === 'skipped' || res.outcome === 'queued') this.#broken.delete(key);
    if (res.outcome === 'fired') this.#host.emit('scheduleFired', { key, scheduledFor, jobId: res.jobId });
    else if (res.outcome === 'skipped') this.#host.emit('scheduleSkipped', { key, scheduledFor, reason: res.reason });
    else if (res.outcome === 'queued') this.#host.emit('scheduleQueued', { key, scheduledFor });
    return res;
  }

  /**
   * Report a store failure once per outage (turns in a row with one), and a schedule's own failure (its job cannot
   * be built, no tick left, a store refusal that cannot succeed on retry) once per schedule and message, so a broken
   * schedule never hides a later store outage.
   */
  #failed(e: unknown, source: ErrorSource, operation: string, key?: string): void {
    // a store refusal no retry can fix belongs to the schedule, not to an outage
    const outage = source === 'store' && !(key !== undefined && isStoreError(e) && !e.retryable);
    if (outage) {
      this.#storeFailedThisTurn = true;
      if (!this.#storeOutage) this.#host.report(e, source, operation);
      this.#storeOutage = true;
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    if (this.#broken.get(key!) === message) return;
    this.#broken.set(key!, message);
    this.#host.report(e, source, operation);
  }
}
