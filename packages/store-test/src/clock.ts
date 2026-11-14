import type { TestClock } from './types.js';

/** A manual clock: time moves only through `advance`. */
export class FakeClock implements TestClock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    if (!Number.isInteger(ms) || ms < 0) throw new RangeError(`advance(ms) needs a non-negative integer, got ${ms}`);
    this.#now += ms;
  }
}
