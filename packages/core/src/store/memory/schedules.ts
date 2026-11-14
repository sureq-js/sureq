import type {
  DeleteScheduleRequest, DeleteScheduleResult, FireScheduleRequest, FireScheduleResult, JobState, ListDueSchedulesResult,
  ListSchedulesRequest, ListSchedulesResult, NewJob, PutScheduleRequest, PutScheduleResult, ScheduleRecord, Scope,
} from '../contract.js';
import { parseRecord } from './format.js';
import { bad } from './validate.js';

/** One queue's schedules by key. */
export type ScheduleTable = Map<string, ScheduleRecord>;

/** A copy of a schedule for the caller, after its format version is checked. */
const out = (rec: ScheduleRecord): ScheduleRecord => structuredClone(parseRecord<ScheduleRecord>('schedule', rec));

/** Create (`expectedRev: null`) or replace (matching `rev`) a schedule; the store stamps scope, `rev` and the timestamps. */
export function putSchedule(table: ScheduleTable, scope: Scope, req: PutScheduleRequest, now: number): PutScheduleResult {
  const stored = table.get(req.schedule.key);
  if (req.expectedRev === null && stored) return { ok: false, reason: 'exists' };
  if (req.expectedRev !== null && stored?.rev !== req.expectedRev) return { ok: false, reason: 'conflict' };
  const rec: ScheduleRecord = {
    ...structuredClone(req.schedule),
    namespace: scope.namespace,
    queue: scope.queue,
    rev: (stored?.rev ?? 0) + 1,
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
  };
  table.set(rec.key, rec);
  return { ok: true, schedule: structuredClone(rec) };
}

export function getSchedule(table: ScheduleTable, key: string): ScheduleRecord | null {
  const rec = table.get(key);
  return rec ? out(rec) : null;
}

/** One page in key order after `cursor`; the cursor handed back is the page's last key. */
export function listSchedules(table: ScheduleTable, req: ListSchedulesRequest): ListSchedulesResult {
  // ponytail: sorts every key on each page (O(n log n)); an ordered index if a memory user holds many thousands of schedules
  const keys = [...table.keys()].filter((k) => req.cursor === undefined || k > req.cursor).sort();
  const page = keys.slice(0, req.limit);
  return { schedules: page.map((k) => out(table.get(k)!)), nextCursor: keys.length > req.limit ? page.at(-1)! : null };
}

export function deleteSchedule(table: ScheduleTable, req: DeleteScheduleRequest): DeleteScheduleResult {
  const stored = table.get(req.key);
  if (!stored) return { deleted: false, reason: 'not-found' };
  if (req.expectedRev !== undefined && stored.rev !== req.expectedRev) return { deleted: false, reason: 'conflict' };
  table.delete(req.key);
  return { deleted: true };
}

/** Due schedules by store time: not paused and (`nextRunAt <= now` or a queued tick), by `nextRunAt` then key. */
export function listDue(table: ScheduleTable, limit: number, now: number): ListDueSchedulesResult {
  // ponytail: scans every schedule of the scope per call; a heap by nextRunAt when a memory user has many thousands
  let nextDueAt: number | null = null;
  const due: ScheduleRecord[] = [];
  for (const rec of table.values()) {
    if (rec.paused) continue;
    if (nextDueAt === null || rec.nextRunAt < nextDueAt) nextDueAt = rec.nextRunAt;
    if (rec.nextRunAt <= now || rec.queuedTicks.length > 0) due.push(rec);
  }
  due.sort((a, b) => a.nextRunAt - b.nextRunAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { now, due: due.slice(0, limit).map(out), nextDueAt };
}

/** What `fire` needs from the job side of the store, inside the same critical section. */
export interface FireContext {
  /** Insert the fired job (`ignore` on a duplicate id) and stamp its schedule fields; returns the id that now holds the tick. */
  insert(job: NewJob, scheduledFor: number): string;
  stateOf(id: string): JobState | undefined;
}

const UNFINISHED: readonly (JobState | undefined)[] = ['waiting', 'delayed', 'active'];

/** One schedule tick, all or nothing: gone, conflict, paused, early, then the overlap policy, then the insert. */
export function fire(table: ScheduleTable, req: FireScheduleRequest, now: number, ctx: FireContext): FireScheduleResult {
  const rec = table.get(req.key);
  if (!rec) return { outcome: 'gone' };
  if (rec.rev !== req.expectedRev) return { outcome: 'conflict' };
  if (rec.paused) return { outcome: 'paused' };
  const tick = req.mode === 'tick';
  if (tick && now < rec.nextRunAt) return { outcome: 'early' };
  const scheduledFor = tick ? rec.nextRunAt : rec.queuedTicks[0];
  if (scheduledFor === undefined) bad('fireSchedule', 'backlog mode needs a queued tick');
  if (req.job.id !== `sched:${req.key}:${scheduledFor}`) bad('fireSchedule', `job.id must be sched:${req.key}:${scheduledFor}`);
  const unfinished = rec.lastJobId !== null && UNFINISHED.includes(ctx.stateOf(rec.lastJobId));
  const write = (patch: Partial<ScheduleRecord>): ScheduleRecord => {
    Object.assign(rec, patch, { rev: rec.rev + 1, updatedAt: now });
    return structuredClone(rec);
  };
  if (!tick && unfinished) return { outcome: 'busy' };
  if (tick && rec.overlap === 'skip' && unfinished) return { outcome: 'skipped', reason: 'overlap', schedule: write({ nextRunAt: req.nextRunAt! }) };
  if (tick && rec.overlap === 'queue' && (unfinished || rec.queuedTicks.length > 0)) {
    if (rec.queuedTicks.length >= rec.maxQueued) return { outcome: 'skipped', reason: 'backlog-full', schedule: write({ nextRunAt: req.nextRunAt! }) };
    return { outcome: 'queued', schedule: write({ nextRunAt: req.nextRunAt!, queuedTicks: [...rec.queuedTicks, scheduledFor] }) };
  }
  const jobId = ctx.insert(req.job, scheduledFor);
  const schedule = write({
    lastFiredFor: scheduledFor, lastJobId: jobId, runCount: rec.runCount + 1,
    ...(tick ? { nextRunAt: req.nextRunAt! } : { queuedTicks: rec.queuedTicks.slice(1) }),
  });
  return { outcome: 'fired', jobId, schedule };
}
