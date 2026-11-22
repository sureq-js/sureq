# Schedules

A schedule is a stored record that makes one job for each tick of its timing: a `cron` rule in a time zone, or a fixed `every` period.

```ts
await queue.upsertSchedule('digest', {
  cron: '0 7 * * *',
  tz: 'Europe/Berlin',
  template: { data: { to: 'team@example.com' } },
})
```

- Schedules live in the store, so every pod sees the same ones. `Queue` and `Producer` both manage them.
- They fire only on a pod that runs the queue's scheduler: every pod with a worker on the queue, from its first `process()` until its last worker closes, or a pod that called `startScheduler()`. A producer never fires one. Scheduler options are in [Queue options](01-queue.md#scheduler).
- One job per tick, however many pods run a scheduler. Ticks are judged by store time; pod clocks never matter. A tick fires within about `tickMs` of its time.
- After downtime, the missed ticks collapse into one job for the oldest missed tick. The schedule then goes on from its grid. See [Missed ticks](#missed-ticks).
- `queue.pause()` holds the jobs back but does not stop schedules from making them. Use `pauseSchedule(key)`.
- A running scheduler keeps the process alive until it stops or the queue closes.

## Methods

| Method | Returns |
|---|---|
| `upsertSchedule(key, def)` | `Promise<UpsertResult<T>>` |
| `getSchedule(key)` | `Promise<Schedule \| null>` |
| `listSchedules(opts?)` | `Promise<{ schedules: Schedule[]; nextCursor: string \| null }>` |
| `pauseSchedule(key)` | `Promise<Schedule>` |
| `resumeSchedule(key)` | `Promise<Schedule>` |
| `deleteSchedule(key)` | `Promise<boolean>` |
| `nextRuns(key, n?)` | `Promise<number[]>` |
| `previewSchedule(timing, n?)` | `Promise<number[]>` |

```ts
const { action } = await queue.upsertSchedule('digest', { every: '1h', template: { data: { to: 'team@example.com' } } })
const schedule = await queue.getSchedule('digest')
const { schedules, nextCursor } = await queue.listSchedules({ state: 'paused', limit: 50 })
await queue.pauseSchedule('digest')
await queue.resumeSchedule('digest')
const deleted = await queue.deleteSchedule('digest')
const next = await queue.nextRuns('digest', 3)
const preview = await queue.previewSchedule({ cron: '30 2 * * 1-5', tz: 'Europe/Berlin' })
```

- `key` is a non-empty string of at most 200 UTF-8 bytes. The job id `sched:<key>:<tick>` must also fit the store's id limit.
- `upsertSchedule` creates or replaces the schedule. It is safe to call from every pod at start-up. `UpsertResult` is `{ schedule, action }`, with `action` one of `'created'`, `'updated'`, `'unchanged'` (the same definition is stored) or `'stale'` (a higher `version` is stored, and nothing was written).
- `getSchedule` returns `null` for an unknown key.
- `listSchedules` returns one page in key order. Options: `limit` 1 to 1000 (default `100`), `cursor` (the `nextCursor` of the page before), and `state` (`'active'` or `'paused'`). With `state`, a page may hold fewer than `limit` while `nextCursor` is set.
- `pauseSchedule` stops the ticks. `resumeSchedule` starts them again from the next tick after now; missed ticks are not caught up. Both throw `ScheduleNotFoundError` for an unknown key.
- `deleteSchedule` returns `false` when there was none. Jobs it already made are left alone.
- `nextRuns` returns the next `n` tick times after store now, in epoch ms, also for a paused schedule. It throws `ScheduleNotFoundError` for an unknown key.
- `previewSchedule` returns up to `n` tick times of a timing after store now. It stores nothing.
- `n` is 1 to 100 (default `5`).
- A bad definition, key or timing throws one `InvalidOptionError` listing every problem. Issues about the timing carry a `reason`: `'bad-cron'`, `'bad-timezone'`, `'no-occurrence'`, `'bad-interval'` or `'bad-overlap'`.
- Events: `scheduleFired`, `scheduleSkipped` and `scheduleQueued` on the pod that fired; `schedulePaused`, `scheduleResumed` and `scheduleDeleted` on the object that called. See [Events](06-events.md#schedules).

## ScheduleDefinition

`ScheduleDefinition<D>` is a `ScheduleTiming` plus these keys.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `cron` | `string` | none | A cron rule. Give `cron` or `every`, not both. See [Cron](#cron). |
| `tz` | `string` | `'UTC'` | The IANA time zone of `cron`, such as `'Europe/Berlin'`. Only with `cron`. |
| `every` | `Duration` | none | A fixed period, 1 s to 100 years. See [Every](#every). |
| `template` | `ScheduleTemplate<D>` | required | What each job is made of. See [ScheduleTemplate](#scheduletemplate). |
| `version` | `number` | none: unversioned | A positive whole number. A stored definition with a higher `version` is never replaced by a lower one. |
| `overlap` | `OverlapPolicy` | `'skip'` | What a tick does while the schedule's previous job has not finished. See [Overlap](#overlap). |
| `maxQueued` | `number` | `10` | Ticks kept waiting under `overlap: 'queue'`, 1 to 1000. Only with `'queue'`. |

```ts
await queue.upsertSchedule('digest', { cron: '0 7 * * 1-5', template: { data: { to: 'team@example.com' } } })
await queue.upsertSchedule('digest', { cron: '0 7 * * *', tz: 'America/New_York', template: { data: { to: 'team@example.com' } } })
await queue.upsertSchedule('poll', { every: '30s', template: { data: { to: 'ops@example.com' } } })
await queue.upsertSchedule('digest', { every: '1d', template: { name: 'digest', data: { to: 'team@example.com' } } })
await queue.upsertSchedule('digest', { every: '1d', version: 3, template: { data: { to: 'team@example.com' } } })
await queue.upsertSchedule('report', { every: '1h', overlap: 'allow', template: { data: { to: 'team@example.com' } } })
await queue.upsertSchedule('report', { every: '1h', overlap: 'queue', maxQueued: 3, template: { data: { to: 'team@example.com' } } })
```

Give a `version` for rolling deploys. A pod that still has an older definition answers `'stale'` and logs one warning, instead of overwriting the newer one.

## ScheduleTiming

`ScheduleTiming` is `{ cron: string; tz?: string }` or `{ every: number | string }`. `previewSchedule` takes it on its own.

### Cron

Five fields. There is no seconds field: use `every` below one minute.

| Field | Values | Names |
|---|---|---|
| minute | 0-59 | |
| hour | 0-23 | |
| day of month | 1-31 | |
| month | 1-12 | `JAN`-`DEC` |
| day of week | 0-7 (0 and 7 are Sunday) | `SUN`-`SAT` |

- Each field is a comma-separated list of `*`, `*/n`, `a`, `a-b` or `a-b/n`. Names are case-insensitive and work as range ends. `L`, `W`, `#`, `?` and `a/n` are not supported.
- Aliases: `@yearly` (`0 0 1 1 *`), `@monthly` (`0 0 1 * *`), `@weekly` (`0 0 * * 0`), `@daily` (`0 0 * * *`), `@hourly` (`0 * * * *`).
- When both day of month and day of week are restricted, a day matches if either one matches: `0 0 13 * 5` is every 13th and every Friday. Otherwise both must match. A field that starts with `*`, such as `*/2`, is not restricted.
- `tz` must be an IANA zone name or `'UTC'`. Abbreviations and offsets such as `'EST'`, `'CET'`, `'GMT'` or `'+02:00'` are refused with `'bad-timezone'`. Times are computed from store now with the zone rules of the pod's Node.js, so run the same Node.js version on every pod.
- A rule must match some date within 9 years: `0 0 30 2 *` is refused with `'no-occurrence'`. `0 0 29 2 *` fires on leap days only.

Daylight saving: an hour field of `*` or with a step (`*/2`, `0-10/5`) follows elapsed time. Any other hour field follows the clock.

| Change | Elapsed-time rule | Clock-time rule |
|---|---|---|
| A local time is skipped (spring forward) | Nothing extra fires. | Fires once, at the end of the gap. |
| A local time repeats (fall back) | Fires in both passes. | Fires once, in the first pass. |

In `Europe/Berlin` on 2026-03-29 (02:00 jumps to 03:00):

| Expression | Fires at (UTC) |
|---|---|
| `30 2 * * *` | `01:00Z` (the end of the gap) |
| `*/30 2 * * *` | `01:00Z`, once |
| `0 * * * *` | every full hour; 23 runs that day |

In `Europe/Berlin` on 2026-10-25 (03:00 falls back to 02:00):

| Expression | Fires at (UTC) |
|---|---|
| `30 2 * * *` | `00:30Z` only |
| `0 * * * *` | every full hour, both `00:00Z` and `01:00Z` |

### Every

Whole milliseconds, or a string with unit `ms`, `s`, `m`, `h` or `d` (`'30s'`, `'2h'`). From 1 second to 100 years. There is no `w` unit.

Ticks sit on a fixed grid, `anchor + k × period`, anchored at store now when the schedule is created. A late fire never moves the next tick.

```ts
await queue.previewSchedule({ every: '15m' }, 3)
```

## ScheduleTemplate

`ScheduleTemplate<D>` is what each fired job is made of.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `data` | `D` | required | The job data. Serialized and checked once, at upsert: against `maxPayloadBytes` and the queue `filter` (operation `'schedule'`). |
| `name` | `string` | none: an unnamed job | The job name. |
| `opts` | add options | none | Any [add option](02-job-options.md) except `id`, `delay`, `runAt`, `onDuplicate`, `uniqueWhile`, `singletonKey` and `idempotencyKey`. |

```ts
await queue.upsertSchedule('digest', { every: '1d', template: { data: { to: 'team@example.com' } } })
await queue.upsertSchedule('digest', { every: '1d', template: { name: 'digest', data: { to: 'team@example.com' } } })
await queue.upsertSchedule('digest', { every: '1d', template: { data: { to: 'team@example.com' }, opts: { maxAttempts: 5, priority: 10 } } })
```

The queue's `defaultJobOptions` apply when each job is made, so changing them changes later jobs. The template's own `opts` win.

## Fired jobs

- Each fired job has the id `sched:<key>:<scheduledFor>` and `runAt` set to `scheduledFor`.
- `job.schedule` is `{ key, scheduledFor }` on a fired job and `null` on others. See [Job and context](07-job-and-context.md#job).

```ts
queue.process(async (job) => {
  if (job.schedule) console.log(`tick ${job.schedule.scheduledFor} of ${job.schedule.key}`)
})
```

## Missed ticks

A tick is missed when no pod ran the queue's scheduler at its time: every pod was down for a deploy, or the store was unreachable. When a scheduler runs again, all of a schedule's missed ticks collapse into **one** job:

- Its `scheduledFor` is the **oldest** missed tick, and it fires within about `tickMs` of the scheduler starting.
- The ticks after it are not run. The schedule goes on with its next tick after now, on the same grid.
- The `overlap` policy applies to that one job like to any tick.

Example: a schedule with `cron: '*/5 * * * *'` and a deploy that keeps every pod down from 10:02 to 10:18. The 10:05, 10:10 and 10:15 ticks are missed. At 10:18 one job fires with `scheduledFor` 10:05, and the next job is the 10:20 tick.

A paused schedule is different: `resumeSchedule` goes on from the next tick after now and runs no missed tick.

This behaviour is not configurable yet; a per-schedule setting to skip missed ticks or run every one of them is planned for a later release. Until then, a handler can decide from `job.schedule.scheduledFor`. These examples assume a schedule with a fixed period:

```ts
const PERIOD = 5 * 60_000 // the schedule's period

// Skip: drop a catch-up job, keep only ticks that run on time
queue.process(async (job) => {
  if (job.schedule && job.attempt === 1 && Date.now() - job.schedule.scheduledFor > PERIOD) return
  await sendReport()
})

// Catch up: run the work once for every tick the job stands for
queue.process(async (job) => {
  if (!job.schedule) return
  for (let t = job.schedule.scheduledFor; t < Date.now(); t += PERIOD) await sendReportFor(t)
})
```

- `scheduledFor` is in store time; `Date.now()` is the pod's clock, which is close enough for a period of minutes.
- The skip check looks at the first attempt only, so a retry of an on-time tick still runs.
- In the catch-up loop, make `sendReportFor(t)` safe to repeat for the same `t`: a job can run more than once.

## Overlap

`OverlapPolicy` decides what a tick does while the schedule's previous job is waiting, delayed or active.

| Value | What the tick does |
|---|---|
| `'skip'` | Dropped. `scheduleSkipped` fires with `reason: 'overlap'`. The default. |
| `'queue'` | Kept in a backlog of at most `maxQueued` ticks, run one job at a time in tick order. `scheduleQueued` fires. Past the cap the tick is dropped with `reason: 'backlog-full'`. |
| `'allow'` | Fires anyway. |

## Schedule

`Schedule<D>` is a stored schedule as the methods return it.

| Field | Type | Meaning |
|---|---|---|
| `key` | `string` | The key. |
| `namespace` | `string` | The namespace. |
| `queue` | `string` | The queue name. |
| `kind` | `'cron' \| 'every'` | Which timing it uses. |
| `cron` | `string`, optional | The cron rule. |
| `tz` | `string`, optional | The time zone. |
| `everyMs` | `number`, optional | The period, in ms. |
| `anchorAt` | `number`, optional | Start of the `every` grid, in store time. |
| `template` | `{ name: string \| null; data: Jsonify<D>; opts: Record<string, unknown> }` | The template, data read back from JSON (a `Date` as its ISO string). |
| `overlap` | `OverlapPolicy` | The overlap policy. |
| `maxQueued` | `number` | The backlog cap. |
| `paused` | `boolean` | `true` while paused. |
| `nextRunAt` | `number` | The next tick, in store time. |
| `lastFiredFor` | `number \| null` | The tick of the last job made. |
| `lastJobId` | `string \| null` | The id of the last job made. |
| `queuedTicks` | `number[]` | Ticks in the `'queue'` backlog. |
| `runCount` | `number` | Jobs made so far. |
| `definitionHash` | `string` | A hash of the definition, used to answer `'unchanged'`. |
| `definitionVersion` | `number` | The stored `version`. |
| `formatVersion` | `number` | The record format. |
| `createdAt` | `number` | When the schedule was first stored, in store time. |
| `updatedAt` | `number` | When the schedule was last changed, in store time. |
| `rev` | `number` | The revision, raised on each write. |
| `createdAt` | `number` | When it was created, in store time. |
| `updatedAt` | `number` | When it was last written, in store time. |

```ts
const s = await queue.getSchedule('digest')
if (s) console.log(s.kind, s.paused, new Date(s.nextRunAt).toISOString(), s.runCount)
```

## Health

`health()` warns `SCHEDULER_STALE` when this pod's running scheduler has not finished a loop turn in 5 × `tickMs`, and `NO_SCHEDULER_RUNNING` when the queue has unpaused schedules and no live worker runs a scheduler. See [Health and metrics](11-health-and-metrics.md#health-warnings).
