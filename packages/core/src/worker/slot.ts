import type { ShutdownError } from '../errors/catalog.js';

/** How recording one attempt's outcome ended. */
export type Settled = 'committed' | 'lost' | 'cancelled' | 'unconfirmed';

/** What close, pause, cancel and the concurrency count see of one running attempt or batch. */
export interface Slot {
  readonly key: string;
  /** Every outcome recorded or released. */
  readonly done: Promise<void>;
  /** A handler still runs, or a batch is still forming. */
  readonly running: boolean;
  /** Jobs held or running here. */
  readonly jobIds: readonly string[];
  /** Close's timeout was reached: abort. False when everything here is already lost or cancelled. */
  shutdown(reason: ShutdownError): boolean;
  /** Still running after the grace: release what is unsettled, handler started. */
  abandon(): Promise<void>;
  /** The job was cancelled on this pod: abort its attempt here. True when it was held or running here. */
  abortJob(id: string, reason: Error): boolean;
}
