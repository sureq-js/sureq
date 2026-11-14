import { JobTimeoutError } from '../errors/catalog.js';
import { parsePayload } from '../job/job.js';
import type { JobRecord } from '../store/contract.js';
import { platform, type Timer } from '../platform/index.js';

export const DEFAULT_TIMEOUT_GRACE_MS = 5000;

type Limits = { timeoutMs?: number | undefined; graceMs?: number | undefined };

/**
 * One attempt's time limit: at `timeoutMs` abort the signal with JobTimeoutError, then after
 * `graceMs` more call `onAbandon`. Another abort reason first, or `settled()`, clears both timers.
 */
export function startTimeout(opts: {
  timeoutMs: number;
  graceMs: number;
  abort: AbortController;
  jobId: string;
  attempt: number;
  onAbandon(error: JobTimeoutError): void;
}): { settled(): void } {
  const { timeoutMs, graceMs, abort, jobId, attempt, onAbandon } = opts;
  const error = (abandoned: boolean) => new JobTimeoutError({ jobId, attempt, timeoutMs, graceMs, abandoned });
  let grace: Timer | undefined;
  const clear = () => {
    limit?.cancel();
    grace?.cancel();
    abort.signal.removeEventListener('abort', clear);
  };
  const abandon = () => {
    clear();
    onAbandon(error(true));
  };
  const limit = platform.setTimer(() => {
    abort.signal.removeEventListener('abort', clear);
    abort.abort(error(false));
    if (graceMs === 0) abandon();
    else grace = platform.setTimer(abandon, graceMs);
  }, timeoutMs, { ref: true });
  abort.signal.addEventListener('abort', clear);
  return { settled: clear };
}

/** A stored limit is used only when it is a whole number of ms within the bounds the add accepts. */
const MAX_TIMER_MS = 2_147_483_647;
const ms = (v: unknown, min: number): number | undefined => (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= MAX_TIMER_MS ? (v as number) : undefined);

/** Per field: the value stored at add (when valid), then the worker's, then the queue's; grace falls back to 5 s. */
export function resolveTimeout(job: Pick<JobRecord, 'timeout'>, worker: Limits, queue: Limits): { timeoutMs: number | undefined; graceMs: number } {
  let own: Limits = {};
  try {
    const parsed = parsePayload(job.timeout ?? null);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const { timeoutMs, graceMs } = parsed as Record<string, unknown>;
      own = { timeoutMs: ms(timeoutMs, 1), graceMs: ms(graceMs, 0) };
    }
  } catch {
    // Unreadable: the pod's values apply.
  }
  return {
    timeoutMs: own.timeoutMs ?? worker.timeoutMs ?? queue.timeoutMs,
    graceMs: own.graceMs ?? worker.graceMs ?? queue.graceMs ?? DEFAULT_TIMEOUT_GRACE_MS,
  };
}
