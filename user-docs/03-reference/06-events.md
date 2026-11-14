# Events

Queues, workers and producers emit events. Listen with `on`, `once` and `off`.

```ts
const stop = queue.on('failed', ({ job, reason, error }) => console.log(job.id, reason, error.message))
worker.once('closed', () => console.log('worker stopped'))
stop()
```

- `on` and `once` return an `Unsubscribe`: `() => void`.
- Listeners run in the order they were added. A listener may be `async`.
- A listener that throws or rejects never breaks SureQ. Its failure is reported as an `error` event with `source: 'listener'`. A failing `error` listener is only logged.
- An `error` event with no listener is logged. Always listen for `error`.
- `J` below is the job snapshot, a [`Job<D, R>`](07-job-and-context.md#job), and `R` is the result type.

## Who emits what

| Event | Queue | Worker | Producer |
|---|---|---|---|
| `added` | yes | | yes |
| `duplicate` | yes | | yes |
| `rejected` | yes | | yes |
| `active` | yes | yes | |
| `progress` | yes | yes | |
| `completed` | yes | yes | |
| `retrying` | yes | yes | |
| `failed` | yes | yes | |
| `deadLettered` | yes | yes | |
| `leaseLost` | yes | yes | |
| `stalled` | yes | | |
| `drained` | yes | yes | |
| `cancelled` | yes | | |
| `redriven` | yes | | yes |
| `cleaned` | yes | | yes |
| `obliterated` | yes | | yes |
| `paused` | yes | yes | |
| `resumed` | yes | yes | |
| `closing` | yes | yes | |
| `closed` | yes | yes | |
| `error` | yes | yes | yes |
| `storeDisconnected` | yes | | yes |
| `storeReconnected` | yes | | yes |
| `degraded` | yes | | |
| `versionSkew` | yes | | |
| `alert` | yes | | |
| `scheduleFired` | yes | | |
| `scheduleSkipped` | yes | | |
| `scheduleQueued` | yes | | |
| `schedulePaused` | yes | | yes |
| `scheduleResumed` | yes | | yes |
| `scheduleDeleted` | yes | | yes |

A queue passes on these events of its workers: `active`, `progress`, `completed`, `retrying`, `failed`, `deadLettered`, `leaseLost`, `drained` and `error`. So `queue.on('completed', ...)` hears every worker of that queue object. `paused`, `resumed`, `closing` and `closed` are emitted by the queue and the worker each for their own change.

The event name types are `keyof QueueEvents` for a queue, `keyof WorkerEvents` for a worker and `ProducerEvent` for a producer.

## Adding

| Event | Payload | When |
|---|---|---|
| `added` | `{ job: J; origin? }` | A new job was stored. |
| `duplicate` | `{ id: string; action: 'ignored' \| 'replaced' \| 'merged' \| 'rejected'; existingState: JobState; by: 'id' \| 'singletonKey'; origin? }` | An add met a job holding its id or singleton key. `id` is that job's id. |
| `rejected` | `{ id: string \| null; reason: string; reasonCode?: string; operation: 'add' \| 'replace' \| 'merge' \| 'schedule'; origin? }` | The queue `filter` refused an add. Nothing was stored. `id` is `null` when SureQ would have made the id. |

```ts
queue.on('added', ({ job }) => console.log('added', job.id))
queue.on('duplicate', ({ id, action, by }) => console.log(id, action, by))
queue.on('rejected', ({ reason, reasonCode }) => console.log(reason, reasonCode))
```

## Running

| Event | Payload | When |
|---|---|---|
| `active` | `{ job: J; workerId: string; origin? }` | A handler started on the job. In a batch, once per job when the handler starts. |
| `progress` | `{ job: J; progress: JobProgress; origin? }` | A `ctx.progress` value was stored. At most once per `progressInterval` per job. |
| `completed` | `{ job: J; result: R; durationMs: number; removed?: boolean; origin? }` | The job completed. `removed: true` when retention deleted it at once (`resultGrace: 0`). |
| `retrying` | `{ job: J; error: SerializedError; delayMs: number; runAt: number; origin? }` | The attempt failed and the job will run again at `runAt` (store time). |
| `failed` | `{ job: J; error: SerializedError; reason: FailureReason; removed?: boolean; origin? }` | The job failed for good. `reason` is `'attempts-exhausted'`, `'unrecoverable'` or `'not-retryable'`. |
| `deadLettered` | `{ job: J; reason: DeadLetterReason; origin? }` | The failed job was kept as a dead letter. Right after its `failed` event. |
| `leaseLost` | `{ job: J; token: number; reason: 'expired' \| 'superseded' \| 'not-active'; origin? }` | The worker lost the job's lease. Its outcome is thrown away; it is not reported as `failed`. |
| `stalled` | `{ job: J; previousWorkerId: string; crashCount: number; action: 'requeued' \| 'failed'; origin? }` | The sweeper found an expired lease and put the job back, or failed it when no attempts or crashes were left. |
| `drained` | `{ queue: string; origin? }` | No job is left waiting, delayed or running. |

```ts
queue.on('active', ({ job, workerId }) => console.log(job.id, 'on', workerId))
queue.on('progress', ({ job, progress }) => console.log(job.id, progress))
queue.on('completed', ({ job, result, durationMs }) => console.log(job.id, result, durationMs))
queue.on('retrying', ({ job, delayMs }) => console.log(job.id, 'retry in', delayMs))
queue.on('failed', ({ job, reason }) => console.log(job.id, reason))
queue.on('deadLettered', ({ job, reason }) => console.log(job.id, reason))
queue.on('leaseLost', ({ job, reason }) => console.log(job.id, reason))
queue.on('stalled', ({ job, action, crashCount }) => console.log(job.id, action, crashCount))
queue.on('drained', ({ queue: name }) => console.log(name, 'is empty'))
```

`DeadLetterReason` is `'exhausted' | 'unrecoverable' | 'retryRejected' | 'crashLimit' | 'legacy'`. See [Admin](14-admin.md).

A `retrying`, `completed` or `failed` event can go missing when the store wrote the outcome but its answer was lost and the job moved on before the worker could confirm it. The stored job is still correct.

## Managing jobs

| Event | Payload | When |
|---|---|---|
| `cancelled` | `{ job: J; previousState: 'waiting' \| 'delayed' \| 'active'; origin? }` | This queue object's `cancel` cancelled the job. |
| `redriven` | `{ id: string; state: 'waiting' \| 'delayed'; viaDeadLetter: boolean; origin? }` | This object moved a failed job back. `viaDeadLetter` is `false` for a plain failed job. |
| `cleaned` | `{ state: CleanableState; removed: number; origin? }` | This object's `clean` removed jobs. Once per call that removed any. |
| `obliterated` | `{ removed: number; origin? }` | This object's `obliterate` finished. |

```ts
queue.on('cancelled', ({ job, previousState }) => console.log(job.id, previousState))
queue.on('redriven', ({ id, state }) => console.log(id, state))
queue.on('cleaned', ({ state, removed }) => console.log(state, removed))
queue.on('obliterated', ({ removed }) => console.log(removed))
```

`CleanableState` is `'completed' | 'failed' | 'cancelled' | 'waiting' | 'delayed'`.

## Pause and close

| Event | Payload | When |
|---|---|---|
| `paused` | `PauseEvent` | The queue (scope `'global'`) or the worker (scope `'local'`) was paused. Once per change. |
| `resumed` | `PauseEvent` | The same, for a resume. |
| `closing` | `{ queue: string; workerId?: string }` | `close()` began. A worker's payload has its `workerId`. |
| `closed` | `{ queue: string; workerId?: string }` | `close()` finished. |

```ts
queue.on('paused', ({ scope, source }) => console.log('paused', scope, source))
queue.on('resumed', ({ scope }) => console.log('resumed', scope))
worker.on('closing', ({ workerId }) => console.log(workerId, 'closing'))
worker.on('closed', ({ workerId }) => console.log(workerId, 'closed'))
```

`PauseEvent`:

| Field | Type | Meaning |
|---|---|---|
| `scope` | `PauseScope` | `'local'`: this worker only. `'global'`: the whole queue. |
| `queue` | `string` | The queue name. |
| `workerId` | `string`, optional | Set on a worker's events. |
| `source` | `'self' \| 'observed'` | `'self'` for this pod's own call; `'observed'` when it learned the change from the store. |
| `at` | `number` | Wall-clock ms when emitted. |

A global change also fires on each worker of the queue object. Other pods see it from their claims, up to one `pollMax` later.

## Store and pods

| Event | Payload | When |
|---|---|---|
| `error` | `ErrorEvent` | A problem that is not a job failure, such as a store error or a failing listener. |
| `storeDisconnected` | `{ error: Error }` | The store became unreachable. Once per outage, on every queue sharing the store object. |
| `storeReconnected` | `{ downForMs: number; attempts: number }` | A probe reached the store again. |
| `degraded` | `{ error: StoreFormatError }` | The store moved to a format this pod cannot read. The pod stops claiming and sweeping and lets its active jobs finish. |
| `versionSkew` | `{ workers: { workerId: string; sureqVersion: string }[] }` | Live workers run a release that is not next to this pod's. A warning only. |
| `alert` | `AlertEvent` | One of this pod's alert rules started firing or resolved. See [Health and metrics](11-health-and-metrics.md). |

```ts
queue.on('error', ({ error, source, context }) => console.error(source, context.operation, error.code))
queue.on('storeDisconnected', ({ error }) => console.warn('store down', error.message))
queue.on('storeReconnected', ({ downForMs, attempts }) => console.info('store back', downForMs, attempts))
queue.on('degraded', ({ error }) => console.warn(error.code))
queue.on('versionSkew', ({ workers }) => console.warn(workers))
queue.on('alert', ({ type, status, value, threshold }) => console.warn(type, status, value, threshold))
```

`ErrorEvent`:

| Field | Type | Meaning |
|---|---|---|
| `error` | `SureQError` | The error. Its `code` names it. See [Errors](08-errors.md). |
| `source` | `ErrorSource` | `'store'`, `'listener'`, `'internal'` or `'strategy'` (a backoff strategy). |
| `context` | `{ operation?: string; jobId?: string; workerId?: string; queue: string; event?: string }` | Where it happened. `event` is set for a failing listener. |
| `origin` | `EventOrigin`, optional | See below. |

## Schedules

| Event | Payload | When |
|---|---|---|
| `scheduleFired` | `{ key: string; scheduledFor: number; jobId: string }` | This pod's scheduler made the job for a tick. |
| `scheduleSkipped` | `{ key: string; scheduledFor: number; reason: 'overlap' \| 'backlog-full' }` | This pod's scheduler dropped a tick. |
| `scheduleQueued` | `{ key: string; scheduledFor: number }` | This pod's scheduler put a tick in the backlog (overlap `'queue'`). |
| `schedulePaused` | `{ key: string }` | This object paused a schedule. |
| `scheduleResumed` | `{ key: string }` | This object resumed a schedule. |
| `scheduleDeleted` | `{ key: string }` | This object deleted a schedule. |

```ts
queue.on('scheduleFired', ({ key, scheduledFor, jobId }) => console.log(key, scheduledFor, jobId))
queue.on('scheduleSkipped', ({ key, reason }) => console.log(key, reason))
queue.on('scheduleQueued', ({ key, scheduledFor }) => console.log(key, scheduledFor))
queue.on('schedulePaused', ({ key }) => console.log(key, 'paused'))
queue.on('scheduleResumed', ({ key }) => console.log(key, 'resumed'))
queue.on('scheduleDeleted', ({ key }) => console.log(key, 'deleted'))
```

See [Schedules](13-schedules.md).

## Worker events

`WorkerEvents` is every queue event except `added`, `duplicate`, `rejected`, `cancelled`, `stalled`, `redriven`, `cleaned`, `obliterated`, `storeDisconnected`, `storeReconnected`, `degraded`, `versionSkew`, `alert` and the schedule events. A worker listener has the type `Listener<D, R, K>`.

```ts
const onFailed: Listener<{ to: string }, unknown, 'failed'> = ({ job, reason }) => console.log(job.data.to, reason)
worker.on('failed', onFailed)
```

## Producer events

`ProducerEvent` is `'added' | 'duplicate' | 'rejected' | 'error' | 'redriven' | 'cleaned' | 'obliterated' | 'storeDisconnected' | 'storeReconnected' | 'schedulePaused' | 'scheduleResumed' | 'scheduleDeleted'`. See [Producer](09-producer.md).

```ts
producer.on('added', ({ job }) => console.log('added', job.id))
```

## EventOrigin

`EventOrigin` is `{ podId: string; workerId?: string }`: the pod, and worker, an event came from. Every payload that has `origin?` may carry it. This release emits only events from its own pod and leaves `origin` unset.
