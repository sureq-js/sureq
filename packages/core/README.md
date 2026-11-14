# SureQ — Sure Queue

Jobs you can be sure of.

SureQ is a TypeScript job queue for Node.js: typed jobs, retries with backoff, priorities, delayed jobs, schedules, batch workers, dead letters, health checks, metrics, producer-only pods and typed errors. An in-memory store is built in; any other store plugs in through the store contract, and durable stores for running many pods on one queue come as separate adapter packages.

```sh
npm install @sureq/core
```

Node 22 or newer. ESM and CommonJS. No runtime dependencies. Bun and Deno support is planned after 1.0; on a runtime without Node's `process`, the package imports but throws `UnsupportedRuntimeError` (`UNSUPPORTED_RUNTIME`) on first use.

## Documentation

Guides, the API reference, store authoring and operations notes are in the [SureQ documentation](https://github.com/sureq-js/sureq/blob/main/user-docs/README.md).

## Getting started

```ts
import { Queue, UnrecoverableError } from '@sureq/core'

type Email = { to: string; subject: string }

// With no `store` option the queue creates its own in-memory store.
const queue = new Queue<Email, { sent: true }>('emails', {
  defaultJobOptions: { maxAttempts: 5 },
})

const worker = queue.process(
  async (job, ctx) => {
    if (!job.data.to.includes('@')) throw new UnrecoverableError('invalid address') // never retried
    // ... send the email; pass ctx.signal to your client
    return { sent: true }
  },
  { concurrency: 5 },
)

worker.on('completed', ({ job, result }) => console.log(job.id, 'sent', result))
worker.on('failed', ({ job, reason }) => console.log(job.id, 'failed:', reason))
worker.on('error', ({ error }) => console.error(error))

const drained = new Promise<void>((resolve) => queue.on('drained', () => resolve()))

await queue.add({ to: 'ada@example.com', subject: 'Welcome' })
await queue.add(
  { to: 'alan@example.com', subject: 'Later' },
  { delay: '1s', backoff: { type: 'exponential', delay: '2s', factor: 3, jitter: 'none', maxDelay: '10m' } },
)
await queue.add({ to: 'not-an-email', subject: 'Oops' })

await drained
console.log(await queue.getCounts())
await queue.close()
```

A failed attempt is retried until `maxAttempts` (default 3) is used up. Throw `UnrecoverableError`, or call `ctx.fail(err, { retry: false })`, to fail a job at once. A worker's `retryIf(err, job)` can decide per error. Several `Queue` objects can share one store: `new Queue('a', { store })` with `store = new MemoryStore()`.

## Guarantees

These hold on the built-in `MemoryStore` and on any store adapter that passes the conformance suite in `@sureq/store-test`.

| Guarantee | What it means |
|---|---|
| **At least once** | An accepted job runs until it completes or fails for good. A job that fails for good is kept as a [dead letter](#dead-letters-and-redrive) unless the queue sets `deadLetter: false`. No job is silently dropped. |
| **Stored before `add` resolves** | `add()` resolves only after the store has saved the job; nothing waits in a buffer inside the pod. How long the job then survives depends on the store (see below). |
| **One owner at a time** | A job has at most one live [lease](#leases-and-long-jobs). A stalled worker may still be running after its lease expires, but only the current lease holder can change the job. |
| **No stale writes** | A worker whose lease has expired cannot complete, fail or renew the job: the store rejects its writes by fencing token (`ctx.token`). |
| **Bounded recovery** | When a worker dies, its jobs can be claimed again after about `leaseDuration` plus `sweepInterval`, as long as some pod runs a worker for the queue. No restart is needed. |
| **One clock** | Leases, delays, retries and schedules run on the store's clock, not each pod's, so clocks that differ between pods do not break them. |

Not promised:

- **Exactly-once effects.** A job can run more than once: after a crash, a lost lease or a release on shutdown. Make side effects safe to repeat with `job.idempotencyKey`, or pass `ctx.token` to your own writes so a stale attempt is rejected.
- **Durability with the built-in store.** `MemoryStore` keeps jobs in the process, so they are lost when it exits. For jobs that must survive a restart or be shared across pods, use a durable store adapter.

## Choosing a retry strategy

A failed attempt waits before it runs again; set the wait per job with `backoff` or for every job in `defaultJobOptions`.
The spec is stored on the job, so a worker with other defaults cannot change it.

| What you write | What happens |
|---|---|
| *(nothing)* | **Default:** exponential from 1 s, doubling each time, with **full jitter** and a **1-hour cap** |
| `backoff: 5000` or `backoff: '5s'` | **Fixed:** wait exactly 5 s before every retry |
| `backoff: { type: 'fixed', delay: '30s' }` | Fixed, written out |
| `backoff: { type: 'exponential', delay: '2s', factor: 3, jitter: 'none', maxDelay: '10m' }` | Exponential with your own base, growth, jitter and cap |
| `backoff: { type: 'my-strategy' }` + `worker` option `backoffStrategies: { 'my-strategy': fn }` | **Custom:** your function decides each wait (e.g. honour a `Retry-After` header) |

See [Retries and failures](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/03-retries-and-failures.md) and [Retry and backoff](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/03-retry-and-backoff.md).

## Stores, readiness and polling

A queue opens its store on first use; `await queue.ready()` waits until it answers, and `storeCallTimeout` bounds every store call.
An idle worker polls the store with a growing wait and wakes at once on a local add or a store notification.
See [Queue: store and identity](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/01-queue.md#store-and-identity) and [polling](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/01-queue.md#polling).

## Leases and long jobs

A claimed job is held by a lease that the worker renews while the handler runs; a job whose worker died is requeued by the sweeper.
Honour `ctx.signal` and do not block the event loop. See [Progress and long jobs](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/08-progress-and-long-jobs.md).

## Batches

`queue.processBatch(handler, { batchSize })` hands the handler several jobs at once; each job keeps its own lease, attempts and outcome.
Catch per task and return a `TaskFailure`. See [Batches](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/06-batches.md).

## Progress and ETA

A handler reports progress with `ctx.progress(n, total?, message?)` or any serializable object, and any pod reads it from `job.progress`.
The counter form adds a percentage and an ETA. See [Progress and long jobs](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/08-progress-and-long-jobs.md).

## Shutdown

`await queue.close()` stops claiming, gives running handlers `shutdownTimeout` to finish, then aborts `ctx.signal` and releases their jobs.
`signals: ['SIGTERM', 'SIGINT']` closes on the first signal. See [Graceful shutdown](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/13-graceful-shutdown.md).

## Pause and resume

`worker.pause()` stops one worker; `queue.pause()` stops every claim on the queue, on every pod, until `resume()`.
Running jobs finish normally. See [Pause, cancel and cleanup](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/10-pause-cancel-and-cleanup.md).

## Cancel

`queue.cancel(id)` cancels a waiting, delayed or running job; a running handler sees `ctx.signal` abort with `JobCancelledError`.
A finished job is left as it is. See [Pause, cancel and cleanup](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/10-pause-cancel-and-cleanup.md).

## Attempt history

Every attempt leaves one `AttemptRecord` (worker, times, outcome, error), read with `job.getAttempts()` or `queue.getAttempts(id)`.
The newest 50 per job are kept by default. See [Attempt records](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/07-job-and-context.md#attempt-records).

## Dead letters and redrive

A job that fails for good is kept as a dead letter until you redrive or remove it.
List them with `getDeadLetters` and send them back with `redrive` or `redriveAll`. See [Dead letters and redrive](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/09-dead-letters-and-redrive.md).

## Clean, drain and obliterate

`clean`, `drain` and `obliterate` delete jobs for good: by state and age, every waiting job, or the whole queue.
See [Pause, cancel and cleanup](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/10-pause-cancel-and-cleanup.md) and [Admin](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/14-admin.md).

## Retention of finished jobs

By default the newest 1000 `completed` jobs are kept, `failed` and `cancelled` jobs for 14 days, and dead letters until redriven or removed.
Change it with the queue option `retention` or a job's own `keep`. See [retention](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/01-queue.md#retention).

## Health checks

`await queue.health()` never rejects and answers `live` (worker loops are alive; never depends on the store) and `ready` (the store answers).
Serve them on two endpoints, 200 when true and 503 when false. On a fresh queue the first `health()` opens the store, within its timeout.

```ts
import { createServer } from 'node:http'
import { Queue } from '@sureq/core'

const queue = new Queue('emails')

createServer(async (req, res) => {
  if (req.url !== '/livez' && req.url !== '/readyz') return void res.writeHead(404).end()
  const report = await queue.health() // never rejects; the store check is bounded (2 s)
  const ok = req.url === '/livez' ? report.live : report.ready
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(report))
}).listen(8080)
```

See [Health and metrics](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/11-health-and-metrics.md) and the [health reference](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/11-health-and-metrics.md).

## Metrics and alerts

`queue.metrics()` returns job counts, wait and processing times and throughput; `alerts` fire an `alert` event on queue depth, age or failure rate.
Cluster metrics come from the store; pod metrics count this pod only, so scrape every pod.

```ts
const queue = new Queue('emails', {
  alerts: {
    interval: '15s',
    depth: { above: 1000, resolveBelow: 800 },  // waiting jobs
    age: { aboveMs: 60_000 },                   // oldest waiting job, ms
    failureRate: { above: 0.2, minJobs: 20 },   // over this pod's metrics window
  },
})
queue.on('alert', (e) => console.warn(`${e.queue} ${e.type} ${e.status}: ${e.value} (threshold ${e.threshold})`))

const snapshot = await queue.metrics()  // { at, scope, samples }
const ageMs = await queue.getOldestWaitingAge()  // null when nothing is waiting
```

See [Health and metrics](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/11-health-and-metrics.md) and the [metrics reference](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/11-health-and-metrics.md#metrics).

## Mixed-version pods

Pods of adjacent minor releases can share one store during a rolling deploy; a store this release cannot read is refused with `StoreFormatError`.
See [Upgrade notes](https://github.com/sureq-js/sureq/blob/main/user-docs/05-operations/01-upgrade-notes.md).

A queue with a running worker emits the advisory `versionSkew` event while workers of a non-adjacent release are live. **Upgrading from 0.3:** 0.3 and 1.0 share a store format, so they can share a store during the rollout, but expect `versionSkew` until every pod runs 1.0.

## Live workers

Every running worker keeps a heartbeat record in the store; `await queue.getWorkers()` lists them from every pod.
The registry is informational only. See [Live workers](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/11-health-and-metrics.md#live-workers).

## Producer-only processes

A process that only adds jobs can import `Producer` from `@sureq/core/producer`: no worker, sweeper or scheduler code, and no timers.
Workers, sweeping and schedule firing run in other pods on the same store.

```ts
// api.ts: adds and reads only; no worker, sweeper, scheduler or timer in this process
import { Producer } from '@sureq/core/producer'

const emails = new Producer<{ to: string }>('emails', { store, namespace: 'shop' })
const { job } = await emails.add({ to: 'a@example.com' }, { maxAttempts: 5 })
console.log((await emails.getJob(job.id))?.state)
await emails.upsertSchedule('digest', { cron: '0 7 * * *', template: { data: { to: 'team@example.com' } } })

// worker.ts: a separate pod on the same store runs the jobs and fires the schedule
const worker = new Queue<{ to: string }>('emails', { store, namespace: 'shop' })
worker.process(async (job) => console.log('send to', job.data.to))
```

See [Producer-only pods](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/12-producer-only-pods.md) and the [Producer reference](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/09-producer.md).

## Unique ids and duplicates

Give a job your own `id` and a second add with that id does not create a second job; `onDuplicate` decides whether to ignore, replace, reject or merge.
Every job has a `job.idempotencyKey` to pass to external APIs. See [Duplicates and unique ids](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/07-duplicates-and-unique-ids.md).

## Filtering adds

A queue `filter` judges every job before it is stored; a rejected add throws `JobRejectedError` and stores nothing.
A filter that throws fails closed with `FilterError`. See [Queue: adding jobs](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/01-queue.md#adding-jobs).

## Schedule timing: cron and every

A schedule fires on a five-field `cron` rule in an IANA time zone, or on a fixed `every` period.
`previewSchedule` shows the next fire times without storing anything.

```ts
await queue.previewSchedule({ cron: '30 2 * * 1-5', tz: 'Europe/Berlin' });  // next 5 fire times, epoch ms
await queue.previewSchedule({ every: '15m' }, 3);                            // 3 ticks of a grid anchored at store now
```

See the [schedules reference](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/13-schedules.md#scheduletiming), with the cron syntax and daylight saving rules.

## Schedules

A schedule is a durable record that turns each tick of its timing into one job, however many pods run a scheduler.
`upsertSchedule` is safe to call from every pod on start-up.

```ts
await queue.upsertSchedule('nightly-report', {
  cron: '0 2 * * *', tz: 'Europe/Berlin', version: 3,
  template: { name: 'report', data: { day: 'yesterday' }, opts: { maxAttempts: 5 } },
  overlap: 'queue', maxQueued: 3,
});
queue.on('scheduleFired', ({ key, scheduledFor, jobId }) => console.log(key, scheduledFor, jobId));
queue.process(async (job) => {
  if (job.schedule) console.log(`tick ${job.schedule.scheduledFor} of ${job.schedule.key}`);
});
```

See [Schedules](https://github.com/sureq-js/sureq/blob/main/user-docs/02-guides/05-schedules.md) and the [schedules reference](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/13-schedules.md).

## Versioning and deprecation

- **Semver from 1.0.** The public API (the exports of `@sureq/core`, `@sureq/core/producer` and
  `@sureq/store-test`, and the format of stored jobs) changes incompatibly only in a major release.
- **The store contract is experimental.** The interface a store adapter implements may change in a minor release
  until it is declared stable; every such change is listed in the CHANGELOG.
- **Deprecation before removal.** A deprecated API keeps working for at least one minor release before it is removed
  in a major release, and the deprecation is listed in the CHANGELOG.

## Known limits

SureQ runs a job at least once, never exactly once, and the built-in store is in memory, so its jobs are lost when the process exits.
See [Known limits](https://github.com/sureq-js/sureq/blob/main/user-docs/05-operations/04-known-limits.md) for the full list.

## License

MIT

The full documentation lives in the `user-docs` folder of the SureQ repository.
