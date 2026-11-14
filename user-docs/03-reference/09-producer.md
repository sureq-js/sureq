# Producer

A `Producer` is the add side of a queue, for a process that never runs jobs: an API server, a serverless function, a command-line tool. It adds, reads and manages jobs in a shared store. It runs no worker, sweeper, scheduler, heartbeat, alert loop or timer.

```ts
import { Producer } from '@sureq/core/producer'

const emails = new Producer<{ to: string }>('emails', { store, namespace: 'shop' })
await emails.add({ to: 'ada@example.com' })
```

- `new Producer<D, R>(name, opts)`. `D` is the job data type, `R` the result type. The name rules are the same as for a [Queue](01-queue.md).
- Import it from `@sureq/core/producer`. That entry loads none of the worker, sweeper, scheduler, batching or alert code. `Producer` is also exported from `@sureq/core`; both entries share one copy of every class.
- A producer needs a `store` that worker pods also use. Without one it throws `InvalidOptionError`.
- After `ready()` and after every call, nothing is left running, so a frozen and resumed function costs nothing between calls.
- `close()` only marks the producer closed. The store you passed stays open.
- With no `namespace`, it logs one `info` line saying it uses `'default'`.

## Producer options

`ProducerOptions<D>` is the add side of [Queue options](01-queue.md#queue-options), plus a required `store`. Any other queue option, such as `alerts`, `metrics`, `deadLetter`, `signals` or `leaseDuration`, throws `InvalidOptionError`.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `store` | `Store` | required | The store the worker pods use. |
| `namespace` | `string` | `'default'` | Must match the worker pods' namespace. |
| `id` | `(data: D) => string` | none: a UUIDv7 per job | Makes the job id from the data. |
| `onDuplicate` | `DuplicateRule<D>` | `'ignore'` | What `add` does when the id is taken. |
| `uniqueWhile` | `'pending' \| 'retained'` | `'pending'` | How long a job holds its id. |
| `defaultJobOptions` | `JobDefaults` | none | `maxAttempts`, `backoff` and `priority` for every add. |
| `order` | `'fifo' \| 'lifo'` | `'fifo'` | Claim order among jobs of equal priority. |
| `maxPayloadBytes` | `number` | `1048576` (1 MiB) | Largest job data, in UTF-8 bytes of its JSON. |
| `maxBulkSize` | `number` | `1000` | Most inputs in one `addBulk` call. |
| `filter` | `FilterFn<D>` | none | Checks every add before it is stored. |
| `filterTimeoutMs` | `number` | `5000` | Longest the filter may take, in ms. |
| `logger` | `Logger \| false` | console at `warn` | Where log lines go. See [Logging](12-logging.md). |
| `reconnect` | `ReconnectOptions` | see [reconnect](01-queue.md#reconnect) | How the store is probed while it is unreachable. |
| `onDisconnected` | `'reject' \| 'wait'` | `'reject'` | What `add` does while the store is unreachable. |
| `maxWait` | `Duration` | `'10s'` | Longest an `add` waits in `'wait'` mode. |
| `maxBufferedAdds` | `number` | `1000` | Most adds waiting in `'wait'` mode. |

Each option means the same as on a queue; the [Queue options](01-queue.md#queue-options) tables give the details.

```ts
new Producer('emails', { store })
new Producer('emails', { store, namespace: 'shop' })
new Producer<{ to: string }>('emails', { store, id: (data) => `welcome-${data.to}` })
new Producer('emails', { store, onDuplicate: 'replace' })
new Producer('emails', { store, uniqueWhile: 'retained' })
new Producer('emails', { store, defaultJobOptions: { maxAttempts: 5 } })
new Producer('emails', { store, order: 'lifo' })
new Producer('emails', { store, maxPayloadBytes: 64 * 1024 })
new Producer('emails', { store, maxBulkSize: 500 })
new Producer<{ to: string }>('emails', { store, filter: (data) => data.to.includes('@') })
new Producer('emails', { store, filter: async () => true, filterTimeoutMs: 1000 })
new Producer('emails', { store, logger: false })
new Producer('emails', { store, reconnect: { maxDelay: '1m' } })
new Producer('emails', { store, onDisconnected: 'wait' })
new Producer('emails', { store, onDisconnected: 'wait', maxWait: '30s' })
new Producer('emails', { store, onDisconnected: 'wait', maxBufferedAdds: 5000 })
```

A producer has no `storeCallTimeout` option and uses the default `'30s'`. The first queue or producer on a store object sets the call timeout and the `reconnect` policy for that store, so a producer created first fixes them at its values.

## Methods

A producer has the same methods as a queue, minus the ones that run jobs. Each one behaves as on a [Queue](01-queue.md#methods).

| Group | Methods |
|---|---|
| Adding | `add`, `addBulk` |
| Reading | `getJob`, `getJobs`, `getCounts`, `getAttempts`, `getOldestWaitingAge`, `getStoreTime`, `getDeadLetters`, `countDeadLetters`, `getWorkers`, `metrics` |
| Controlling | `cancel`, `remove`, `redrive`, `redriveAll`, `pause`, `resume`, `pauseState`, `isPaused` |
| Admin | `clean`, `drain`, `obliterate` |
| Schedules | `upsertSchedule`, `getSchedule`, `listSchedules`, `pauseSchedule`, `resumeSchedule`, `deleteSchedule`, `nextRuns`, `previewSchedule` |
| Life cycle | `ready`, `health`, `close` |
| Events | `on`, `once`, `off` |

It has no `process`, `processBatch`, `startScheduler`, `stopScheduler` or `getAlerts`. Its properties are `name`, `namespace`, `closed`, `connectionState` and `formatVersion`.

```ts
const { job } = await emails.add({ to: 'ada@example.com' }, { maxAttempts: 5 })
console.log((await emails.getJob(job.id))?.state)
await emails.upsertSchedule('digest', { cron: '0 7 * * *', template: { data: { to: 'team@example.com' } } })
```

## What a producer does not do

- It never fires schedules. A schedule it creates fires where a worker of that queue runs the scheduler, or where `startScheduler()` was called. See [Schedules](13-schedules.md).
- It never sweeps expired leases, trims finished jobs or checks alerts. Those run on worker pods.
- `getWorkers()` never lists it. `health()` shows no workers and no alerts.
- `metrics()` holds `sureq_jobs`, `sureq_oldest_waiting_age_seconds`, and this process's `sureq_jobs_added_total` (and `sureq_jobs_rejected_total` once its filter rejected an add). See [Health and metrics](11-health-and-metrics.md).
- `cancel` of a running job uses the default `cancelled` retention policy and the job's own `keep`, because the producer cannot see the worker pods' options.

## Events

A producer emits only `ProducerEvent`s: `added`, `duplicate`, `rejected`, `error`, `redriven`, `cleaned`, `obliterated`, `storeDisconnected`, `storeReconnected`, `schedulePaused`, `scheduleResumed` and `scheduleDeleted`. Payloads are in [Events](06-events.md).

```ts
emails.on('rejected', ({ reason }) => console.warn('add rejected:', reason))
```

## Types

- `Producer<D, R>` extends `QueueBase<D, R, ProducerEvent>`, the base it shares with `Queue`.
- `Producer` and `Queue` both implement `QueueClient` (`add`, `addBulk`, `ready`, `close`, `health`). Type code that only adds jobs against it. See [QueueClient](01-queue.md#queueclient).
- `@sureq/core/producer` exports the producer, every error class, the store contract types, `serializeError`, `deserializeError`, `describeMetrics` and `errorCatalogue`. It does not export `Queue`, `Worker`, `BatchWorker` and their handler and option types, `MemoryStore`, `consoleLogger`, `pinoLogger`, `isUnrecoverable`, `defineCapabilities` or the contract version constants: import those from `@sureq/core`.
