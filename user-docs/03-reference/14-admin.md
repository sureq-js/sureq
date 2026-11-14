# Admin

Calls that manage jobs in bulk or change how a queue runs: cancel and remove, dead letters and redrive, clean, drain, obliterate, and pause. `Queue` and `Producer` both have them.

In the examples, `queue` is a `Queue<{ to: string }>` and `id` is a job id.

## Cancel and remove

| Method | Returns |
|---|---|
| `cancel(id)` | `Promise<JobCancelResult<Job<D, R>>>` |
| `remove(id)` | `Promise<boolean>` |

```ts
const res = await queue.cancel(id)
if (res.cancelled) console.log('was', res.previousState)
const removed = await queue.remove(id)
```

`cancel(id)`, also `job.cancel()`:

- A waiting or delayed job, also one waiting for a retry, becomes `cancelled` and never runs.
- An active job becomes `cancelled` in the store at once. A handler in this queue object's workers sees `ctx.signal` abort with `JobCancelledError` straight away; one on another pod at its next heartbeat or finishing write. Its result or error is discarded: no `completed`, `failed` or retry, and no crash is counted.
- Cancelling a running job cannot undo side effects it already made. Handlers must honour `ctx.signal` to stop early.
- The result is `{ cancelled: true, previousState, job }`, or `{ cancelled: false, reason: 'already-terminal', state, job }` for a finished job, which is left as it is. Cancelling twice is harmless.
- An unknown id throws `JobNotFoundError`.
- The `cancelled` event fires once, in the queue object that called. Cancel works while paused and with no workers. The id is free for a new add afterwards.

`remove(id)` deletes a job that is not running, with its attempt history. It returns `false` for an unknown id and throws `InvalidJobStateError` for an active job. It also deletes a superseded dead letter by its `id#seq` key.

## Dead letters

A job that fails for good is kept as a dead letter: it stays `failed` with its id, data, error and history, and `job.deadLetter` says when (store time) and why. It is never claimed again until you redrive it. The queue option `deadLetter` turns this on and off; see [Queue options](01-queue.md#deadletter).

| Method | Returns |
|---|---|
| `getDeadLetters(opts?)` | `Promise<{ jobs: Job<D, R>[]; nextCursor: string \| null }>` |
| `countDeadLetters(opts?)` | `Promise<number>` |

| Option | Type | Default | Meaning |
|---|---|---|---|
| `reason` | `DeadLetterReason` | any | Only dead letters with this reason. Both methods. |
| `olderThan` | `Duration` | none | Only dead letters at least this old, by dead-letter time. `getDeadLetters` only. |
| `limit` | `number` | `100` | Page size, 1 to 1000. `getDeadLetters` only. |
| `cursor` | `string` | none | The `nextCursor` of the page before. `getDeadLetters` only. |

```ts
const { jobs, nextCursor } = await queue.getDeadLetters({ reason: 'exhausted', olderThan: '1h', limit: 100 })
if (nextCursor) await queue.getDeadLetters({ cursor: nextCursor })
const n = await queue.countDeadLetters({ reason: 'crashLimit' })
```

- `getDeadLetters` lists the oldest first. The cursor is an offset, so a redrive between pages can shift it.
- `DeadLetterReason`:

| Reason | Means |
|---|---|
| `'exhausted'` | No attempts were left. |
| `'unrecoverable'` | The handler threw `UnrecoverableError`, or called `ctx.fail(err, { retry: false })`. |
| `'retryRejected'` | `retryIf` said no. |
| `'crashLimit'` | The sweeper failed it at `maxCrashes`. |
| `'legacy'` | A pod of the previous release failed it. |

## Redrive

A redrive moves failed jobs back to `waiting`, or to `delayed` with a `delay`.

| Method | Returns |
|---|---|
| `redrive(id, opts?)` | `Promise<RedriveOutcome>` |
| `redrive(ids, opts?)` | `Promise<RedriveOutcome[]>` |
| `redriveAll(filter?, opts?)` | `Promise<RedriveSummary>` |

`RedriveOptions`, for every redrive call and `job.retry(opts)`:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `delay` | `Duration` | `0` | Run this much later instead of now. |
| `priority` | `number` | the job's own | A new priority. A whole number from -2147483648 to 2147483647. |
| `resetAttempts` | `boolean` | `true` | Start the attempt and crash counts from 0 again. With `false`, the job gets one more attempt. |

```ts
await queue.redrive(id, { delay: '5m' })
await queue.redrive(id, { priority: 10 })
await queue.redrive(id, { resetAttempts: false })
```

`redriveAll` filter and its extra options:

| Name | Type | Default | Meaning |
|---|---|---|---|
| `filter.reason` | `DeadLetterReason` | any | Only dead letters with this reason. |
| `filter.olderThan` | `Duration` | none | Only dead letters at least this old. |
| `limit` | `number` | no limit | Stop after this many jobs were redriven. At least 1. |
| `pageSize` | `number` | `100` | Dead letters per store call, 1 to 1000. |

```ts
const summary = await queue.redriveAll({ reason: 'unrecoverable', olderThan: '1h' }, { limit: 5000, pageSize: 100, delay: '1m' })
```

- A redrive is one conditional store write per job, valid only while the job is `failed`. Two redrives of one job move it once.
- The job goes back at its original FIFO position, with `redriveCount` raised by 1, `lastError` set to its last error, and the dead-letter marker, retention and progress cleared. Its attempt history is kept; the next attempts carry the next `cycle`.
- `redrive` with an id or a list works on any failed job, dead letter or not. `redriveAll` takes dead letters only, oldest first.
- `redrive(ids)` returns outcomes in input order. A job named twice is redriven once, then `'not-failed'`.
- `redriveAll` is not atomic. If it fails part way, the jobs already moved stay moved; run it again for the rest.
- `job.retry(opts)` redrives that job. It throws `InvalidJobStateError` for a job that is not failed and `JobNotFoundError` for a removed one.
- Each moved job fires one `redriven` event in the calling object.

`RedriveOutcome` is one of:

| Value | Means |
|---|---|
| `{ id, status: 'redriven', state: 'waiting' \| 'delayed', viaDeadLetter }` | Moved. `viaDeadLetter` is `false` for a plain failed job. |
| `{ id, status: 'skipped', reason: 'not-failed' }` | The job is not failed. |
| `{ id, status: 'skipped', reason: 'not-found' }` | No job has this id. |
| `{ id, status: 'skipped', reason: 'duplicate-id' }` | A superseded dead letter whose id a newer job holds. |

`RedriveSummary` is `{ redriven, skipped, done, skippedIds }`. `done` is `true` once no matching dead letter is left. `skippedIds` holds the first 100 skipped ids.

### Superseded dead letters

Under `uniqueWhile: 'pending'`, a new job may take a dead letter's id. The dead letter then moves to the key `id#seq`. It is still a dead letter: `getDeadLetters`, `countDeadLetters` and the `DEAD_LETTERS_HIGH` warning count it, and deleting or trimming the new job never deletes it.

- In a list, `redrive` answers `'duplicate-id'` for it. `redriveAll` passes it by.
- `queue.redrive(id)` with a single id throws `DuplicateJobError` with `reason: 'superseded'`.
- Delete it with `queue.remove('id#seq')`, `clean('failed', ...)` or `obliterate()`.

## Clean, drain and obliterate

These delete jobs for good. Nothing can bring them back.

| Method | Returns |
|---|---|
| `clean(state, olderThan, opts?)` | `Promise<{ removed: number; done: boolean }>` |
| `drain(opts?)` | `Promise<{ removed: number }>` |
| `obliterate(opts?)` | `Promise<{ removed: number }>` |

### clean

`clean(state, olderThan, opts?)` deletes jobs in one state that are at least `olderThan` old, each with its attempt history.

- `state` is a `CleanableState`: `'completed'`, `'failed'`, `'cancelled'`, `'waiting'` or `'delayed'`. Active jobs cannot be cleaned.
- `olderThan` is a `Duration` in store time: finished jobs by when they finished, waiting and delayed jobs by when they were added. `0` matches all.
- `clean('failed', ...)` also deletes dead letters.
- It emits `cleaned` once per call that removed any.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `limit` | `number` | no limit | Stop after this many. At least 1. `done` is `false` when the limit stopped it. |
| `pageSize` | `number` | `500` | Jobs deleted per store call, 1 to 5000. |

```ts
await queue.clean('completed', '7d')
await queue.clean('failed', '30d', { limit: 10_000 })
await queue.clean('cancelled', 0, { pageSize: 1000 })
```

### drain

`drain(opts?)` deletes every waiting job. Running jobs are left alone. It emits no event of its own; `drained` fires once no job is left waiting, delayed or running.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `delayed` | `boolean` | `false` | Also delete delayed jobs. |
| `pageSize` | `number` | `500` | Jobs deleted per store call, 1 to 5000. |

```ts
await queue.drain()
await queue.drain({ delayed: true })
await queue.drain({ pageSize: 1000 })
```

### obliterate

`obliterate(opts?)` deletes the whole queue: its jobs, attempt history, dead letters, schedules and pause flag. Other queues are untouched. It emits `obliterated` when done.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `force` | `boolean` | `false` | Go ahead while jobs are running. Their handlers' writes are refused and their workers report a lost lease. |
| `pageSize` | `number` | `500` | Records deleted per store call, 1 to 5000. |

```ts
await queue.obliterate()
await queue.obliterate({ force: true })
await queue.obliterate({ pageSize: 1000 })
```

- With jobs running and no `force`, it throws `QueueNotIdleError`.
- While it runs, adds, claims, sweeps, redrives, progress writes and schedule writes on the queue throw `QueueObliteratingError`. Workers just idle.
- If it dies part way, the queue stays blocked until you call `obliterate()` again, which finishes the job.
- It throws `InvalidOptionError` while a registered worker, or the namespace's format record, names an older release. `force` does not override that. Finish a rolling upgrade first.

## Pause and resume

| Method | Returns |
|---|---|
| `pause()` | `Promise<{ changed: boolean }>` |
| `resume()` | `Promise<{ changed: boolean }>` |
| `pauseState()` | `Promise<{ paused: boolean }>` |
| `isPaused()` | `boolean` |

```ts
await queue.pause()
await queue.resume()
const { paused } = await queue.pauseState()
```

- `queue.pause()` sets a flag in the store. Every claim on the queue, on every pod, then returns nothing until `resume()`. `changed` is `false` when the flag was already set.
- Running jobs are not told and finish normally. Adds, reads, `remove`, the sweeper and schedules keep working. `getCounts().blocked` counts the waiting jobs held back.
- `pauseState()` reads the flag from the store. `isPaused()` is the flag as this pod last saw it, with no store call. Other pods see a change from their next claim, up to one `pollMax` later; the store enforces the pause inside each claim either way.
- `paused` and `resumed` events fire once per change. See [Events](06-events.md#pause-and-close).
- To stop one worker only, use `worker.pause()`; see [Worker options](04-worker-options.md#worker). To stop a schedule, use `pauseSchedule(key)`; see [Schedules](13-schedules.md).
