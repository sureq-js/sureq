import { QueueClosedError, StoreUnavailableError } from '../errors/catalog.js';
import type { Unsubscribe } from '../events/types.js';
import { isUnavailable, type StoreClient } from '../store/client.js';
import type { AddOutcome, JobRecord } from '../store/contract.js';
import { platform, type Timer } from '../platform/index.js';

type Entry = {
  send: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: Timer;
  /** Pod-monotonic time `maxWait` runs out, set when the add is first held; a re-hold keeps it. */
  deadline?: number;
};

const notSent = (why: string) => new StoreUnavailableError(`store is reconnecting; the add was not sent (${why})`, { operation: 'add', retryable: true, outcomeUnknown: false });

/** The send failed before reaching the store. */
const neverSent = (e: unknown) => isUnavailable(e) && !e.outcomeUnknown;

/**
 * Lets adds through while the store is reachable. While it is not, an add is rejected at once
 * (`'reject'`) or held until the store is back (`'wait'`), at most `maxWaitMs` and `maxBufferedAdds`.
 * Held adds are sent in call order, one after the other, by a single drain.
 */
export class AddGate {
  readonly #client: StoreClient;
  readonly #opts: { onDisconnected: 'reject' | 'wait'; maxWaitMs: number; maxBufferedAdds: number };
  /** Adds not yet sent, in call order; the first one is in flight while the drain runs. */
  readonly #entries: Entry[] = [];
  readonly #off: Unsubscribe;
  #closed = false;
  #draining = false;
  /** The entry the drain has sent and is waiting on: it settles from the store's answer, even past `close()`. */
  #sending: Entry | undefined;

  constructor(client: StoreClient, opts: { onDisconnected: 'reject' | 'wait'; maxWaitMs: number; maxBufferedAdds: number }) {
    this.#client = client;
    this.#opts = opts;
    this.#off = client.onConnection((e) => {
      if (e.type === 'reconnected') void this.#drain();
    });
  }

  get buffered(): number {
    return this.#entries.length;
  }

  /** An add entering now would be held (wait mode, store away or buffer still draining) rather than sent at once. */
  get holding(): boolean {
    return this.#opts.onDisconnected === 'wait' && (this.#reconnecting() || this.#draining || this.#entries.length > 0);
  }

  /** Send now when connected; a send that never reached the store because it just went down follows the outage rules. */
  async run<T>(send: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new QueueClosedError('queue is closed');
    if (this.#reconnecting()) return this.#hold(send);
    // The buffer is still being sent: go after it, so the store sees adds in call order.
    if (this.#draining) return this.#enqueue(send, false);
    try {
      return await send();
    } catch (e) {
      if (!neverSent(e) || !this.#reconnecting() || this.#opts.onDisconnected === 'reject') throw e;
    }
    return this.#hold(send);
  }

  /** Read afresh: a send may have changed it. */
  #reconnecting(): boolean {
    return this.#client.state === 'reconnecting';
  }

  /** Reject every add not yet sent with QueueClosedError; later adds are refused. The one the drain sent settles from the store. */
  close(): void {
    this.#closed = true;
    this.#off();
    for (const e of this.#entries.splice(0)) {
      if (e === this.#sending) {
        this.#entries.push(e);
        continue;
      }
      e.timer?.cancel();
      e.reject(new QueueClosedError('queue closed while the add waited for the store'));
    }
  }

  /** The outage rules: reject at once, reject when the buffer is full, or wait at most maxWait. */
  #hold<T>(send: () => Promise<T>): Promise<T> {
    if (!this.#reconnecting()) return this.run(send); // back already
    if (this.#opts.onDisconnected === 'reject') return Promise.reject(notSent('onDisconnected is "reject"'));
    if (this.#entries.length >= this.#opts.maxBufferedAdds) return Promise.reject(notSent(`${this.#opts.maxBufferedAdds} adds already wait (maxBufferedAdds)`));
    return this.#enqueue(send, true);
  }

  #enqueue<T>(send: () => Promise<T>, timed: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { send, resolve: resolve as (v: unknown) => void, reject };
      if (timed) this.#arm(entry);
      this.#entries.push(entry);
    });
  }

  /** Reject `entry` with the wait-mode error once maxWait has passed since it was first held. Ref'd: a caller waits on it. */
  #arm(entry: Entry): void {
    entry.timer?.cancel();
    entry.deadline ??= platform.monotonicMs() + this.#opts.maxWaitMs;
    entry.timer = platform.setTimer(() => {
      const i = this.#entries.indexOf(entry);
      if (i >= 0) this.#entries.splice(i, 1);
      entry.reject(notSent(`the store was not back within ${this.#opts.maxWaitMs} ms (maxWait)`));
    }, Math.max(0, entry.deadline - platform.monotonicMs()), { ref: true });
  }

  /**
   * The store is back: send the held adds one after the other, in call order. If it drops again,
   * the drain stops; the unsent adds stay in front, in order, under the outage rules again.
   */
  // ponytail: one round trip per buffered add; prepare in parallel and only order the writes if a big buffer drains too slowly.
  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (const e of this.#entries) e.timer?.cancel();
      while (this.#entries.length > 0) {
        if (this.#client.state !== 'connected') return this.#stalled();
        const e = this.#entries[0]!;
        let value: unknown;
        this.#sending = e;
        try {
          value = await e.send();
        } catch (err) {
          // Not sent because the store dropped again: it stays first (back already: send it again), unless the queue closed meanwhile.
          if (neverSent(err) && !this.#closed) continue;
          this.#remove(e);
          e.reject(neverSent(err) ? new QueueClosedError('queue closed while the add waited for the store') : err);
          continue;
        } finally {
          this.#sending = undefined;
        }
        this.#remove(e);
        e.resolve(value);
      }
    } finally {
      this.#draining = false;
    }
  }

  /** The store dropped during the drain: the unsent adds wait again (wait mode) or are refused (reject mode). */
  #stalled(): void {
    if (this.#opts.onDisconnected === 'wait') {
      for (const e of this.#entries) this.#arm(e);
      return;
    }
    for (const e of this.#entries.splice(0)) e.reject(notSent('onDisconnected is "reject"'));
  }

  #remove(e: Entry): void {
    const i = this.#entries.indexOf(e);
    if (i >= 0) this.#entries.splice(i, 1);
  }
}

/**
 * An add whose outcome is unknown, once the store answers again: a job found under the generated id
 * means the earlier try landed; else it is sent again. A caller-chosen id cannot be told apart from
 * someone else's job, so that case rethrows `original`.
 */
export async function resolveAmbiguousAdd(
  deps: { get(id: string): Promise<JobRecord | null>; send(): Promise<AddOutcome> },
  id: string,
  idWasGenerated: boolean,
  original: StoreUnavailableError,
): Promise<AddOutcome> {
  if (!idWasGenerated) throw original;
  const found = await deps.get(id);
  if (found) return { status: 'added', job: found };
  const outcome = await deps.send();
  if (outcome.status === 'duplicate' && outcome.by === 'id' && outcome.job.id === id) return { status: 'added', job: outcome.job };
  return outcome;
}
