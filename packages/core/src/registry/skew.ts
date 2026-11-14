import { StoreFormatError } from '../errors/catalog.js';
import type { Logger } from '../logger/logger.js';
import { findSkew } from '../format/support.js';
import type { StoreClient } from '../store/client.js';
import type { Scope } from '../store/contract.js';
import { toWorkerInfos } from './info.js';
import { platform, type Timer } from '../platform/index.js';

/** How often a queue with a running worker reads the registry for version skew and scheduler presence. */
export const SKEW_CHECK_MS = 60_000;

type Skewed = { workerId: string; sureqVersion: string }[];

export interface RegistryCheckHost {
  readonly client: StoreClient;
  readonly scope: Scope;
  readonly logger: Logger;
  emitSkew(workers: Skewed): void;
  report(e: unknown, operation: string): void;
}

/**
 * Every SKEW_CHECK_MS while started: lists the queue's live workers, emits `versionSkew` once per distinct set of
 * workers whose release is not adjacent to this pod's, and caches whether the queue has unpaused schedules but no
 * live worker runs a scheduler. Advisory only: it never blocks anything; a failed read is reported once per outage.
 */
export class RegistryCheck {
  readonly #host: RegistryCheckHost;
  #timer: Timer | undefined;
  #running = false;
  #ticking = false;
  #failing = false;
  #lastSkew = '[]';
  #noScheduler = false;

  constructor(host: RegistryCheckHost) {
    this.#host = host;
  }

  /** Unpaused schedules exist and no live worker of the queue runs a scheduler, as of the last check. */
  get noSchedulerRunning(): boolean {
    return this.#noScheduler;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (!this.#ticking) this.#schedule();
  }

  /** No check after this; the cached answer is dropped, since no worker here watches any more. */
  stop(): void {
    this.#running = false;
    this.#timer?.cancel();
    this.#timer = undefined;
    this.#noScheduler = false;
  }

  #schedule(): void {
    this.#timer = platform.setTimer(() => {
      this.#timer = undefined;
      this.#ticking = true;
      void this.#tick().finally(() => {
        this.#ticking = false;
        if (this.#running && this.#timer === undefined) this.#schedule();
      });
    }, SKEW_CHECK_MS);
  }

  async #tick(): Promise<void> {
    const { client, scope, logger } = this.#host;
    let operation = 'listWorkers';
    try {
      const live = toWorkerInfos(await client.call('listWorkers', { namespace: scope.namespace }, { queue: scope.queue }), { includeStale: false });
      // `nextDueAt` is null unless some schedule is not paused: paused schedules need no scheduler
      operation = 'listDueSchedules';
      const { nextDueAt } = await client.call('listDueSchedules', scope, { limit: 1 });
      this.#failing = false;
      if (!this.#running) return;
      this.#noScheduler = nextDueAt !== null && !live.some((w) => w.scheduler);
      const own = client.__formatSupport.sureqVersion;
      const skewed = findSkew(own, live).map(({ workerId, sureqVersion }) => ({ workerId, sureqVersion }));
      const key = JSON.stringify(skewed);
      if (key === this.#lastSkew) return;
      this.#lastSkew = key;
      if (skewed.length === 0) return;
      logger.warn(`workers of releases not adjacent to ${own} share queue "${scope.queue}": ${skewed.map((w) => `${w.workerId} (${w.sureqVersion})`).join(', ')}`, {
        queue: scope.queue, sureqVersion: own,
      });
      this.#host.emitSkew(skewed);
    } catch (e) {
      // A pod whose format was refused reports that once, through its worker.
      if (e instanceof StoreFormatError && e.recordKind === 'meta') return;
      if (!this.#failing) this.#host.report(e, operation);
      this.#failing = true;
    }
  }
}
