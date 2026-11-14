// Schedule records: the four schedule methods store.ts delegates to. Same rules as store.ts: each function checks
// its request first, then returns the body store.ts runs inside its one transaction with the one clock read.
// The store never reads `template.data` or `template.opts`; core owns what a schedule means.
import type {
  AddOutcome, DeleteScheduleRequest, DeleteScheduleResult, FireScheduleRequest, FireScheduleResult, JobState, ListDueSchedulesResult,
  ListSchedulesRequest, ListSchedulesResult, NewJob, PutScheduleRequest, PutScheduleResult, ScheduleRecord, Scope,
} from '@sureq/core';
import type { Tx } from './backend.js';
import { bad, bool, check, checkJob, idOf, int, isObj, oneOf, payload, text } from './check.js';

type Body<T> = (tx: Tx, now: number) => T;

/** A schedule key leaves room for the fired job id `sched:<key>:<tick>` inside 255 bytes. */
const KEY = idOf(200);
const MAX_LIST_LIMIT = 1000;
const nullOr = (pred: (v: unknown) => boolean) => (v: unknown): boolean => v === null || pred(v);
const SCHEDULE = {
  formatVersion: int(1), key: KEY, kind: oneOf('cron', 'every'), cron: text, tz: text, everyMs: int(1), anchorAt: int(0), template: isObj,
  overlap: oneOf('skip', 'queue', 'allow'), maxQueued: int(1, 1000), paused: bool, nextRunAt: int(0), lastFiredFor: nullOr(int(0)),
  lastJobId: nullOr(text), queuedTicks: (v: unknown) => Array.isArray(v) && v.every(int(Number.MIN_SAFE_INTEGER)), runCount: int(0),
  definitionHash: text, definitionVersion: int(0),
};
const REQUIRED = [
  'formatVersion', 'key', 'kind', 'template', 'overlap', 'maxQueued', 'paused', 'nextRunAt', 'lastFiredFor', 'lastJobId', 'queuedTicks',
  'runCount', 'definitionHash', 'definitionVersion',
];

/*
 * SUREQ-CONTRACT: putSchedule
 * WHY: the rev check and the write are one transaction, so of two writers holding the same rev exactly one wins;
 * `expectedRev: null` means "must not exist yet", which makes a create race-safe too.
 * WHY: the store stamps rev (1 on create, +1 on every write), createdAt (kept on update) and updatedAt from its own clock.
 */
export function putSchedule(scope: Scope, req: PutScheduleRequest): Body<PutScheduleResult> {
  check('putSchedule', 'request', req, { schedule: isObj, expectedRev: nullOr(int(1)) }, ['schedule', 'expectedRev']);
  check('putSchedule', 'schedule', req.schedule, SCHEDULE, REQUIRED);
  check('putSchedule', 'template', req.schedule.template, { name: nullOr(text), data: payload, opts: isObj }, ['name', 'data', 'opts']);
  const timing = req.schedule.kind === 'cron' ? 'cron' : 'everyMs';
  if (req.schedule[timing] === undefined) bad('putSchedule', `kind ${req.schedule.kind} needs ${timing}`);
  return (tx, now) => {
    const stored = tx.getSchedule(scope, req.schedule.key);
    if (req.expectedRev === null && stored) return { ok: false, reason: 'exists' };
    if (req.expectedRev !== null && stored?.rev !== req.expectedRev) return { ok: false, reason: 'conflict' };
    const rec: ScheduleRecord = {
      ...req.schedule, namespace: scope.namespace, queue: scope.queue, rev: (stored?.rev ?? 0) + 1, createdAt: stored?.createdAt ?? now, updatedAt: now,
    };
    // REPLACE-ME: the compare-and-set write: SQL INSERT ... ON CONFLICT DO NOTHING or UPDATE ... WHERE rev = $expected, Redis WATCH the key or a Lua script comparing rev, Mongo insertOne on a unique key or updateOne({ key, rev }).
    tx.putSchedule(scope, rec);
    return { ok: true, schedule: rec };
  };
}

/*
 * SUREQ-CONTRACT: getSchedule
 * WHY: one schedule by key, a copy, or null; an unknown scope is just empty.
 */
export function getSchedule(scope: Scope, req: { key: string }): Body<ScheduleRecord | null> {
  check('getSchedule', 'request', req, { key: KEY }, ['key']);
  return (tx) => tx.getSchedule(scope, req.key) ?? null;
}

/*
 * SUREQ-CONTRACT: listSchedules
 * WHY: pages in key order after the cursor; the cursor is the last key handed back, so a page never repeats one.
 * WHY: `nextCursor` is null only when nothing follows the page.
 */
export function listSchedules(scope: Scope, req: ListSchedulesRequest): Body<ListSchedulesResult> {
  check('listSchedules', 'request', req, { cursor: text, limit: int(1, MAX_LIST_LIMIT) }, ['limit']);
  return (tx) => {
    // REPLACE-ME: a key-ordered page read one past the limit: SQL WHERE key > $cursor ORDER BY key LIMIT n + 1, Redis ZRANGEBYLEX on a sorted set of keys per queue, Mongo find({ key: { $gt: cursor } }).sort({ key: 1 }).limit(n + 1).
    const rows = tx.scanSchedules(scope, { ...(req.cursor !== undefined && { afterKey: req.cursor }), limit: req.limit + 1 });
    const schedules = rows.slice(0, req.limit);
    return { schedules, nextCursor: rows.length > req.limit ? schedules.at(-1)!.key : null };
  };
}

/*
 * SUREQ-CONTRACT: deleteSchedule
 * WHY: with `expectedRev` the delete is a compare-and-set like putSchedule; without it, whatever is stored goes.
 * WHY: jobs a schedule already made are not touched.
 */
export function deleteSchedule(scope: Scope, req: DeleteScheduleRequest): Body<DeleteScheduleResult> {
  check('deleteSchedule', 'request', req, { key: KEY, expectedRev: int(1) }, ['key']);
  return (tx) => {
    const stored = tx.getSchedule(scope, req.key);
    if (!stored) return { deleted: false, reason: 'not-found' };
    if (req.expectedRev !== undefined && stored.rev !== req.expectedRev) return { deleted: false, reason: 'conflict' };
    tx.deleteSchedule(scope, req.key);
    return { deleted: true };
  };
}

/*
 * SUREQ-CONTRACT: listDueSchedules
 * WHY: "due" is judged by the store clock: not paused and `nextRunAt <= now`, or a tick waiting in `queuedTicks`.
 * WHY: due schedules come by `nextRunAt`, then key; `nextDueAt` is the earliest `nextRunAt` of any running schedule,
 * so the scheduler can sleep until then; `now` is handed back so core never reads its own clock.
 */
export function listDueSchedules(scope: Scope, req: { limit: number }): Body<ListDueSchedulesResult> {
  check('listDueSchedules', 'request', req, { limit: int(1, MAX_LIST_LIMIT) }, ['limit']);
  return (tx, now) => {
    // REPLACE-ME: the due scan: SQL WHERE NOT paused AND (next_run_at <= $now OR cardinality(queued_ticks) > 0) ORDER BY next_run_at, key LIMIT n, Redis a sorted set by nextRunAt per queue, Mongo an index on { paused, nextRunAt }.
    const due = tx.scanSchedules(scope, { paused: false, dueAtMost: now, order: 'nextRunAt', limit: req.limit });
    const first = tx.scanSchedules(scope, { paused: false, order: 'nextRunAt', limit: 1 })[0];
    return { now, due, nextDueAt: first?.nextRunAt ?? null };
  };
}

const UNFINISHED: readonly (JobState | undefined)[] = ['waiting', 'delayed', 'active'];

/*
 * SUREQ-CONTRACT: fireSchedule
 * WHY: the job insert, the overlap read of `lastJobId` and the schedule write share one transaction, so no state
 * has an advanced schedule without its job, and of many pods firing one tick with the same rev exactly one wins.
 * WHY: the order is fixed: gone, conflict (rev), paused, early (tick mode, store now before `nextRunAt`), overlap, insert.
 * WHY: the store, not the caller, stamps `scheduleKey` and `scheduledFor` on the job, and refuses a job id other
 * than `sched:<key>:<scheduledFor>`, so a plain add can never pass for a fired tick.
 * WHY: an unfinished previous run is `lastJobId` waiting, delayed or active; `skip` drops the tick, `queue` appends it
 * to `queuedTicks` up to `maxQueued`; backlog mode fires the oldest queued tick, or answers `busy`.
 * WHY: a job with the fired id that already exists still counts: the tick is `fired` with that id.
 */
export function fireSchedule(
  scope: Scope, req: FireScheduleRequest, maxIdBytes: number, addOne: (tx: Tx, job: NewJob, now: number) => AddOutcome,
): Body<FireScheduleResult> {
  const op = 'fireSchedule';
  check(op, 'request', req, { key: KEY, expectedRev: int(1), mode: oneOf('tick', 'backlog'), nextRunAt: int(1), job: isObj }, ['key', 'expectedRev', 'mode', 'job']);
  if ((req.mode === 'tick') !== (req.nextRunAt !== undefined)) bad(op, 'nextRunAt is sent in tick mode only, and always there');
  checkJob(op, req.job, maxIdBytes);
  // WHY: a fired job never holds a singleton key, so a tick can never be refused for one.
  if (req.job.singletonKey != null) bad(op, 'a fired job takes no singletonKey');
  return (tx, now) => {
    // REPLACE-ME: the rev check and the schedule write are one compare-and-set in the job insert's transaction: SQL UPDATE schedules SET ... WHERE key = $1 AND rev = $expectedRev, then check the row count (0 is conflict) before the INSERT of the job in the same transaction; Redis a script that compares rev, writes the schedule and inserts the job; Mongo updateOne({ key, rev: expectedRev }) plus the job insert in one transaction.
    const rec = tx.getSchedule(scope, req.key);
    if (!rec) return { outcome: 'gone' };
    if (rec.rev !== req.expectedRev) return { outcome: 'conflict' };
    if (rec.paused) return { outcome: 'paused' };
    const tick = req.mode === 'tick';
    if (tick && now < rec.nextRunAt) return { outcome: 'early' };
    const scheduledFor = tick ? rec.nextRunAt : rec.queuedTicks[0];
    if (scheduledFor === undefined) return bad(op, 'backlog mode needs a queued tick');
    if (req.job.id !== `sched:${req.key}:${scheduledFor}`) bad(op, `job.id must be sched:${req.key}:${scheduledFor}`);
    const unfinished = rec.lastJobId !== null && UNFINISHED.includes(tx.get(scope, rec.lastJobId)?.state);
    const write = (patch: Partial<ScheduleRecord>): ScheduleRecord => {
      const next = { ...rec, ...patch, rev: rec.rev + 1, updatedAt: now };
      tx.putSchedule(scope, next);
      return next;
    };
    if (!tick && unfinished) return { outcome: 'busy' };
    if (tick && rec.overlap === 'skip' && unfinished) return { outcome: 'skipped', reason: 'overlap', schedule: write({ nextRunAt: req.nextRunAt! }) };
    if (tick && rec.overlap === 'queue' && (unfinished || rec.queuedTicks.length > 0)) {
      if (rec.queuedTicks.length >= rec.maxQueued) return { outcome: 'skipped', reason: 'backlog-full', schedule: write({ nextRunAt: req.nextRunAt! }) };
      return { outcome: 'queued', schedule: write({ nextRunAt: req.nextRunAt!, queuedTicks: [...rec.queuedTicks, scheduledFor] }) };
    }
    // WHY: `ignore` on a duplicate id whatever the request says, so a repeat never replaces the tick's job.
    const added = addOne(tx, { ...req.job, onDuplicate: 'ignore' }, now) as Exclude<AddOutcome, { status: 'not-applied' }>;
    if (added.status === 'added') tx.put(scope, { ...added.job, scheduleKey: req.key, scheduledFor });
    const schedule = write({
      lastFiredFor: scheduledFor, lastJobId: added.job.id, runCount: rec.runCount + 1,
      ...(tick ? { nextRunAt: req.nextRunAt! } : { queuedTicks: rec.queuedTicks.slice(1) }),
    });
    return { outcome: 'fired', jobId: added.job.id, schedule };
  };
}
