# Queue

A `Queue` holds jobs of one name in one namespace of one store. You add jobs to it, and you start workers on it.

```ts
import { Queue } from '@sureq/core'

const queue = new Queue<{ to: string }, { sent: true }>('emails', { namespace: 'shop' })
```

- `new Queue<D, R, Names>(name, opts?)`. `D` is the job data type, `R` the result type. `Names` maps job names to their types (see [Named jobs](#named-jobs)).
- `name` is 1 to 100 characters from `A-Z a-z 0-9 _ . -`.
- With no `store` option the queue makes its own in-memory store and closes it in `close()`. A store you pass in stays open.
- A bad option throws `InvalidOptionError` at once, listing every problem. See [Errors](08-errors.md).

## Durations

Many options take a `Duration`: whole milliseconds, or a string with a unit.

| Form | Example | Means |
|---|---|---|
| number | `1500` | 1500 ms |
| string with `ms`, `s`, `m`, `h` or `d` | `'250ms'`, `'1.5s'`, `'30s'`, `'5m'`, `'2h'`, `'1d'` | that many units |

There is no `w` unit. A negative number is refused. The value must come to whole milliseconds: `'1.5s'` is fine, `'0.5ms'` is refused.

## Queue options

Every key of `QueueOptions`. Options marked "worker default" are the defaults for this queue's workers; a worker can set its own value in `process` (see [Worker options](04-worker-options.md)).

### Store and identity

| Name | Type | Default | Meaning |
|---|---|---|---|
| `store` | `Store` | a private in-memory store | Where jobs live. Pass one store to share it between queues. |
| `namespace` | `string` | `'default'` | Keeps apps or environments apart in one store. 1 to 64 characters from `A-Z a-z 0-9 _ . -`. |
| `storeCallTimeout` | `Duration` | `'30s'` | Longest one store call may take. A late call fails with a retryable `StoreUnavailableError`. At least 1 ms. The first queue on a store object sets it for that store. |
| `reconnect` | `ReconnectOptions` | see [reconnect](#reconnect) | How the store is probed while it is unreachable. |
| `onDisconnected` | `'reject' \| 'wait'` | `'reject'` | What `add` does while the store is unreachable: fail at once, or wait in a buffer. |
| `maxWait` | `Duration` | `'10s'` | Longest an `add` waits for the store in `'wait'` mode. |
| `maxBufferedAdds` | `number` | `1000` | Most adds waiting for the store in `'wait'` mode. An `addBulk` counts as one. |

```ts
new Queue('emails', { store: new MemoryStore() })
new Queue('emails', { namespace: 'shop' })
new Queue('emails', { storeCallTimeout: '10s' })
new Queue('emails', { reconnect: { initialDelay: 200, maxDelay: '1m' } })
new Queue('emails', { onDisconnected: 'wait' })
new Queue('emails', { onDisconnected: 'wait', maxWait: '30s' })
new Queue('emails', { onDisconnected: 'wait', maxBufferedAdds: 5000 })
```

### Adding jobs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `defaultJobOptions` | `JobDefaults` | none | `maxAttempts`, `backoff` and `priority` for every add. See [Job options](02-job-options.md#job-defaults). |
| `id` | `(data: D) => string` | none: a UUIDv7 per job | Makes the job id from the data, for adds without their own `id`. Must be synchronous. |
| `onDuplicate` | `DuplicateRule<D>` | `'ignore'` | What `add` does when the id is taken. See [Job options](02-job-options.md#duplicates). |
| `uniqueWhile` | `'pending' \| 'retained'` | `'pending'` | How long a job holds its id. See [Job options](02-job-options.md#duplicates). |
| `order` | `'fifo' \| 'lifo'` | `'fifo'` | Claim order among jobs of equal priority. |
| `filter` | `FilterFn<D>` | none | Checks every add before it is stored. A rejection throws `JobRejectedError`. |
| `filterTimeoutMs` | `number` | `5000` | Longest the filter may take, in ms. Past it the add fails with `FilterError`. |
| `maxPayloadBytes` | `number` | `1048576` (1 MiB) | Largest job data, in UTF-8 bytes of its JSON. A larger add throws `PayloadTooLargeError`. |
| `maxBulkSize` | `number` | `1000` | Most inputs in one `addBulk` call. |

```ts
new Queue('emails', { defaultJobOptions: { maxAttempts: 5, backoff: '10s', priority: 1 } })
new Queue<{ to: string }>('emails', { id: (data) => `welcome-${data.to}` })
new Queue('emails', { onDuplicate: 'replace' })
new Queue('emails', { uniqueWhile: 'retained' })
new Queue('emails', { order: 'lifo' })
new Queue<{ to: string }>('emails', { filter: (data) => data.to.includes('@') || 'not an email address' })
new Queue('emails', { filter: async () => true, filterTimeoutMs: 1000 })
new Queue('emails', { maxPayloadBytes: 64 * 1024 })
new Queue('emails', { maxBulkSize: 500 })
```

A filter returns `true` to accept, `false` to reject with reason `'filtered'`, a string to reject with that reason, or `{ reject, code?, details? }`. Anything else, or a throw, is a `FilterError`: the filter fails closed.

### Results and errors

| Name | Type | Default | Meaning |
|---|---|---|---|
| `maxResultBytes` | `number` | `1048576` (1 MiB) | Largest handler result, in UTF-8 bytes of its JSON. A larger result fails the job with `ResultTooLargeError`. |
| `maxErrorBytes` | `number` | `16384` | Most bytes of a stored error. At least 512. |
| `storeStacks` | `boolean` | `true` | Keep stack traces in stored errors. |

```ts
new Queue('emails', { maxResultBytes: 4096 })
new Queue('emails', { maxErrorBytes: 4096 })
new Queue('emails', { storeStacks: false })
```

### Workers, leases and time limits

| Name | Type | Default | Meaning |
|---|---|---|---|
| `leaseDuration` | `Duration` | `'30s'` | Worker default. How long a claimed job is held before another worker may take it. 1 s to 1 d. |
| `leaseDurationByName` | `Record<string, Duration>` | none | Worker default. Lease length per job name. Same range. |
| `maxCrashes` | `number` | `3` | Lease expiries (a crashed or stuck worker) before the job fails with `PoisonPillError`. |
| `timeout` | `Duration` | none | Worker default. Abort `ctx.signal` with `JobTimeoutError` this long after the handler starts. |
| `timeoutGrace` | `Duration` | `'5s'` | Worker default. How long a timed-out handler may keep running before the attempt fails anyway. |
| `shutdownTimeout` | `Duration` | `'25s'` | Worker default. How long `close()` lets running handlers finish. |
| `shutdownAbortGrace` | `Duration` | `'2s'` | Worker default. How long `close()` waits after aborting handlers, before it releases their jobs. |
| `signals` | `ProcessSignal[]` | `[]` | Process signals that close the queue, installed at the first `process()`. The first calls `close()`; a second exits with code 1 without releasing jobs. |

```ts
new Queue('emails', { leaseDuration: '2m' })
new Queue('emails', { leaseDurationByName: { report: '10m' } })
new Queue('emails', { maxCrashes: 5 })
new Queue('emails', { timeout: '1m' })
new Queue('emails', { timeout: '1m', timeoutGrace: '10s' })
new Queue('emails', { shutdownTimeout: '1m' })
new Queue('emails', { shutdownAbortGrace: '5s' })
new Queue('emails', { signals: ['SIGTERM', 'SIGINT'] })
```

For one job name the lease comes from, in order: the worker's `leaseDurationByName`, the queue's `leaseDurationByName`, the worker's `leaseDuration`, the queue's `leaseDuration`, then 30 s. For `timeout` and `timeoutGrace` the value given at `add` wins, then the worker's, then the queue's.

### Polling

All polling options are worker defaults. See [Worker options](04-worker-options.md#polling) for what each one does.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `pollMin` | `Duration` | `100` ms | Shortest wait between claims. |
| `pollMax` | `Duration` | `'5s'` | Longest wait while idle. |
| `pollFactor` | `number` | `2` | Growth of the wait after each empty claim. Above 1. |
| `pollJitter` | `number` | `0.2` | Random spread of each wait, 0 to 1. |
| `notify` | `boolean` | `true` | Wake on the store's change notifications, when the store has them. |

```ts
new Queue('emails', { pollMin: 50 })
new Queue('emails', { pollMax: '10s' })
new Queue('emails', { pollFactor: 1.5 })
new Queue('emails', { pollJitter: 0.5 })
new Queue('emails', { notify: false })
```

### Logging

| Name | Type | Default | Meaning |
|---|---|---|---|
| `logger` | `Logger \| false` | console at `warn` | Where log lines go. `false` turns logging off. See [Logging](12-logging.md). |

```ts
new Queue('emails', { logger: consoleLogger({ level: 'info' }) })
```

### History, dead letters and retention

| Name | Type | Default | Meaning |
|---|---|---|---|
| `history` | `boolean \| { maxRecordsPerJob?: number }` | on, 50 records per job | One record per attempt. `false` writes none. See [history](#history). |
| `deadLetter` | `boolean \| { warnAbove?: number \| false; keep?: Keep }` | on | Keep jobs that failed for good as dead letters. See [deadLetter](#deadletter). |
| `retention` | `RetentionOptions` | see [retention](#retention) | How long finished jobs are kept. |

```ts
new Queue('emails', { history: { maxRecordsPerJob: 10 } })
new Queue('emails', { deadLetter: { warnAbove: 100, keep: { age: '90d' } } })
new Queue('emails', { retention: { completed: { count: 500, age: '1d' } } })
```

### Schedules, metrics and alerts

| Name | Type | Default | Meaning |
|---|---|---|---|
| `scheduler` | `SchedulerOptions` | see [scheduler](#scheduler) | The schedule loop this queue runs on a pod with a worker. |
| `metrics` | `MetricsOptions` | window `'5m'` | How `queue.metrics()` counts. See [Health and metrics](11-health-and-metrics.md). |
| `alerts` | `AlertRules & { interval?: Duration }` | none: no alerts | Threshold alerts, checked every `interval` (default `'15s'`). See [Health and metrics](11-health-and-metrics.md). |

```ts
new Queue('emails', { scheduler: { enabled: false } })
new Queue('emails', { metrics: { window: '15m' } })
new Queue('emails', { alerts: { depth: { above: 1000 } } })
```

### reconnect

`ReconnectOptions`. The wait between probes is `min(maxDelay, initialDelay × factor^n)`, spread by `jitter`. The first queue on a store object sets it for that store.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `initialDelay` | `Duration` | `100` ms | First wait. At least 1 ms. |
| `maxDelay` | `Duration` | `'30s'` | Longest wait. At least `initialDelay`, at most 2147483647 ms (about 24.8 days). |
| `factor` | `number` | `2` | Growth after each failed probe. At least 1. |
| `jitter` | `number` | `0.2` | Random spread of each wait, 0 to 1. |

```ts
new Queue('emails', { reconnect: { initialDelay: '500ms' } })
new Queue('emails', { reconnect: { maxDelay: '1m' } })
new Queue('emails', { reconnect: { factor: 3 } })
new Queue('emails', { reconnect: { jitter: 0 } })
```

### history

| Name | Type | Default | Meaning |
|---|---|---|---|
| `maxRecordsPerJob` | `number` | `50` | Newest attempt records kept per job. At least 1. The running record is never dropped. |

```ts
new Queue('emails', { history: { maxRecordsPerJob: 200 } })
```

`history: true` is the same as leaving it out. `history: false` writes no records.

### deadLetter

| Name | Type | Default | Meaning |
|---|---|---|---|
| `warnAbove` | `number \| false` | `10000` | Dead-letter count above which `health()` warns. `false` never warns. |
| `keep` | `Keep` | kept until redriven or removed | How long dead letters are kept, as an age. |

```ts
new Queue('emails', { deadLetter: { warnAbove: false } })
new Queue('emails', { deadLetter: { keep: { age: '30d' } } })
```

`deadLetter: false` keeps plain failed jobs: no marker, no `deadLettered` event. `job.retry()` still works.

### retention

`RetentionOptions`. Cleanup runs on pods that run a worker.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `completed` | `Keep` | the newest 1000 | How long completed jobs are kept. |
| `failed` | `Keep` | 14 days | How long failed jobs that are not dead letters are kept. |
| `cancelled` | `Keep` | the same as `failed` | How long cancelled jobs are kept. |
| `byName` | `Record<string, RetentionPolicies>` | none | `completed`, `failed` and `cancelled` per job name. |
| `interval` | `Duration` | `'60s'` | How often the cleanup pass runs. |
| `pageSize` | `number` | `500` | Jobs deleted per store call, 1 to 5000. |
| `resultGrace` | `Duration` | `'30s'` | How long a "keep none" job stays readable. `0` deletes it as it finishes. |
| `retainedAge` | `Duration` | `'7d'` | Age kept for jobs added with `uniqueWhile: 'retained'` when no rule gives one. |

```ts
new Queue('emails', { retention: { completed: 100 } })
new Queue('emails', { retention: { failed: { age: '30d' } } })
new Queue('emails', { retention: { cancelled: false } })
new Queue('emails', { retention: { byName: { report: { completed: true } } } })
new Queue('emails', { retention: { interval: '5m' } })
new Queue('emails', { retention: { pageSize: 1000 } })
new Queue('emails', { retention: { resultGrace: 0 } })
new Queue('emails', { retention: { retainedAge: '30d' } })
```

A `Keep` is one of:

| Value | Means |
|---|---|
| `true` | keep forever |
| `false` or `0` | keep none (readable for `resultGrace`) |
| a number `n` | keep the newest `n` |
| `{ count?, age? }` | remove a job when either limit is hit |

The policy is chosen when the job finishes: the job's own `keep`, then `byName[name]`, then the queue's, then the default. Setting `retention.failed` to keep none while dead letters are on is an `InvalidOptionError`.

### scheduler

`SchedulerOptions`. See [Schedules](13-schedules.md).

| Name | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Start the loop with the first worker. `startScheduler()` starts it either way. |
| `tickMs` | `number` | `1000` | Longest sleep between loop turns, in ms. 100 to 2147483647. |
| `batchSize` | `number` | `50` | Due schedules read per turn, 1 to 1000. |

```ts
new Queue('emails', { scheduler: { enabled: false } })
new Queue('emails', { scheduler: { tickMs: 5000 } })
new Queue('emails', { scheduler: { batchSize: 100 } })
```

## Methods

In the examples, `queue` is a `Queue<{ to: string }>` and `id` is a job id.

### Adding

| Method | Returns |
|---|---|
| `add(data, opts?)` | `Promise<AddResult<D, R>>` |
| `addBulk(items, opts?)` | `Promise<BulkOutcome<D, R>[]>` |

```ts
const { job, added, duplicate } = await queue.add({ to: 'ada@example.com' }, { delay: '1m' })
const outcomes = await queue.addBulk([{ data: { to: 'ada@example.com' } }, { data: { to: 'alan@example.com' }, opts: { priority: 5 } }], { atomic: true })
```

- `add` options are listed in [Job options](02-job-options.md).
- `AddResult` is `{ job, added, duplicate? }`. `added` is `false` when the id was taken; `duplicate` is then `{ action, existingState, by }`.
- `addBulk` takes `{ data, opts? }` items. Each `BulkOutcome` is `{ ok: true, job, added, duplicate? }` or `{ ok: false, error }`, in input order.
- `BulkOptions.atomic` (default `false`): with `true`, one refused input refuses the whole call with `BulkAddError` (its `index` names the input) and nothing is stored. Only a write whose outcome is unknown, or a merge into an already stored job that fails after the write, can leave inputs stored; read the ids in `jobIds` back with `getJob` to see which. A store without `transactions` throws `CapabilityError`.

### Running jobs

| Method | Returns |
|---|---|
| `process(handler, opts?)` | `Worker<D, R>` |
| `process(handlers, opts?)` | `Worker` |
| `processBatch(handler, opts)` | `BatchWorker<D, R>` |
| `startScheduler()` | `void` |
| `stopScheduler()` | `Promise<void>` |

```ts
const worker = queue.process(async (job, ctx) => ({ sent: true }), { concurrency: 5 })
const named = queue.process({ welcome: async (job) => true, digest: async (job) => true })
const batcher = queue.processBatch(async (batch, ctx) => batch.jobs.map(() => true), { batchSize: 50 })
queue.startScheduler()
await queue.stopScheduler()
```

- `process(handler)` runs unnamed jobs. `process({ name: handler })` runs named jobs, one handler per name. See [Worker options](04-worker-options.md).
- `processBatch` runs unnamed jobs in batches. See [Batch worker](05-batch-worker.md).
- `startScheduler()` runs the schedule loop on this pod without a worker. `stopScheduler()` stops it once a fire in flight has finished.

### Reading jobs

| Method | Returns |
|---|---|
| `getJob(id)` | `Promise<Job<D, R> \| null>` |
| `getJobs(state, range?)` | `Promise<Job<D, R>[]>` |
| `getCounts()` | `Promise<JobCounts>` |
| `getAttempts(jobId, opts?)` | `Promise<AttemptPage>` |
| `getOldestWaitingAge()` | `Promise<number \| null>` |
| `getStoreTime()` | `Promise<number>` |

```ts
const job = await queue.getJob(id)
const failed = await queue.getJobs('failed', { offset: 0, limit: 50 })
const { waiting, active, blocked } = await queue.getCounts()
const { attempts, truncated, nextCursor } = await queue.getAttempts(id, { limit: 20 })
const ageMs = await queue.getOldestWaitingAge()
const now = await queue.getStoreTime()
```

- `getJob` reads fresh from the store. `null` when the id is unknown. See [Job and context](07-job-and-context.md).
- `getJobs` range: `offset` (default `0`), `limit` 0 to 1000 (default `100`). Waiting jobs come in insertion order, delayed by run time, active by start, finished ones newest first.
- `getCounts` has one key per state plus `blocked`: waiting jobs held back by a pause.
- `getAttempts`: `limit` 1 to 1000 (the in-memory store's default is `100`), `cursor` from the page before. An unknown id gives an empty page.
- `getOldestWaitingAge` is in ms; `null` when nothing is waiting.
- `getStoreTime` is the store's clock in epoch ms. Delays, leases and retries all use it.

### Controlling jobs

| Method | Returns |
|---|---|
| `cancel(id)` | `Promise<JobCancelResult<Job<D, R>>>` |
| `remove(id)` | `Promise<boolean>` |
| `redrive(id, opts?)` | `Promise<RedriveOutcome>` |
| `redrive(ids, opts?)` | `Promise<RedriveOutcome[]>` |
| `redriveAll(filter?, opts?)` | `Promise<RedriveSummary>` |
| `getDeadLetters(opts?)` | `Promise<{ jobs: Job<D, R>[]; nextCursor: string \| null }>` |
| `countDeadLetters(opts?)` | `Promise<number>` |
| `clean(state, olderThan, opts?)` | `Promise<{ removed: number; done: boolean }>` |
| `drain(opts?)` | `Promise<{ removed: number }>` |
| `obliterate(opts?)` | `Promise<{ removed: number }>` |

```ts
const res = await queue.cancel(id)
const removed = await queue.remove(id)
await queue.redrive(id, { delay: '5m', resetAttempts: true })
const outcomes = await queue.redrive([id, 'other-id'])
const summary = await queue.redriveAll({ reason: 'exhausted' }, { limit: 1000, pageSize: 100 })
const { jobs, nextCursor } = await queue.getDeadLetters({ reason: 'exhausted', limit: 100 })
const count = await queue.countDeadLetters({ reason: 'crashLimit' })
await queue.clean('completed', '7d', { limit: 10_000, pageSize: 500 })
await queue.drain({ delayed: true })
await queue.obliterate({ force: true })
```

- `cancel` stops a waiting, delayed or active job. It is `{ cancelled: true, previousState, job }`, or `{ cancelled: false, reason: 'already-terminal', state, job }` for a finished job. An unknown id throws `JobNotFoundError`.
- `remove` deletes a job that is not running. `false` when the id is unknown. An active job throws `InvalidJobStateError`.
- `redrive`, `redriveAll`, `getDeadLetters` and `countDeadLetters` work on failed jobs. `getDeadLetters` `limit` is 1 to 1000 (default `100`); `redriveAll` `pageSize` is 1 to 1000 (default `100`).
- `clean`, `drain` and `obliterate` delete for good. Their `pageSize` is 1 to 5000 (default `500`).
- Details, outcomes and limits: [Admin](14-admin.md).

### Pausing

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
if (queue.isPaused()) console.log('paused')
```

- `pause()` stops claims on every pod until `resume()`. Running jobs finish. `changed` is `false` when nothing changed.
- `pauseState()` reads the flag from the store. `isPaused()` is the flag as this pod last saw it, with no store call.

### Schedules

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
await queue.upsertSchedule('digest', { cron: '0 7 * * *', tz: 'Europe/Berlin', template: { data: { to: 'team@example.com' } } })
const schedule = await queue.getSchedule('digest')
const { schedules } = await queue.listSchedules({ state: 'active', limit: 100 })
await queue.pauseSchedule('digest')
await queue.resumeSchedule('digest')
const deleted = await queue.deleteSchedule('digest')
const next = await queue.nextRuns('digest', 3)
const preview = await queue.previewSchedule({ every: '15m' }, 3)
```

`n` is 1 to 100 (default `5`). `listSchedules` `limit` is 1 to 1000 (default `100`). Details: [Schedules](13-schedules.md).

### Health and workers

| Method | Returns |
|---|---|
| `ready(opts?)` | `Promise<void>` |
| `health(opts?)` | `Promise<HealthReport>` |
| `metrics()` | `Promise<MetricsSnapshot>` |
| `getAlerts()` | `AlertEvent[]` |
| `getWorkers(opts?)` | `Promise<WorkerInfo[]>` |

```ts
await queue.ready({ timeoutMs: 10_000 })
const report = await queue.health({ timeoutMs: 2000 })
const snapshot = await queue.metrics()
const firing = queue.getAlerts()
const workers = await queue.getWorkers({ includeStale: true })
```

- `ready` resolves once the store is open and answers. It rejects with `StoreNotReadyError` after `timeoutMs` (default `'30s'`).
- `health` never rejects. Its store check is bounded by `timeoutMs` (default `2000`).
- `getWorkers` lists live workers of this queue from every pod; `includeStale` (default `false`) adds the ones not heard from.
- Details: [Health and metrics](11-health-and-metrics.md).

### Events

| Method | Returns |
|---|---|
| `on(event, fn)` | `Unsubscribe` |
| `once(event, fn)` | `Unsubscribe` |
| `off(event, fn)` | `void` |

```ts
const stop = queue.on('completed', ({ job, result }) => console.log(job.id, result))
queue.once('drained', () => console.log('empty'))
stop()
```

`Unsubscribe` is `() => void`. Event names and payloads: [Events](06-events.md).

### Closing

| Method | Returns |
|---|---|
| `close(opts?)` | `Promise<void>` |

```ts
await queue.close({ timeoutMs: 10_000 })
```

`close` stops every worker of this queue, then the store connection. `timeoutMs` replaces `shutdownTimeout` for this call. Every call returns the same promise. While it runs, `add`, `process` and `cancel` throw `QueueClosedError`.

### Properties

| Property | Type | Meaning |
|---|---|---|
| `name` | `string` | The queue name. |
| `namespace` | `string` | The namespace. |
| `closed` | `boolean` | `true` once the queue is closed. |
| `connectionState` | `ConnectionState` | `'connected'`, `'reconnecting'` or `'closed'`. |
| `formatVersion` | `number` | The stored record format this release writes (`1` in this release). |

```ts
console.log(queue.name, queue.namespace, queue.closed, queue.connectionState, queue.formatVersion)
```

## Named jobs

Give the queue a `NameMap` as its third type argument, and each job name gets its own data and result types.

```ts
type Names = {
  welcome: { data: { to: string }; result: boolean }
  digest: { data: { day: string } }
}
const mail = new Queue<unknown, unknown, Names>('mail')

await mail.add({ to: 'ada@example.com' }, { name: 'welcome' })
mail.process({ welcome: async (job) => job.data.to.includes('@'), digest: async (job) => console.log(job.data.day) })
```

- `NameMap` is `Record<string, { data: unknown; result?: unknown }>`. `NameData<N, K>` and `NameResult<N, K>` read one name's types.
- `HandlerMap<N>` is the object `process` takes: one optional handler per name.
- A job name is 1 to 128 characters from `A-Z a-z 0-9 . _ : / -`.

## QueueClient

`Queue` and `Producer` both implement `QueueClient`: `add`, `addBulk`, `ready`, `close` and `health`. Type code that only adds jobs against it.

```ts
async function sendWelcome(client: QueueClient<{ to: string }>) {
  await client.add({ to: 'ada@example.com' })
}
```

`QueueBase` is the shared base class of `Queue` and `Producer`. You do not use it directly. For a process that only adds jobs, see [Producer](09-producer.md).
