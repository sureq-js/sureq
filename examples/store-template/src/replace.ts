// How `add` with `onDuplicate: 'replace'` rewrites the existing record; store.ts calls it inside its transaction.
import type { JobRecord, NewJob } from '@sureq/core';
import { isObj } from './check.js';

function parseOrUndefined(v: string): unknown {
  try { return JSON.parse(v); } catch { return undefined; }
}

/** A stored timeout as an object of integer fields (else undefined); a replace's timeout overrides only the sub-fields it names, `null` clears it. */
function timeoutOf(v: JobRecord['timeout']): Record<string, number> | undefined {
  const t = typeof v === 'string' ? parseOrUndefined(v) : undefined;
  return isObj(t) && Object.values(t).every(Number.isInteger) ? (t as Record<string, number>) : undefined;
}

/** The record after `replace`: new data, plus only the fields the caller set (and did not just default). */
export function applyReplace(existing: JobRecord, job: NewJob, now: number): JobRecord {
  const set = (k: 'name' | 'priority' | 'maxAttempts' | 'dataVersion' | 'backoff' | 'timeout' | 'idempotencyKey' | 'keep'): boolean =>
    Object.hasOwn(job, k) && !(job.defaulted as readonly string[] | undefined)?.includes(k);
  const next: JobRecord = { ...existing, data: job.data, rev: existing.rev + 1 };
  if (set('name')) next.name = job.name ?? null;
  if (set('priority')) next.priority = job.priority!;
  if (set('maxAttempts')) next.maxAttempts = Math.max(job.maxAttempts, existing.attempt);
  if (set('dataVersion')) next.dataVersion = job.dataVersion ?? null;
  if (set('backoff')) next.backoff = job.backoff ?? null;
  const [was, given] = [timeoutOf(existing.timeout), timeoutOf(job.timeout ?? null)];
  if (set('timeout')) next.timeout = was && given ? JSON.stringify({ ...was, ...given }) : job.timeout ?? null;
  if (set('idempotencyKey')) next.idempotencyKey = job.idempotencyKey ?? null;
  if (set('keep')) next.keep = job.keep ?? null;
  if (job.runAt !== undefined) next.runAt = job.runAt;
  else if (job.delayMs !== undefined) next.runAt = now + job.delayMs;
  next.state = next.runAt > now ? 'delayed' : 'waiting';
  return next;
}
