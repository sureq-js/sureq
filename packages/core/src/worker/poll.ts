import type { ClaimResult } from '../store/contract.js';

/** What one claim told the poller; `blocked.retryAfterMs` is honoured when a store reports it. */
export type PollInput = Pick<ClaimResult, 'jobs' | 'now' | 'nextRunAt' | 'paused'> & { blocked?: { reason: string; retryAfterMs?: number } | undefined };

/** The adaptive wait between claims: doubles while idle, with jitter, bounded by `[pollMin, pollMax]`. */
export class PollDelay {
  readonly #o: { pollMin: number; pollMax: number; pollFactor: number; pollJitter: number; random: () => number };
  #base: number | undefined;

  constructor(o: { pollMin: number; pollMax: number; pollFactor: number; pollJitter: number; random: () => number }) {
    this.#o = o;
  }

  /** Milliseconds to wait after a claim with this result; 0 when it returned jobs. */
  next(r: PollInput): number {
    const { pollMin, pollMax, pollFactor, pollJitter, random } = this.#o;
    if (r.jobs.length > 0) {
      this.reset();
      return 0;
    }
    this.#base = this.#base === undefined ? pollMin : Math.min(pollMax, this.#base * pollFactor);
    // A paused queue polls at pollMax, jittered (downward only) so pods do not poll in lockstep.
    if (r.paused) this.#base = pollMax;
    let d = this.#base * (1 + pollJitter * (2 * random() - 1));
    if (r.paused) return Math.round(Math.max(pollMin, Math.min(pollMax, d)));
    // Both instants come from this response, so pod clocks never enter the wait.
    if (r.nextRunAt !== null) d = Math.min(d, r.nextRunAt - r.now);
    if (r.blocked?.retryAfterMs !== undefined) d = Math.min(d, r.blocked.retryAfterMs);
    return Math.round(Math.min(pollMax, Math.max(pollMin, d)));
  }

  /** Back to `pollMin` (a wake-up happened). */
  reset(): void {
    this.#base = undefined;
  }
}
