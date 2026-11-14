import { StoreFormatError } from '../errors/catalog.js';
import type { StoreClient } from '../store/client.js';
import type { HeartbeatWorkerRequest, RegisterWorkerRequest, Scope } from '../store/contract.js';
import { platform, type Timer } from '../platform/index.js';

export interface RegistryHost {
  readonly client: StoreClient;
  readonly scope: Scope;
  report(e: unknown, operation: string): void;
}

type Info = Omit<HeartbeatWorkerRequest, 'workerId'>;

/**
 * Keeps one worker's registry record: registers once the namespace's format check passed, then heartbeats every
 * `heartbeatIntervalMs` (one unref'd timer), registering again when the record is gone. Purely informational: a
 * failure is reported once per outage and retried next tick; it never touches job processing. Never throws.
 */
export class RegistryHeartbeat {
  readonly #host: RegistryHost;
  readonly #info: () => Info;
  readonly #reg: RegisterWorkerRequest;
  #timer: Timer | undefined;
  #running = false;
  /** A register was sent, so the store may hold a record to remove. */
  #sent = false;
  /** The store confirmed the record; until then each tick registers. */
  #registered = false;
  /** The pod's format was refused: it writes no record, ever. */
  #refused = false;
  #failing = false;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(host: RegistryHost, info: () => Info, reg: RegisterWorkerRequest) {
    this.#host = host;
    this.#info = info;
    this.#reg = reg;
  }

  start(): void {
    if (this.#running || this.#refused) return;
    this.#running = true;
    this.#run(() => this.#beat());
  }

  /** Stop the timer and send one heartbeat now (the worker reports `draining`). Never rejects. */
  draining(): Promise<void> {
    this.#halt();
    return this.#run(async () => {
      if (this.#sent) await this.#call('heartbeatWorker', () => this.#heartbeat());
    });
  }

  /** Stop the timer, wait for a call in flight, then delete the record. Never rejects. */
  stop(): Promise<void> {
    this.#halt();
    return this.#run(async () => {
      if (this.#sent) await this.#call('unregisterWorker', () => this.#host.client.call('unregisterWorker', this.#ns(), { workerId: this.#reg.workerId }));
    });
  }

  #halt(): void {
    this.#running = false;
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  /** Run `fn` after the call in flight; schedule the next tick while running. */
  #run(fn: () => Promise<void>): Promise<void> {
    this.#inFlight = this.#inFlight.then(fn).finally(() => {
      if (!this.#running || this.#timer !== undefined) return;
      this.#timer = platform.setTimer(() => {
        this.#timer = undefined;
        if (this.#running) this.#run(() => this.#beat());
      }, this.#reg.heartbeatIntervalMs);
    });
    return this.#inFlight;
  }

  async #beat(): Promise<void> {
    if (!this.#registered) {
      await this.#call('registerWorker', () => this.#register());
      return;
    }
    await this.#call('heartbeatWorker', async () => {
      // The record was purged or wiped: register again under the same id.
      if (!(await this.#heartbeat()).ok) {
        this.#registered = false;
        await this.#register();
      }
    });
  }

  async #register(): Promise<void> {
    const { client, scope } = this.#host;
    // A pod whose format was refused writes no record; its worker reports the refusal.
    await client.checkFormat(scope.namespace);
    this.#sent = true;
    const { concurrency, scheduler } = this.#info();
    await client.call('registerWorker', this.#ns(), { ...this.#reg, concurrency, scheduler });
    this.#registered = true;
  }

  #heartbeat(): Promise<{ ok: boolean }> {
    return this.#host.client.call('heartbeatWorker', this.#ns(), { workerId: this.#reg.workerId, ...this.#info() });
  }

  #ns(): { namespace: string } {
    return { namespace: this.#host.scope.namespace };
  }

  /** One registry call: a refused format stops the registry silently; any other failure is reported once per outage. */
  async #call(operation: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      this.#failing = false;
    } catch (e) {
      if (e instanceof StoreFormatError && e.recordKind === 'meta') {
        this.#refused = true;
        this.#halt();
        return;
      }
      if (!this.#failing) this.#host.report(e, operation);
      this.#failing = true;
    }
  }
}
