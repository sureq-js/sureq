# Options

The options that matter for correct use of SureQ 1.0.0, one table per object.
A `Duration` is whole milliseconds or a string with a unit: `'250ms'`, `'30s'`, `'5m'`, `'2h'`, `'1d'`.
A bad option throws `InvalidOptionError` at once, listing every problem.

Not listed here: `reconnect`, `maxBulkSize`, `order`, `filterTimeoutMs`, `maxResultBytes`, `maxErrorBytes`, `storeStacks`, the polling and upkeep tuning, `metrics`, `alerts`, the `retention` and `scheduler` settings, and progress limits.
For those, and the full detail of every row, see the [reference pages](https://github.com/sureq-js/sureq/blob/main/user-docs/03-reference/01-queue.md).

## Queue

`new Queue<D, R>(name, opts?)`. Options marked "worker default" apply to this queue's workers unless `process` sets its own.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `store` | `Store` | a private in-memory store | Where jobs live. Pass a durable store in production, and one store object to share it between queues. |
| `namespace` | `string` | `'default'` | Keeps apps or environments apart in one store. Use one per environment. |
| `storeCallTimeout` | `Duration` | `'30s'` | Longest one store call may take. A late call fails with a retryable `StoreUnavailableError`. |
| `onDisconnected` | `'reject' \| 'wait'` | `'reject'` | What `add` does while the store is unreachable: fail at once, or wait in a buffer. |
| `defaultJobOptions` | `JobDefaults` | none | `maxAttempts`, `backoff` and `priority` for every add. |
| `id` | `(data: D) => string` | none: a UUIDv7 per job | Makes the job id from the data. Must be synchronous. |
| `onDuplicate` | `DuplicateRule<D>` | `'ignore'` | What `add` does when the id is taken: `'ignore'`, `'replace'`, `'reject'` or a merge function. |
| `uniqueWhile` | `'pending' \| 'retained'` | `'pending'` | How long a job holds its id. |
| `filter` | `FilterFn<D>` | none | Checks every add before it is stored. A rejection throws `JobRejectedError`. |
| `maxPayloadBytes` | `number` | `1048576` (1 MiB) | Largest job data, in UTF-8 bytes of its JSON. A larger add throws `PayloadTooLargeError`. |
| `leaseDuration` | `Duration` | `'30s'` | Worker default. How long a claimed job is held before another worker may take it. 1 s to 1 d. |
| `leaseDurationByName` | `Record<string, Duration>` | none | Worker default. Lease length per job name. |
| `maxCrashes` | `number` | `3` | Lease expiries (a crashed or stuck worker) before the job fails with `PoisonPillError`. |
| `timeout` | `Duration` | none | Worker default. Abort `ctx.signal` with `JobTimeoutError` this long after the handler starts. |
| `timeoutGrace` | `Duration` | `'5s'` | Worker default. How long a timed-out handler may keep running before the attempt fails anyway. |
| `shutdownTimeout` | `Duration` | `'25s'` | Worker default. How long `close()` lets running handlers finish. |
| `shutdownAbortGrace` | `Duration` | `'2s'` | Worker default. How long `close()` waits after aborting handlers, before it releases their jobs. |
| `signals` | `ProcessSignal[]` | `[]` | Process signals that close the queue, such as `['SIGTERM', 'SIGINT']`. |
| `logger` | `Logger \| false` | console at `warn` | Where log lines go. `false` turns logging off. |
| `history` | `boolean \| { maxRecordsPerJob?: number }` | on, 50 records per job | One record per attempt. `false` writes none. |
| `deadLetter` | `boolean \| { warnAbove?: number \| false; keep?: Keep }` | on | Keep jobs that failed for good as dead letters, to inspect and redrive. |

## Worker (process)

`queue.process(handler, opts?)`. Where the queue has an option of the same name, the worker's value wins, then the queue's, then the default.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `concurrency` | `number` | `1` | Most jobs this worker runs at once. At least 1. |
| `autorun` | `boolean` | `true` | Start claiming at once. With `false`, call `worker.run()`. |
| `acknowledgeVolatileStore` | `boolean` | `false` | Silence the warning that the store is not durable. Use it in tests only. |
| `retryIf` | `(err: Error, job: Job) => boolean \| Promise<boolean>` | none: retry every error | Return `false` to fail the job for good with reason `'not-retryable'`. |
| `unwrapCause` | `boolean` | `true` | Also look for an `UnrecoverableError` in the error's `cause` chain. |
| `leaseDuration` | `Duration` | the queue's, else `'30s'` | Lease length. 1 s to 1 d. The worker renews it every third of its length. |
| `leaseDurationByName` | `Record<string, Duration>` | none | Lease length per job name. |
| `timeout` | `Duration` | none | Abort `ctx.signal` with `JobTimeoutError` this long after the handler starts. |
| `timeoutGrace` | `Duration` | `'5s'` | How long a timed-out handler may keep running. `0` fails at once. |
| `shutdownTimeout` | `Duration` | `'25s'` | How long `close()` lets running handlers finish normally. |
| `shutdownAbortGrace` | `Duration` | `'2s'` | After that, `ctx.signal` aborts with `ShutdownError`, and `close()` waits this long before it releases the jobs. |

## Batch worker (processBatch)

`queue.processBatch(handler, opts)`. It takes every worker option above, plus these. `concurrency` counts batches. A batch worker runs unnamed jobs only.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `batchSize` | `number` | required | Most jobs per handler call, 2 to 1000. |
| `batchDelay` | `Duration` | `0` | Close a partial batch after this long with no claim adding jobs. `0` hands over what one claim returns. |
| `batchMaxWait` | `Duration` | twenty times `batchDelay` | Close a batch this long after its first job was claimed. At least `batchDelay`. |
| `onShutdown` | `'flush' \| 'release'` | `'flush'` | At `close()`, run the forming batch now, or give its jobs back unrun. |

## Job (add)

`queue.add(data, opts?)`, or `opts` of an `addBulk` item. An option set to `undefined` counts as not given.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string \| ((data: D) => string)` | the queue's `id` function, else a UUIDv7 | The job id. A fixed id makes the add idempotent. |
| `name` | `string` | none (`null`) | The job name. Picks the handler in `process({ name: handler })`. |
| `idempotencyKey` | `string` | `namespace:queue:id:seq` | Pass it to outside APIs so a repeated run has no second effect. |
| `onDuplicate` | `DuplicateRule<D>` | the queue's `onDuplicate` (`'ignore'`) | What to do when the id is taken. |
| `uniqueWhile` | `'pending' \| 'retained'` | the queue's `uniqueWhile` (`'pending'`) | How long the job holds its id. |
| `singletonKey` | `string \| null` | none | At most one waiting or delayed job per key. |
| `delay` | `Duration` | `0` | Wait this long before the job can run. Set `delay` or `runAt`, not both. |
| `runAt` | `Date \| number` | none | Run at this time. A past time runs now. |
| `priority` | `number` | `0` | Higher runs first. A whole number. |
| `first` | `boolean` | `false` | Put the job at the front of its priority level. |
| `maxAttempts` | `number` | `3` | Most attempts, the first one included. At least 1. |
| `backoff` | `BackoffSpec` | exponential from 1 s, factor 2, full jitter, 1 h cap | The wait before each retry. |
| `timeout` | `Duration` | the worker's, else the queue's, else none | Abort `ctx.signal` with `JobTimeoutError` this long after the handler starts. |
| `timeoutGrace` | `Duration` | the worker's, else the queue's, else `'5s'` | How long a timed-out handler may keep running before the attempt fails anyway. |
| `keep` | `{ completed?: JobKeep; failed?: JobKeep; cancelled?: JobKeep }` | the queue's `retention` | How long this job is kept once finished, per outcome. A bare number other than `0` is refused: write `{ completed: '1000ms' }` or `{ completed: { age: 1000 } }`. |

## Producer

`new Producer<D, R>(name, opts)` from `@sureq/core/producer`, for a process that adds jobs and runs none. Any worker-side queue option throws `InvalidOptionError`.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `store` | `Store` | required | The store the worker pods use. |
| `namespace` | `string` | `'default'` | Must match the worker pods' namespace. |
| `id` | `(data: D) => string` | none: a UUIDv7 per job | Makes the job id from the data. |
| `onDuplicate` | `DuplicateRule<D>` | `'ignore'` | What `add` does when the id is taken. |
| `uniqueWhile` | `'pending' \| 'retained'` | `'pending'` | How long a job holds its id. |
| `defaultJobOptions` | `JobDefaults` | none | `maxAttempts`, `backoff` and `priority` for every add. |
| `maxPayloadBytes` | `number` | `1048576` (1 MiB) | Largest job data, in UTF-8 bytes of its JSON. |
| `filter` | `FilterFn<D>` | none | Checks every add before it is stored. |
| `logger` | `Logger \| false` | console at `warn` | Where log lines go. |
| `onDisconnected` | `'reject' \| 'wait'` | `'reject'` | What `add` does while the store is unreachable. |
| `maxWait` | `Duration` | `'10s'` | Longest an `add` waits in `'wait'` mode. |
| `maxBufferedAdds` | `number` | `1000` | Most adds waiting in `'wait'` mode. |
