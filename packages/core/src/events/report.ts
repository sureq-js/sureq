import type { SureQError } from '../errors/base.js';
import type { Logger } from '../logger/logger.js';
import type { ErrorEvent, ErrorSource } from './types.js';

/**
 * Build the store-error reporter: emit an `error` event, then log at `error` level, at most once per
 * distinct message per `rateLimitMs` (default 10 s; 0 = no limit). Events are never limited.
 * Neither step can throw: a failing listener or logger is swallowed.
 */
export function createReporter(deps: {
  emit: (e: ErrorEvent) => void;
  logger: Logger;
  now: () => number;
  queue: string;
  workerId?: string;
  rateLimitMs?: number;
}): (error: SureQError, source: ErrorSource, context?: Partial<ErrorEvent['context']>) => void {
  const rateLimitMs = deps.rateLimitMs ?? 10_000;
  const lastLogged = new Map<string, number>();
  return (error, source, context = {}) => {
    const ctx: ErrorEvent['context'] = { ...context, queue: deps.queue, ...(deps.workerId !== undefined && { workerId: deps.workerId }) };
    try {
      deps.emit({ error, source, context: ctx });
    } catch {
      // A reporter must never throw.
    }
    try {
      const now = deps.now();
      const last = lastLogged.get(error.message);
      if (rateLimitMs > 0 && last !== undefined && now - last < rateLimitMs) return;
      // ponytail: one entry per distinct message, never pruned; messages are templated so the set stays small.
      lastLogged.set(error.message, now);
      deps.logger.error(`sureq ${source} error: ${error.message}`, { code: error.code, source, ...ctx });
    } catch {
      // A broken logger must not break the queue.
    }
  };
}
