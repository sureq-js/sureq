# Schedules

A schedule makes one job on each tick of its timing: a `cron` rule in a time zone, or a fixed `every` period. It is stored, so every pod sees the same schedules.
This page creates a schedule that ticks every second, lets it fire twice, and previews a cron rule.

## Example

```ts
import { Queue } from '@sureq/core'

type Digest = { to: string }

const queue = new Queue<Digest>('digests')

// Safe to call on every start-up: the same definition answers 'unchanged'.
const first = await queue.upsertSchedule('team-digest', {
  every: '1s',
  template: { data: { to: 'team@example.com' } },
})
const again = await queue.upsertSchedule('team-digest', {
  every: '1s',
  template: { data: { to: 'team@example.com' } },
})
console.log(first.action, again.action)

// A cron rule in a time zone. previewSchedule stores nothing.
const times = await queue.previewSchedule({ cron: '0 7 * * 1-5', tz: 'Europe/Berlin' }, 2)
console.log(times.map((t) => new Date(t).toISOString()))

let runs = 0
let finish!: () => void
const done = new Promise<void>((resolve) => (finish = resolve))

// A worker on the queue also runs its scheduler, while `scheduler.enabled` is true (the default).
const worker = queue.process(
  async (job) => {
    console.log(job.id, job.schedule?.key)
    if (++runs === 2) finish()
  },
)
worker.on('error', ({ error }) => console.error('worker error', error))

await done
await queue.deleteSchedule('team-digest')
// close() also closes the worker.
await queue.close()
```

Output (your times differ):

```text
created unchanged
[ '2026-11-16T06:00:00.000Z', '2026-11-17T06:00:00.000Z' ]
sched:team-digest:1794701718162 team-digest
sched:team-digest:1794701719162 team-digest
```

- `upsertSchedule(key, definition)` creates the schedule, or updates it when the definition changed. Its `action` says which.
- `template` is what each job is made of: its `data`, and optionally a `name` and add options.
- Each fired job has the id `sched:<key>:<tick time>`, and `job.schedule` tells which schedule and tick made it.
- The two jobs came one second apart. The second came on the next tick of the same grid.
- `previewSchedule` lists the next fire times of a timing without storing anything. The cron rule `0 7 * * 1-5` is 07:00 on weekdays, here in Berlin time.

## Common questions

**Which pods fire schedules?** Every pod that runs a worker on the queue while the queue option `scheduler.enabled` is true (the default), and every pod that called `queue.startScheduler()`. See [Queue options: scheduler](../03-reference/01-queue.md#scheduler). A producer never fires one. A queue with no running scheduler anywhere fires nothing.

**Do several pods make several jobs per tick?** No. One job per tick, however many pods run a scheduler.

**What if the previous job is still running at the next tick?** The `overlap` option decides: skip the tick, queue it, or fire anyway. See [Overlap](../03-reference/13-schedules.md#overlap).

**What happens to ticks missed while no pod ran?** They collapse into one job for the oldest missed tick. Then the schedule goes on as usual. A deploy that keeps every pod down from 10:02 to 10:18 misses the 10:05, 10:10 and 10:15 ticks of a five-minute cron: at 10:18 one job fires for 10:05, and the next is the 10:20 tick. It is not configurable yet, but a handler can skip a late tick or run every missed one from `job.schedule.scheduledFor`. See [Missed ticks](../03-reference/13-schedules.md#missed-ticks).

**How do cron times behave across a daylight-saving change?** With `tz` set, a cron with a fixed hour (`30 2 * * *`) follows the clock: a skipped local time fires once at the end of the gap, and a repeated one fires once, in the first pass. A cron whose hour is `*` or a step (`*/2`) follows elapsed time: a skipped time fires nothing extra, and a repeated one fires in both passes. `every` ignores daylight saving. See [Cron](../03-reference/13-schedules.md#cron) for worked examples.

## Reference

- [Schedules](../03-reference/13-schedules.md)
- [Schedule methods](../03-reference/13-schedules.md#methods)
- [ScheduleDefinition](../03-reference/13-schedules.md#scheduledefinition)
- [Cron](../03-reference/13-schedules.md#cron)
- [Every](../03-reference/13-schedules.md#every)
- [Missed ticks](../03-reference/13-schedules.md#missed-ticks)
- [Queue options: scheduler](../03-reference/01-queue.md#scheduler)
- [Events: schedules](../03-reference/06-events.md#schedules)
