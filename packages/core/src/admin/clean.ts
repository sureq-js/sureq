import { InvalidOptionError, type ConfigIssue } from '../errors/catalog.js';
import type { CleanableState } from '../store/contract.js';
import { tryParseDuration } from '../util/duration.js';
import { validate, type Schema } from '../util/validate.js';
import type { AdminHost } from './redrive.js';

const CLEANABLE: readonly CleanableState[] = ['completed', 'failed', 'cancelled', 'waiting', 'delayed'];
/** The largest page one admin store call may delete. */
export const MAX_ADMIN_PAGE = 5000;
const pageSize = { kind: 'integer', min: 1, max: MAX_ADMIN_PAGE, default: 500 } as const;
const cleanSchema: Schema<{ limit?: number; pageSize: number }> = { fields: { limit: { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER }, pageSize } };
const drainSchema: Schema<{ delayed?: boolean; pageSize: number }> = { fields: { delayed: { kind: 'boolean' }, pageSize } };
export const obliterateSchema: Schema<{ force?: boolean; pageSize: number }> = { fields: { force: { kind: 'boolean' }, pageSize } };

/** Delete pages of jobs of one state, `olderThan` old by store time, until none is left or `limit` were removed. */
async function cleanPages(h: AdminHost, state: CleanableState, olderThanMs: number, limit: number, pageSize: number): Promise<{ removed: number; done: boolean }> {
  let removed = 0;
  for (;;) {
    const res = await h.client.call('clean', h.scope, { state, olderThanMs, limit: Math.min(pageSize, limit - removed) });
    removed += res.removed;
    // a page that removed nothing would repeat forever
    if (!res.remaining || removed >= limit || res.removed === 0) return { removed, done: !res.remaining };
  }
}

/**
 * `queue.clean`: remove the jobs of one state that are at least `olderThan` old (finished ones by when they finished,
 * waiting and delayed ones by when they were added), `pageSize` per store call, up to `limit`. Emits `cleaned` when it removed any.
 */
export async function cleanJobs(h: AdminHost, state: unknown, olderThan: unknown, opts: unknown = {}): Promise<{ removed: number; done: boolean }> {
  const issues: ConfigIssue[] = [];
  if (!CLEANABLE.includes(state as CleanableState)) issues.push({ path: 'state', code: 'invalid_value', message: `expected one of ${CLEANABLE.join(', ')}` });
  const age = tryParseDuration(olderThan);
  if (!age.ok) issues.push({ path: 'olderThan', code: age.code, message: 'expected a duration' });
  let o = { pageSize: 500 } as { limit?: number; pageSize: number };
  try {
    o = validate('clean', opts, cleanSchema);
  } catch (e) {
    if (!(e instanceof InvalidOptionError)) throw e;
    issues.push(...e.issues);
  }
  if (issues.length > 0 || !age.ok) throw new InvalidOptionError('clean', issues);
  const s = state as CleanableState;
  const res = await cleanPages(h, s, age.ms, o.limit ?? Infinity, o.pageSize);
  if (res.removed > 0) {
    h.emit('cleaned', { state: s, removed: res.removed });
    if (s === 'waiting' || s === 'delayed') await h.jobsLeft();
  }
  return res;
}

/** `queue.drain`: remove every waiting job (and delayed ones with `delayed`); running jobs are left alone. No event of its own. */
export async function drainJobs(h: AdminHost, opts: unknown = {}): Promise<{ removed: number }> {
  const o = validate('drain', opts, drainSchema);
  let removed = (await cleanPages(h, 'waiting', 0, Infinity, o.pageSize)).removed;
  if (o.delayed) removed += (await cleanPages(h, 'delayed', 0, Infinity, o.pageSize)).removed;
  if (removed > 0) await h.jobsLeft();
  return { removed };
}
