import type { SureQError } from '../errors/base.js';
import { StoreContractVersionError, StoreFormatError, type StoreUnavailableError } from '../errors/catalog.js';
import { wrapStoreError } from '../errors/store.js';
import type { Unsubscribe } from '../events/types.js';
import { FORMAT_SUPPORT, SUREQ_VERSION, metaError, type FormatSupport } from '../format/support.js';
import type { StoreCapabilities } from './capabilities.js';
import { SUPPORTED_CONTRACT_VERSIONS, type Scope, type Store } from './contract.js';
import { MAX_TIMER_MS, platform, type Timer } from '../platform/index.js';

/** The store operations a client forwards with error wrapping. */
export type CallOp = Exclude<keyof Store, 'open' | 'close' | 'subscribe' | 'contractVersion' | 'capabilities'>;
type Fn = (...args: unknown[]) => Promise<unknown>;
/** Operations that run before, or as part of, the namespace format check. */
const UNGATED: ReadonlySet<CallOp> = new Set<CallOp>(['now', 'ensureNamespaceMeta', 'getNamespaceMeta']);

/** Whether the store is reachable: `'connected'`, `'reconnecting'` during an outage, or `'closed'`. */
export type ConnectionState = 'connected' | 'reconnecting' | 'closed';
export type ConnectionEvent = { type: 'disconnected'; error: Error } | { type: 'reconnected'; downForMs: number; attempts: number };
/** The probe schedule: `min(maxDelayMs, initialDelayMs * factor^n)`, then ± `jitter`. */
export type ReconnectPolicy = { initialDelayMs: number; maxDelayMs: number; factor: number; jitter: number; random: () => number };
export const RECONNECT_DEFAULTS: ReconnectPolicy = Object.freeze({ initialDelayMs: 100, maxDelayMs: 30_000, factor: 2, jitter: 0.2, random: Math.random });

/** A healthy store answers `now()` well within a second; longer waits grow with the backoff. */
const PROBE_TIMEOUT_MIN_MS = 1000;
/** The default for `storeCallTimeout`. */
const CALL_TIMEOUT_MS = 30_000;

/** A connection error: the store could not be reached (any foreign error is wrapped as one). */
export function isUnavailable(e: unknown): e is StoreUnavailableError {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'STORE_UNAVAILABLE';
}

/** The job id a request names, so a wrapped error can carry it. */
function jobIdOf(args: unknown[]): string | undefined {
  const req = args[1];
  if (typeof req === 'string') return req;
  const id = typeof req === 'object' && req !== null ? (req as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** Core's one handle on a store object: opens it once, checks its contract version, wraps its errors. */
export class StoreClient {
  readonly store: Store;
  #opening: Promise<void> | undefined;
  #attached = 0;
  #owned = false;
  #opened = false;
  #state: ConnectionState = 'connected';
  #policy: ReconnectPolicy | undefined;
  #callTimeoutMs: number | undefined;
  readonly #listeners = new Set<(e: ConnectionEvent) => void>();
  readonly #waiters = new Set<(connected: boolean) => void>();
  /** The next probe, while one is scheduled. */
  #probe: Timer | undefined;
  /** The timeout of the probe in flight, if any. */
  #probeLimit: Timer | undefined;
  /** Raised when an outage ends outside the prober: a probe started before then is stale and changes nothing. */
  #probeGen = 0;
  #downSince = 0;
  #attempts = 0;
  /** The not-durable warning was logged for this store object. */
  volatileWarned = false;
  /** @internal The formats this client's pod writes and reads; tests set it to simulate another release. */
  __formatSupport: FormatSupport & { sureqVersion: string } = { ...FORMAT_SUPPORT, sureqVersion: SUREQ_VERSION };
  /** The format check per namespace: kept once it passed or refused, dropped after any other failure. */
  readonly #formatChecks = new Map<string, Promise<number>>();
  /** The namespace's stored format as last read. */
  readonly #formats = new Map<string, number>();
  /** The namespaces whose format check passed (kept for good, like the check). */
  readonly #formatsPassed = new Set<string>();

  constructor(store: Store) {
    this.store = store;
  }

  get capabilities(): StoreCapabilities {
    return this.store.capabilities;
  }

  /** One state per store object, shared by every queue on it; `'closed'` once its last user left. */
  get state(): ConnectionState {
    return this.#state;
  }

  /** `store.open()` has succeeded (and the store was not closed since). */
  get opened(): boolean {
    return this.#opened;
  }

  /** Set the probe schedule and the call deadline; the first caller wins, so later queues on the same store do not change them, until the last one closes. */
  configure(policy: ReconnectPolicy, callTimeoutMs?: number): void {
    this.#policy ??= policy;
    this.#callTimeoutMs ??= callTimeoutMs;
  }

  onConnection(fn: (e: ConnectionEvent) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /** `true` once connected; `false` when `signal` aborts or the client closes first. */
  waitConnected(signal?: AbortSignal): Promise<boolean> {
    if (this.#state !== 'reconnecting') return Promise.resolve(this.#state === 'connected');
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (connected: boolean) => {
        this.#waiters.delete(done);
        signal?.removeEventListener('abort', onAbort);
        resolve(connected);
      };
      const onAbort = () => done(false);
      this.#waiters.add(done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** One more user (a queue); `owned` when that queue created the store and so closes it. */
  attach(owned = false): void {
    if (this.#state === 'closed') this.#state = 'connected';
    this.#attached++;
    this.#owned ||= owned;
  }

  /**
   * Open the store once. An unsupported contract version fails for good, before `store.open`;
   * any other failure is forgotten so the next call retries.
   */
  open(): Promise<void> {
    this.#opening ??= (async () => {
      const v = this.store.contractVersion;
      const [lo, hi] = SUPPORTED_CONTRACT_VERSIONS;
      if (!(v >= lo && v <= hi)) throw new StoreContractVersionError({ core: SUPPORTED_CONTRACT_VERSIONS, store: v });
      try {
        await this.store.open();
        this.#opened = true;
      } catch (e) {
        this.#opening = undefined;
        throw this.#failed(wrapStoreError('open', e));
      }
    })();
    return this.#opening;
  }

  /**
   * Check once per namespace that this pod reads its stored format, creating or raising the namespace record.
   * A refusal (StoreFormatError) is kept for good; any other failure is forgotten so the next call retries.
   */
  checkFormat(namespace: string): Promise<number> {
    let check = this.#formatChecks.get(namespace);
    if (!check) {
      check = (async () => {
        await this.open();
        const { sureqVersion, ...support } = this.__formatSupport;
        let f: number;
        try {
          ({ formatVersion: f } = await this.store.ensureNamespaceMeta({ namespace }, { ...support, sureqVersion }));
        } catch (e) {
          throw this.#failed(wrapStoreError('ensureNamespaceMeta', e));
        }
        this.#formats.set(namespace, f);
        const refused = metaError(f, support, sureqVersion);
        if (refused) throw refused;
        this.#formatsPassed.add(namespace);
        return f;
      })();
      this.#formatChecks.set(namespace, check);
      check.catch((e: unknown) => {
        if (!(e instanceof StoreFormatError) && this.#formatChecks.get(namespace) === check) this.#formatChecks.delete(namespace);
      });
    }
    return check;
  }

  /** The namespace's stored format as last read, or null before the first read. */
  formatOf(namespace: string): number | null {
    return this.#formats.get(namespace) ?? null;
  }

  /**
   * Call one store operation after opening (and, for a scoped one, the format check); a foreign error comes back as
   * StoreUnavailableError. The whole call has one deadline: past it the call fails like an unreachable store and a late
   * answer is dropped.
   */
  call<K extends CallOp>(op: K, ...args: Parameters<Store[K]>): ReturnType<Store[K]> {
    const ms = this.#callTimeoutMs ?? CALL_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const namespace = UNGATED.has(op) ? undefined : (args[0] as { namespace: string }).namespace;
      let expired = false;
      // Unref'd: a caller that must hold the process open has its own ref'd bound (health, ready, maxWait, the worker loop).
      const timer = platform.setTimer(() => {
        expired = true;
        reject(this.#failed(wrapStoreError(op, new RangeError(`no answer within ${ms} ms`), jobIdOf(args))));
      }, ms);
      let sent: Promise<unknown>;
      if (this.#opened && (namespace === undefined || this.#formatsPassed.has(namespace))) {
        // Opened and format-checked already: send at once, without waiting on the settled open and check.
        try {
          sent = Promise.resolve((this.store[op] as Fn).apply(this.store, args));
        } catch (e) {
          sent = Promise.reject(e);
        }
      } else {
        sent = this.open()
          .then((): unknown => namespace !== undefined && this.checkFormat(namespace))
          // the caller already got the timeout: sending now would make a change nobody waits for
          .then(() => (expired ? undefined : (this.store[op] as Fn).apply(this.store, args)));
      }
      // A late answer or failure, after the deadline, is dropped.
      sent.then(
        (v) => {
          timer.cancel();
          resolve(v);
        },
        (e: unknown) => {
          timer.cancel();
          if (!expired) reject(this.#failed(wrapStoreError(op, e, jobIdOf(args))));
        },
      );
    }) as ReturnType<Store[K]>;
  }

  /** A connection error while connected starts an outage: tell the listeners once and start probing. */
  #failed(error: SureQError): SureQError {
    if (this.#state === 'connected' && this.#attached > 0 && isUnavailable(error)) {
      this.#state = 'reconnecting';
      this.#downSince = platform.monotonicMs();
      this.#attempts = 0;
      this.#emit({ type: 'disconnected', error });
      this.#scheduleProbe();
    }
    return error;
  }

  #scheduleProbe(): void {
    const { initialDelayMs, maxDelayMs, factor, jitter, random } = this.#policy ?? RECONNECT_DEFAULTS;
    const base = Math.min(maxDelayMs, initialDelayMs * factor ** this.#attempts);
    // Capped at the timer limit: a longer timer would fire after 1 ms and probe without pause.
    const delay = Math.min(MAX_TIMER_MS, base * (1 + jitter * (2 * random() - 1)));
    this.#probe = platform.setTimer(() => void this.#runProbe(delay), delay);
  }

  /**
   * `now()` once the store was opened, else `open()`; the first success ends the outage. A probe
   * that does not answer within the wait before it (at least PROBE_TIMEOUT_MIN_MS) counts as failed.
   */
  async #runProbe(delay: number): Promise<void> {
    this.#probe = undefined;
    this.#attempts++;
    const gen = this.#probeGen;
    let limit: Timer | undefined;
    let ok = true;
    try {
      await new Promise<unknown>((resolve, reject) => {
        // Kept in #probeLimit while the probe runs, so close clears it too.
        limit = this.#probeLimit = platform.setTimer(() => reject(new RangeError('probe timed out')), Math.max(PROBE_TIMEOUT_MIN_MS, delay));
        (this.#opened ? this.store.now() : this.open()).then(resolve, reject);
      });
    } catch {
      ok = false;
    }
    limit?.cancel();
    if (this.#probeLimit === limit) this.#probeLimit = undefined;
    // The outage it probed for already ended; a later outage has its own probe.
    if (gen !== this.#probeGen) return;
    if (ok) this.#endOutage();
    else if (this.#state === 'reconnecting') this.#scheduleProbe();
  }

  /**
   * @internal A call outside the prober (a `ready()` attempt) just got an answer from the store: end an outage now
   * instead of at the next backoff probe. A probe already in flight is stale from here: it changes nothing when it settles.
   */
  markReachable(): void {
    if (this.#state !== 'reconnecting') return;
    this.#probeGen++;
    this.#probe?.cancel();
    this.#probe = undefined;
    this.#endOutage();
  }

  #endOutage(): void {
    if (this.#state !== 'reconnecting') return;
    this.#state = 'connected';
    this.#emit({ type: 'reconnected', downForMs: platform.monotonicMs() - this.#downSince, attempts: this.#attempts });
    this.#settleWaiters(true);
  }

  #emit(e: ConnectionEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e);
      } catch {
        // Queues relay through their own emitters, which never throw; nothing else listens.
      }
    }
  }

  #settleWaiters(connected: boolean): void {
    for (const done of [...this.#waiters]) done(connected);
  }

  /** Subscribe to wake-ups after the format check; `undefined` when the store has no `subscribe`. */
  async subscribe(scope: Scope, onWake: () => void): Promise<(() => Promise<void>) | undefined> {
    if (!this.store.subscribe) return undefined;
    await this.open();
    await this.checkFormat(scope.namespace);
    try {
      return await this.store.subscribe(scope, onWake);
    } catch (e) {
      throw wrapStoreError('subscribe', e);
    }
  }

  /** One user is done; the last one closes the store, and only if a user owned it. */
  async close(): Promise<void> {
    if (this.#attached === 0) return;
    if (--this.#attached > 0) return;
    // The next queue to attach sets the schedule afresh.
    this.#policy = undefined;
    this.#callTimeoutMs = undefined;
    this.#probe?.cancel();
    this.#probe = undefined;
    this.#probeLimit?.cancel();
    this.#probeLimit = undefined;
    this.#probeGen++;
    this.#state = 'closed';
    this.#settleWaiters(false);
    if (!this.#owned) return;
    this.#owned = false;
    this.#opening = undefined;
    this.#opened = false;
    try {
      await this.store.close();
    } catch (e) {
      throw wrapStoreError('close', e);
    }
  }
}

const clients = new WeakMap<Store, StoreClient>();

/** The one client for a store object. */
export function clientFor(store: Store): StoreClient {
  let c = clients.get(store);
  if (!c) clients.set(store, (c = new StoreClient(store)));
  return c;
}
