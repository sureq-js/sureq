import { InvalidOptionError, PayloadTooLargeError, StoreUnavailableError } from '../errors/catalog.js';
import { serializeValue } from '../serialize/value.js';
import type { FencedRejection, SetProgressResult } from '../store/contract.js';
import { platform, type Timer } from '../platform/index.js';

export { deriveProgress, type JobProgress, type ProgressObject } from '../job/progress.js';

const MAX_MESSAGE_CHARS = 1000;

const invalid = (scope: string, path: string, message: string, cause?: unknown): InvalidOptionError =>
  new InvalidOptionError(scope, [{ path, code: path === 'value' ? 'invalid_type' : 'out_of_range', message }], cause === undefined ? {} : { cause });

/**
 * The JSON payload of one progress call: the counter form `(n, total?, message?)` or the object form `(value)`.
 * Throws InvalidOptionError for a bad argument and PayloadTooLargeError for an object over `maxBytes`.
 */
export function encodeProgress(args: readonly unknown[], o: { maxBytes: number; queue: string; baseAt?: number; scope?: string }): string {
  const scope = o.scope ?? 'ctx.progress';
  const [first, total, message] = args;
  if (typeof first === 'number') {
    if (!Number.isFinite(first) || first < 0) throw invalid(scope, 'n', 'expected a finite number >= 0');
    if (total !== undefined && (typeof total !== 'number' || !Number.isFinite(total) || total <= 0)) {
      throw invalid(scope, 'total', 'expected a finite number > 0');
    }
    if (message !== undefined && typeof message !== 'string') throw invalid(scope, 'message', 'expected a string');
    const text = message === undefined ? null : Array.from(message).slice(0, MAX_MESSAGE_CHARS).join('');
    return JSON.stringify({ kind: 'counter', n: first, total: total ?? null, message: text, ...(o.baseAt !== undefined && { baseAt: o.baseAt }) });
  }
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    throw invalid(scope, 'value', 'expected a number or a non-array object');
  }
  let encoded: { json: string; bytes: number };
  try {
    encoded = serializeValue(first);
  } catch (e) {
    throw invalid(scope, 'value', 'expected a serializable object', e);
  }
  if (encoded.bytes > o.maxBytes) throw new PayloadTooLargeError({ size: encoded.bytes, limit: o.maxBytes, queue: o.queue, field: 'progress' });
  return `{"kind":"object","value":${encoded.json}}`;
}

type Waiter = { resolve: () => void; reject: (e: unknown) => void };
interface ChannelOptions {
  intervalMs: number;
  now: () => number;
  write: (payload: string) => Promise<SetProgressResult>;
  onWritten: (payload: string, updatedAt: number) => void;
  /** Returns the error the waiting calls reject with. */
  onRejected: (r: FencedRejection) => Promise<Error>;
  onError: (e: unknown) => void;
}

/**
 * The progress writes of one field of one attempt. The first value is written at once; values pushed within
 * `intervalMs` of the last send are merged, the latest wins, and go out at the end of the interval. Writes never
 * overlap. A push resolves once its value or a later one was written, or a write failed with a store error.
 */
export class ProgressChannel {
  readonly #o: ChannelOptions;
  #pending: { payload: string; waiters: Waiter[] } | undefined;
  #inFlight: Promise<void> | undefined;
  #timer: Timer | undefined;
  #lastSentAt = -Infinity;
  #closed: Error | undefined;
  /** The calls waiting on the write in flight. */
  #sending: Waiter[] = [];

  constructor(o: ChannelOptions) {
    this.#o = o;
  }

  push(payload: string): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      const waiters = this.#pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      this.#pending = { payload, waiters };
      this.#schedule();
    });
  }

  /**
   * Write the pending value now, ignoring the interval, and wait until nothing is in flight, but not past
   * `deadline` (on `now`'s clock; `undefined`: no lease left, so give up at once). What is not written by then is
   * dropped: the channel closes and its calls reject with `reason`, else a StoreUnavailableError.
   */
  async flush(deadline: number | undefined, reason?: Error): Promise<void> {
    this.#timer?.cancel();
    this.#timer = undefined;
    for (;;) {
      if (this.#inFlight) {
        if (deadline !== undefined && (await this.#settlesBy(this.#inFlight, deadline))) continue;
      } else if (this.#pending && !this.#closed) {
        if (deadline !== undefined) {
          this.#send();
          continue;
        }
      } else return;
      // The write's outcome is unknown and nothing will retry it: the same meaning as a store call that timed out.
      const err = reason ?? new StoreUnavailableError('progress write dropped at the lease deadline', {
        operation: 'setProgress', retryable: true, outcomeUnknown: true,
      });
      this.close(err);
      for (const w of this.#sending) w.reject(err);
      return;
    }
  }

  /** True when `p` settles before `deadline`; no timer for an endless deadline. */
  async #settlesBy(p: Promise<void>, deadline: number): Promise<boolean> {
    if (deadline === Infinity) return p.then(() => true);
    let timer: Timer | undefined;
    const late = new Promise<boolean>((r) => (timer = platform.setTimer(() => r(false), Math.max(0, deadline - this.#o.now()))));
    try {
      return await Promise.race([p.then(() => true), late]);
    } finally {
      timer?.cancel();
    }
  }

  /**
   * Refuse later pushes; values not yet written reject with `reason`. A write still out is not waited for: its
   * late answer is dropped, so a refusal after a release is never read as a lost lease.
   */
  close(reason?: Error): void {
    if (this.#closed) return;
    this.#closed = reason ?? new InvalidOptionError('ctx.progress', [
      { path: '', code: 'conflict', message: 'the handler has returned; progress can no longer be reported' },
    ]);
    this.#timer?.cancel();
    this.#timer = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    for (const w of pending?.waiters ?? []) w.reject(this.#closed);
  }

  #schedule(): void {
    if (this.#inFlight || this.#timer || !this.#pending) return;
    const wait = this.#lastSentAt + this.#o.intervalMs - this.#o.now();
    if (wait <= 0) return this.#send();
    this.#timer = platform.setTimer(() => {
      this.#timer = undefined;
      this.#send();
    }, wait);
  }

  #send(): void {
    this.#timer?.cancel();
    this.#timer = undefined;
    // One write at a time: a timer or flush that finds nothing to send, or a write still out, does nothing.
    const sent = this.#pending;
    if (!sent || this.#inFlight) return;
    this.#pending = undefined;
    this.#sending = sent.waiters;
    this.#lastSentAt = this.#o.now();
    this.#inFlight = this.#o.write(sent.payload).then(
      async (r) => {
        if (r.ok) {
          // Closed while the write was out: the attempt is over (or given back), so nothing is announced for it.
          if (!this.#closed) this.#o.onWritten(sent.payload, r.now);
          for (const w of sent.waiters) w.resolve();
          return;
        }
        // Closed while the write was out (the attempt ended or was given back): the refusal is expected.
        let err = this.#closed;
        if (!err) {
          try {
            err = await this.#o.onRejected(r);
          } catch (e) {
            err = e as Error;
          }
        }
        for (const w of sent.waiters) w.reject(err);
        this.close(err);
      },
      (e: unknown) => {
        // Best effort: an outage never fails the job or holds the handler; a later value is still written.
        this.#o.onError(e);
        for (const w of sent.waiters) w.resolve();
      },
    ).catch((e: unknown) => {
      // A throwing callback must not leave the waiters hanging or the channel open.
      for (const w of sent.waiters) w.reject(e);
      this.close(e as Error);
    }).finally(() => {
      this.#inFlight = undefined;
      if (!this.#closed) this.#schedule();
    });
  }
}
