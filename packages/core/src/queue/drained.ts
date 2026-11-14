import type { JobState } from '../store/types.js';

/**
 * Decides when a queue has just become empty (the `drained` event). Armed by this instance's own
 * work (add, claim, remove); evaluated from one store `counts()` read after a job leaves for good.
 * No local job counter: the store's counts are the only truth, so several pods agree.
 */
export class DrainedLatch {
  readonly #readCounts: () => Promise<Record<JobState, number>>;
  #armed = false;
  #addEpoch = 0;

  constructor(readCounts: () => Promise<Record<JobState, number>>) {
    this.#readCounts = readCounts;
  }

  arm(): void {
    this.#armed = true;
  }

  /** An add began: arm, and make any evaluation in flight re-read. */
  addStarted(): void {
    this.#addEpoch++;
    this.#armed = true;
  }

  async evaluate(emit: () => void): Promise<void> {
    for (let pass = 0; pass < 2; pass++) {
      const epoch = this.#addEpoch;
      const c = await this.#readCounts();
      if (c.waiting + c.delayed + c.active !== 0) return;
      if (epoch !== this.#addEpoch) continue; // an add started during the read: re-read once
      // Check and clear in the same tick as the result: concurrent finishes cannot both emit.
      if (this.#armed) {
        this.#armed = false;
        emit();
      }
      return;
    }
  }
}
