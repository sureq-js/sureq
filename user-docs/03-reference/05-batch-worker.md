# Batch worker

A batch worker hands your handler several jobs at once. You start one with `queue.processBatch(handler, opts)`. A batch only groups the delivery: each job keeps its own lease, fencing token, attempt count, retry decision and write.

```ts
const worker = queue.processBatch(async (batch, ctx) => batch.jobs.map(() => ({ sent: true })), { batchSize: 50, batchDelay: '200ms' })
```

A batch worker takes unnamed jobs only.

In the examples, `queue` is a `Queue<{ to: string }, { sent: true }>`, `batchHandler` is a `BatchHandler`, and `send(to, opts)` is your own function.

## Batch worker options

`BatchWorkerOptions` has every key of [Worker options](04-worker-options.md), plus these. `concurrency` counts batches: with `concurrency: 2` at most two batches run or form at once.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `batchSize` | `number` | required | Most jobs per handler call, 2 to 1000. |
| `batchDelay` | `Duration` | `0` | Close a partial batch after this long with no claim adding jobs. `0` hands over what one claim returns. |
| `batchMaxWait` | `Duration` | twenty times `batchDelay` | Close a batch this long after its first job was claimed, however steady the trickle. At least `batchDelay`. |
| `onShutdown` | `'flush' \| 'release'` | `'flush'` | At `close()`, run the forming batch now (`'flush'`), or give its jobs back unrun (`'release'`). |

```ts
queue.processBatch(batchHandler, { batchSize: 100 })
queue.processBatch(batchHandler, { batchSize: 100, batchDelay: '500ms' })
queue.processBatch(batchHandler, { batchSize: 100, batchDelay: '500ms', batchMaxWait: '5s' })
queue.processBatch(batchHandler, { batchSize: 100, onShutdown: 'release' })
```

Claimed jobs are `active` while their batch forms, and their leases are renewed. A job held for a batch that never reaches the handler is never charged an attempt or a crash.

## The handler

`BatchHandler<D, R>` is `(batch: Batch<D, R>, ctx: BatchContext<D, R>) => Promise<BatchResults<R> | void>`.

The handler reports one outcome per job, in one of three ways:

1. Return an array with one element per job, in `batch.jobs` order. A value completes that job. A `TaskFailure` fails it. An array of the wrong length is a `BatchResultMismatchError` (`expected`, `got`), and every unsettled job fails with it, retryable.
2. Call `ctx.complete(job, result)` or `ctx.fail(job, err)` as you go. The write goes out at once. An array element for a job settled this way is ignored.
3. Return nothing. Every job not settled yet completes with no result.

A handler that throws fails every unsettled job with that error, each by its own `maxAttempts`, backoff and `retryIf`. Catch per job and return a `TaskFailure` instead.

```ts
queue.processBatch(async (batch) => {
  const results = []
  for (const job of batch.jobs) {
    try {
      results.push(await send(job.data.to, { signal: job.signal }))
    } catch (err) {
      results.push(new TaskFailure(err))
    }
  }
  return results
}, { batchSize: 50 })
```

`BatchResults<R>` is `ReadonlyArray<R | TaskFailure>`.

## Batch

| Member | Type | Meaning |
|---|---|---|
| `id` | `string` | The batch id, also in each job's attempt record. |
| `jobs` | `ReadonlyArray<BatchJob<D, R>>` | The jobs, up to `batchSize`. |

```ts
console.log(batch.id, batch.jobs.length)
```

## BatchJob

`BatchJob<D, R>` is a [`Job<D, R>`](07-job-and-context.md#job) with two more members.

| Member | Type | Meaning |
|---|---|---|
| `signal` | `AbortSignal` | Aborts for this job alone: with `LeaseLostError` when its lease is lost, or `JobCancelledError` when it is cancelled. |
| `cancelled` | `boolean` | `true` once this job was cancelled. |

```ts
if (job.cancelled) continue
```

When a job's signal aborts, its outcome is thrown away and nothing is written for it. Its siblings carry on.

## BatchContext

| Member | Type | Meaning |
|---|---|---|
| `signal` | `AbortSignal` | Aborts for the whole batch: shutdown, the handler timeout (the smallest `timeout` of the batch's jobs), or every job lost or cancelled. |
| `complete(job, result)` | `Promise<void>` | Complete one job now. |
| `fail(job, error, opts?)` | `Promise<void>` | Fail one job now. `{ retry: false }` makes it final. |
| `isSettled(job)` | `boolean` | Whether the job's outcome was given already. |
| `progress(job, n, total?, message?)` | `Promise<void>` | Report one job's progress, as a counter. |
| `progress(job, value)` | `Promise<void>` | Report one job's progress, as an object. |
| `batchProgress(n, total?, message?)` | `Promise<void>` | Report the batch's progress, as a counter, to every job not settled, lost or cancelled. |
| `batchProgress(value)` | `Promise<void>` | Report the batch's progress, as an object. |

```ts
await fetch('https://example.com/bulk', { signal: ctx.signal })
await ctx.complete(job, { sent: true })
await ctx.fail(job, new Error('bounced'), { retry: false })
if (!ctx.isSettled(job)) await ctx.complete(job, { sent: true })
await ctx.progress(job, 3, 10, 'sending')
await ctx.progress(job, { stage: 'render' })
await ctx.batchProgress(25, 50)
await ctx.batchProgress({ stage: 'upload' })
```

- A second `complete` or `fail` for the same job rejects with `AlreadySettledError`; the first outcome stays.
- A batch's progress lands in `job.batchProgress` of each job; its ETA runs from the batch's earliest start.
- Progress rules (counter and object forms, merging, size limit) are the same as for `ctx.progress`. See [Job and context](07-job-and-context.md#progress).

## TaskFailure

`new TaskFailure(error, opts?)` fails one job in a returned array.

| Member | Type | Default | Meaning |
|---|---|---|---|
| `error` | `unknown` | required | The error to store for the job. |
| `retry` | `boolean \| undefined` | `undefined`: the normal decision | `false` makes the failure final. `true` retries while attempts are left, skipping `retryIf`. |

```ts
return [{ sent: true }, new TaskFailure(new Error('bounced'), { retry: false })]
```

## BatchWorker

`processBatch` returns a `BatchWorker<D, R>`. It has every member of [`Worker`](04-worker-options.md#worker), plus `batch`.

| Member | Type | Meaning |
|---|---|---|
| `batch.flush()` | `Promise<number>` | Close the forming batch now. Resolves with how many jobs went to the handler (`0` when none was held), without waiting for the handler. |
| `batch.held` | `number` | Jobs waiting in the forming batch. |

```ts
const handed = await worker.batch.flush()
console.log(worker.batch.held)
```

A paused batch worker claims nothing more, but its held jobs still close by their timers or `flush()`.

## Shutdown

At `close()` with `onShutdown: 'flush'` the forming batch runs now, under `shutdownTimeout`. Past `shutdownTimeout`, jobs the handler has not settled are released and their attempts refunded.
