import type { StoreFormatError } from '../errors/catalog.js';
import type { Logger } from '../logger/logger.js';
import type { StoreClient } from '../store/client.js';
import { metaError, type FormatSupport } from './support.js';
import { platform, type Timer } from '../platform/index.js';

/** How often a queue with workers re-reads its namespace's format. */
export const RECHECK_MS = 30_000;

export interface FormatWatchHost {
  readonly client: StoreClient;
  readonly namespace: string;
  /** Read at every check, so a change shows at the next one. */
  readonly support: FormatSupport & { sureqVersion: string };
  report(e: unknown, source: 'store', operation: string): void;
  emitDegraded(e: StoreFormatError): void;
  readonly logger: Logger;
}

/**
 * Re-reads the namespace's stored format every RECHECK_MS while started. A format newer than the pod reads
 * makes it degraded (no claim, no sweep; `degraded` emitted once); a readable one ends that. Never throws.
 */
export class FormatWatch {
  readonly #host: FormatWatchHost;
  #timer: Timer | undefined;
  #running = false;
  /** A check is in flight; the chain reschedules itself when it ends, so start() must not add a second one. */
  #ticking = false;
  #degraded = false;
  /** A failed check was reported and none has succeeded since. */
  #failing = false;
  #storeFormat: number | null = null;

  constructor(host: FormatWatchHost) {
    this.#host = host;
  }

  get degraded(): boolean {
    return this.#degraded;
  }

  /** The stored format as last read, or null before any read. */
  get storeFormat(): number | null {
    return this.#storeFormat ?? this.#host.client.formatOf(this.#host.namespace);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (!this.#ticking) this.#schedule();
  }

  stop(): void {
    this.#running = false;
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  #schedule(): void {
    this.#timer = platform.setTimer(() => {
      this.#timer = undefined;
      this.#ticking = true;
      void this.#tick().finally(() => {
        this.#ticking = false;
        if (this.#running && this.#timer === undefined) this.#schedule();
      });
    }, RECHECK_MS);
  }

  async #tick(): Promise<void> {
    if (!this.#running) return;
    const { client, namespace, logger } = this.#host;
    // The client already probes an unreachable store; the next check runs once it is back.
    if (client.state === 'reconnecting') return;
    let f: number;
    try {
      // a namespace no pod has marked yet is format 1
      f = (await client.call('getNamespaceMeta', { namespace }))?.formatVersion ?? 1;
      this.#failing = false;
    } catch (e) {
      // once per outage: checks in a row that fail
      if (!this.#failing) this.#host.report(e, 'store', 'getNamespaceMeta');
      this.#failing = true;
      return;
    }
    if (!this.#running) return;
    this.#storeFormat = f;
    const { sureqVersion, ...support } = this.#host.support;
    const verdict = metaError(f, support, sureqVersion);
    if (verdict?.reason === 'too-new' && !this.#degraded) {
      this.#degraded = true;
      logger.warn(verdict.message, { namespace, storeFormat: f, maxReadable: support.maxReadable });
      this.#host.emitDegraded(verdict);
    } else if (verdict === null && this.#degraded) {
      this.#degraded = false;
      logger.info(`the store namespace format ${f} is readable again; claiming resumes`, { namespace, storeFormat: f });
    }
  }
}
