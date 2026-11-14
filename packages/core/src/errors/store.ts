import { isSureQError, type SureQError } from './base.js';
import { StoreUnavailableError } from './catalog.js';

/** Writes whose effect is unknown when the call fails part-way; reads have no effect to doubt. */
const WRITES = new Set([
  'add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'setPaused', 'clean', 'obliterate', 'redrive',
  'setProgress', 'registerWorker', 'heartbeatWorker', 'unregisterWorker', 'purgeWorkers', 'ensureNamespaceMeta', 'putSchedule', 'deleteSchedule',
  'fireSchedule',
]);

/**
 * Turn whatever a store call threw into a typed error. A SureQError passes through; anything else
 * (also a string or undefined) becomes StoreUnavailableError with the original as `cause`.
 */
export function wrapStoreError(operation: string, cause: unknown, jobId?: string): SureQError {
  if (isSureQError(cause)) return cause;
  return new StoreUnavailableError(`Store operation '${operation}' failed`, {
    operation, retryable: true, outcomeUnknown: WRITES.has(operation), cause, ...(jobId !== undefined && { jobId }),
  });
}
