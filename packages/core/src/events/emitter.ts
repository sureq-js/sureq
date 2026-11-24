import { ListenerError } from '../errors/catalog.js';
import { logEvent, type Logger } from '../logger/logger.js';
import type { ErrorEvent, Unsubscribe } from './types.js';

type Listener = (payload: never) => unknown;
interface Registration {
  fn: Listener;
  once: boolean;
}

/**
 * Synchronous, typed event emitter. Listener failures — thrown or rejected — never reach the
 * caller: they become `error` events with a ListenerError, or a log line when no one listens.
 */
export class TypedEmitter<E extends { error: ErrorEvent }> {
  readonly #listeners = new Map<string, Registration[]>();
  readonly #queue: string;
  readonly #logger: Logger;

  constructor(opts: { queue: string; logger: Logger }) {
    this.#queue = opts.queue;
    this.#logger = opts.logger;
  }

  on<K extends keyof E & string>(event: K, fn: (payload: E[K]) => unknown): Unsubscribe {
    return this.#add(event, fn as Listener, false);
  }

  once<K extends keyof E & string>(event: K, fn: (payload: E[K]) => unknown): Unsubscribe {
    return this.#add(event, fn as Listener, true);
  }

  /** Remove one registration of `fn`. */
  off<K extends keyof E & string>(event: K, fn: (payload: E[K]) => unknown): void {
    const list = this.#listeners.get(event);
    const i = list?.findIndex((r) => r.fn === fn) ?? -1;
    if (i >= 0) list!.splice(i, 1);
  }

  /**
   * Call every listener registered when the emit started, in order. Never throws. An `error` with no
   * listener is logged, unless `quiet` (the caller has logged it already, e.g. the store-error reporter).
   */
  emit<K extends keyof E & string>(event: K, payload: E[K], opts?: { quiet?: boolean }): void {
    const live = this.#listeners.get(event);
    if (event === 'error' && !live?.length) {
      if (!opts?.quiet) this.#log(payload as unknown as ErrorEvent);
      return;
    }
    for (const reg of [...(live ?? [])]) {
      if (reg.once) {
        const i = live!.indexOf(reg);
        if (i >= 0) live!.splice(i, 1);
      }
      try {
        const r: unknown = (reg.fn as (p: E[K]) => unknown)(payload);
        if (r !== null && typeof r === 'object' && typeof (r as { then?: unknown }).then === 'function') {
          (r as Promise<unknown>).then(undefined, (err: unknown) => this.#listenerFailed(event, err));
        }
      } catch (err) {
        this.#listenerFailed(event, err);
      }
    }
  }

  /** Report an error through the `error` event, or the logger when no one listens. */
  reportError(e: ErrorEvent): void {
    this.emit('error' as keyof E & string, e as E[keyof E & string]);
  }

  removeAll(): void {
    this.#listeners.clear();
  }

  #add(event: string, fn: Listener, once: boolean): Unsubscribe {
    const reg: Registration = { fn, once };
    const list = this.#listeners.get(event) ?? [];
    list.push(reg);
    this.#listeners.set(event, list);
    return () => {
      const i = list.indexOf(reg);
      if (i >= 0) list.splice(i, 1);
    };
  }

  #listenerFailed(event: string, cause: unknown): void {
    const error = new ListenerError({ event, cause });
    const report: ErrorEvent = { error, source: 'listener', context: { queue: this.#queue, event } };
    // A failing `error` listener is only logged: reporting it as another `error` event could loop.
    if (event === 'error') this.#log(report);
    else this.reportError(report);
  }

  #log(e: ErrorEvent): void {
    const { name, code, message, stack } = e.error;
    logEvent(this.#logger, 'sureq error', { source: e.source, ...e.context, error: { name, code, message, stack } });
  }
}
