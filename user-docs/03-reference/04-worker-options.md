# Worker options

A worker claims jobs from a queue and runs your handler on them. You start one with `queue.process(handler, opts)`. This page lists every option of `WorkerOptions` and the `Worker` it returns.

```ts
const worker = queue.process(async (job, ctx) => ({ sent: true }), { concurrency: 5 })
```

`WorkerOptions` has its own keys, plus every key of `PollingOptions`, `LeaseOptions`, `TimeoutOptions` and `ShutdownOptions`. Where a queue option of the same name exists, the worker's value wins, then the queue's, then the default below.

In the examples, `queue` is a `Queue<{ to: string }>` and `handler` is a `JobHandler`.

## Running

| Name | Type | Default | Meaning |
|---|---|---|---|
| `concurrency` | `number` | `1` | Most jobs this worker runs at once. At least 1. |
| `autorun` | `boolean` | `true` | Start claiming at once. With `false`, call `worker.run()`. |
| `workerId` | `string` | a UUIDv7 | This worker's id, shown in events, attempt records and the worker list. Not empty. |
| `acknowledgeVolatileStore` | `boolean` | `false` | Silence the one warning `store is not durable; jobs are lost on restart`. |

```ts
queue.process(handler, { concurrency: 10 })
queue.process(handler, { autorun: false })
queue.process(handler, { workerId: 'mailer-1' })
queue.process(handler, { acknowledgeVolatileStore: true })
```

## Retries

| Name | Type | Default | Meaning |
|---|---|---|---|
| `retryIf` | `(err: Error, job: Job) => boolean \| Promise<boolean>` | none: retry every error | Return `false` to fail the job for good with reason `'not-retryable'`. |
| `backoffStrategies` | `Record<string, BackoffFn>` | none | Custom backoff functions by name. |
| `unwrapCause` | `boolean` | `true` | Also look for an `UnrecoverableError` in the error's `cause` chain. |

```ts
queue.process(handler, { retryIf: (err) => err.name !== 'ValidationError' })
queue.process(handler, { backoffStrategies: { 'retry-after': (attempt, error, job, spec) => spec.delay * attempt } })
queue.process(handler, { unwrapCause: false })
```

The full decision and the backoff maths: [Retry and backoff](03-retry-and-backoff.md).

## Polling

`PollingOptions`. An idle worker waits between claims. The wait starts at `pollMin` and grows by `pollFactor` after each empty claim, up to `pollMax`. A local `add`, a finished job or a store notification wakes the worker at once.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `pollMin` | `Duration` | `100` ms | Shortest wait, and the wait right after a wake-up. At least 1 ms. |
| `pollMax` | `Duration` | `'5s'` | Longest wait while idle. At least `pollMin`. |
| `pollFactor` | `number` | `2` | Growth of the wait after each empty claim. Above 1. |
| `pollJitter` | `number` | `0.2` | Random spread of each wait, 0 to 1. |
| `notify` | `boolean` | `true` | Wake on the store's change notifications, when the store has them. |

```ts
queue.process(handler, { pollMin: 50 })
queue.process(handler, { pollMax: '30s' })
queue.process(handler, { pollFactor: 1.5 })
queue.process(handler, { pollJitter: 0 })
queue.process(handler, { notify: false })
```

## Leases

`LeaseOptions`. A claimed job is held by a lease. While the handler runs, the worker renews the lease every third of its length, so a job may run far longer than its lease.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `leaseDuration` | `Duration` | the queue's, else `'30s'` | Lease length. 1 s to 1 d. |
| `leaseDurationByName` | `Record<string, Duration>` | none | Lease length per job name. Same range. |

```ts
queue.process(handler, { leaseDuration: '2m' })
queue.process({ report: async (job) => job.id }, { leaseDurationByName: { report: '15m' } })
```

For one job name the lease comes from, in order: the worker's `leaseDurationByName`, the queue's `leaseDurationByName`, the worker's `leaseDuration`, the queue's `leaseDuration`, then 30 s.

When the lease is lost, the worker aborts `ctx.signal` with `LeaseLostError` and emits `leaseLost`. The handler's result is thrown away. A handler that keeps the CPU busy for more than about two thirds of the lease stops the renewals; give that job name a longer lease, or `await` inside long loops.

## Time limits

`TimeoutOptions`. Also accepted on the queue and on `add`; for each field the value from `add` wins, then the worker's, then the queue's.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `timeout` | `Duration` | none | Abort `ctx.signal` with `JobTimeoutError` this long after the handler starts. 1 ms to 2147483647 ms. |
| `timeoutGrace` | `Duration` | `'5s'` | How long a timed-out handler may keep running. Then the attempt fails with `abandoned: true` and its late result is ignored. `0` fails at once. |

```ts
queue.process(handler, { timeout: '2m' })
queue.process(handler, { timeout: '2m', timeoutGrace: 0 })
```

## Shutdown

`ShutdownOptions`. Also accepted on the queue, as the default for its workers.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `shutdownTimeout` | `Duration` | `'25s'` | How long `close()` lets running handlers finish normally. |
| `shutdownAbortGrace` | `Duration` | `'2s'` | After that, `ctx.signal` aborts with `ShutdownError`. This is how long `close()` then waits before it releases the jobs. |

```ts
queue.process(handler, { shutdownTimeout: '1m' })
queue.process(handler, { shutdownAbortGrace: '5s' })
```

A released job goes back to `waiting` at once, with its attempt refunded, so another worker can pick it up.

## Upkeep

| Name | Type | Default | Meaning |
|---|---|---|---|
| `sweepInterval` | `Duration` | `'5s'` | How often this pod looks for jobs whose lease expired, ±20 %. 500 ms to 1 d. |
| `sweepBatch` | `number` | `100` | Most expired jobs one sweep recovers, 1 to 1000. Capped to the store's limit, with one warning. |
| `heartbeatInterval` | `Duration` | `'10s'` | How often the worker refreshes its record in the worker list. 1 s to 1 d. |
| `host` | `string` | the machine's host name | The host shown in the worker list and attempt records. Not empty. |
| `labels` | `Record<string, string>` | `{}` | Tags shown in the worker list. At most 10; each key and value 1 to 64 characters. |

```ts
queue.process(handler, { sweepInterval: '30s' })
queue.process(handler, { sweepBatch: 500 })
queue.process(handler, { heartbeatInterval: '30s' })
queue.process(handler, { host: 'mailer-pod-7' })
queue.process(handler, { labels: { region: 'eu', team: 'growth' } })
```

One sweeper runs per queue object: the first worker to run sets its `sweepInterval` and `sweepBatch`.

## Progress

| Name | Type | Default | Meaning |
|---|---|---|---|
| `progressInterval` | `Duration` | `'250ms'` | Least time between two progress writes of one job. Calls in between are merged; the latest wins. |
| `maxProgressBytes` | `number` | `4096` | Most bytes of the object form of `ctx.progress`. A larger one rejects with `PayloadTooLargeError`. |

```ts
queue.process(handler, { progressInterval: '1s' })
queue.process(handler, { maxProgressBytes: 16_384 })
```

## Handlers

`JobHandler<D, R>` is `(job: Job<D, R>, ctx: JobContext) => R | Promise<R>`. It runs once per attempt. What it returns is the job's result; what it throws fails the attempt. See [Job and context](07-job-and-context.md).

```ts
const send: JobHandler<{ to: string }, { sent: true }> = async (job, ctx) => ({ sent: true })
```

For named jobs pass an object of handlers, one per name: `queue.process({ welcome: async (job) => true, digest: async (job) => true })`. To type each name's data and result, see [Named jobs](01-queue.md#named-jobs). Each job name may have one open worker per queue object; a second one throws `DuplicateHandlerError`. Unnamed workers have no such limit.

## Worker

`queue.process` returns a `Worker<D, R>`.

| Member | Type | Meaning |
|---|---|---|
| `id` | `string` | The worker id. |
| `concurrency` | `number` | The `concurrency` it was started with. |
| `inFlight` | `number` | Slots in flight now: running handlers, out of `concurrency`. A batch takes one slot. |
| `state` | `WorkerState` | `'created'`, `'running'`, `'stopping'` or `'stopped'`. |
| `isRunning()` | `boolean` | `state === 'running'`. A paused worker is still running. |
| `run()` | `Promise<void>` | Start the loop, for `autorun: false`. Resolves once started. Calling it again while running does nothing. |
| `pause(opts?)` | `Promise<void>` | Stop taking jobs on this worker only. `{ waitForActive: true }` also waits for the jobs it is running. |
| `resume()` | `void` | Take jobs again. |
| `isPaused(scope?)` | `boolean` | Paused here or, as last seen, on the whole queue. `PauseScope` `'local'` or `'global'` asks for one. |
| `close(opts?)` | `Promise<void>` | Stop this worker. `{ timeoutMs }` replaces `shutdownTimeout` for this call. |
| `on(event, fn)` | `Unsubscribe` | Listen for a worker event. |
| `once(event, fn)` | `Unsubscribe` | Listen once. |
| `off(event, fn)` | `void` | Stop listening. |

```ts
console.log(worker.id, worker.concurrency, worker.inFlight, worker.state, worker.isRunning())
await worker.run()
await worker.pause({ waitForActive: true })
worker.resume()
const pausedHere = worker.isPaused('local')
await worker.close({ timeoutMs: 10_000 })
worker.on('failed', ({ job, reason }) => console.log(job.id, reason))
worker.once('closed', () => console.log('worker stopped'))
worker.off('failed', listener)
```

`close()` stops in order: no new claims; running handlers get `shutdownTimeout`; then `ctx.signal` aborts with `ShutdownError` and they get `shutdownAbortGrace` more; then their jobs are released. It resolves within `shutdownTimeout` plus `shutdownAbortGrace`, plus at most one second. Worker events: [Events](06-events.md#worker-events).
