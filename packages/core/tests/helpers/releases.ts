import { FORMAT_SUPPORT, type FormatSupport } from '../../src/format/support.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import { clientFor } from '../../src/store/client.js';
import type { Store } from '../../src/store/contract.js';
import { silent } from './harness.js';
import { freezable } from './pods.js';

export type Release = FormatSupport & { sureqVersion: string };

/** A simulated SureQ release: its format support and version string. */
export const release = (over: Partial<FormatSupport> & { sureqVersion: string }): Release => ({ ...FORMAT_SUPPORT, ...over });

/** Expand release: still writes 1, already reads 2. */
export const K = release({ current: 1, minReadable: 1, maxReadable: 2, sureqVersion: '0.4.0' });
/** Switch release: writes 2, reads 1 and 2. */
export const K1 = release({ current: 2, minReadable: 1, maxReadable: 2, sureqVersion: '0.5.0' });
/** A release that reads only format 1. */
export const OLD = release({ current: 1, minReadable: 1, maxReadable: 1, sureqVersion: '0.3.0' });
/** A release that no longer reads format 1 or 2. */
export const NEW = release({ current: 3, minReadable: 3, maxReadable: 3, sureqVersion: '0.7.0' });

/** A pod of release `rel`: a Queue on its own view of `store`, so it has its own store client. */
export function podOn(store: Store, rel: Release, opts: QueueOptions & { name?: string } = {}): Queue {
  const { name = 'fmt', ...rest } = opts;
  const view = freezable(store);
  clientFor(view).__formatSupport = { ...rel };
  return new Queue(name, { logger: silent, ...rest, store: view });
}
