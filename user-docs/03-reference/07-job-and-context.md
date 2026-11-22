# Job and context

A handler gets two arguments: the `job` it runs and a `ctx` for this attempt.

```ts
queue.process(async (job, ctx) => {
  console.log(job.id, job.data.to, ctx.attempt)
  return { sent: true }
})
```

In the examples, `queue` is a `Queue<{ to: string }>`, `job` is a `Job<{ to: string }>` and `ctx` is a `JobContext`.

## Job

`Job<D, R>` is a read-only snapshot of a job at the time it was read. It does not change later; call `queue.getJob(id)` for fresh state. Times are store times in epoch ms.

### Fields

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | The job id. |
| `name` | `string \| null` | The job name; `null` for an unnamed job. |
| `queue` | `string` | The queue name. |
| `namespace` | `string` | The namespace. |
| `data` | `Jsonify<D>` | The job data, as read back from JSON: a `Date` is its ISO string, a `Map` or `Set` is `{}`. See [Adding jobs](../02-guides/01-adding-jobs.md#common-questions). |
| `state` | `JobState` | `'waiting'`, `'delayed'`, `'active'`, `'completed'`, `'failed'` or `'cancelled'`. |
| `priority` | `number` | Higher runs first. |
| `seq` | `number` | Order of insertion in the store. Negative for `first: true` under `fifo`. |
| `attempt` | `number` | Attempts started; `0` before the first claim, `1` during the first run. |
| `maxAttempts` | `number` | Most attempts. |
| `crashCount` | `number` | Attempts that ended because the lease expired (the worker crashed or got stuck). |
| `createdAt` | `number` | When the job was added. |
| `runAt` | `number` | When the job may run. |
| `startedAt` | `number \| null` | When the latest attempt was claimed. |
| `finishedAt` | `number \| null` | When the job finished. |
| `retainUntil` | `number \| null` | When retention may delete this finished job; `null` when no age applies. |
| `workerId` | `string \| null` | The worker that claimed the latest attempt. Kept after it finishes. |
| `lease` | `JobLease \| null` | Who holds the job and until when, while it is active; `null` otherwise. |
| `token` | `number` | Fencing token of the latest claim; `0` before the first. Grows with every claim. |
| `result` | `Jsonify<R> \| null \| undefined` | The handler's result, as read back from JSON. `undefined` when none was stored, which is not the same as a stored `null`. |
| `error` | `SerializedError \| null` | The last failure. |
| `failedReason` | `SerializedError \| null` | The same value as `error`. |
| `lastError` | `SerializedError \| null` | The error of the last failed attempt before the latest redrive. |
| `deadLetter` | `DeadLetterInfo \| null` | Set when the job failed for good and is kept as a dead letter: `{ at, reason }`. |
| `redriveCount` | `number` | How many times the job was redriven. |
| `progress` | `JobProgress \| null` | The latest progress of the current attempt, with its ETA; `null` until the first report. |
| `batchProgress` | `JobProgress \| null` | The latest progress of the batch this attempt runs in; `null` outside a batch. |
| `idempotencyKey` | `string` | The add's `idempotencyKey`, else `namespace:queue:id:seq`. The same on every attempt; different for a later job that reuses the id. |
| `schedule` | `{ key: string; scheduledFor: number } \| null` | The schedule tick that made this job; `null` for other jobs. |

```ts
console.log(job.id, job.name, job.queue, job.namespace, job.data, job.state, job.priority, job.seq)
console.log(job.attempt, job.maxAttempts, job.crashCount, job.redriveCount, job.token, job.workerId)
console.log(job.createdAt, job.runAt, job.startedAt, job.finishedAt, job.retainUntil)
console.log(job.lease?.expiresAt, job.result, job.error?.message, job.failedReason?.name, job.lastError?.message)
console.log(job.deadLetter?.reason, job.progress, job.batchProgress, job.schedule?.key)
await fetch('https://example.com/send', { method: 'POST', headers: { 'Idempotency-Key': job.idempotencyKey } })
```

SureQ runs a job at least once, never exactly once. Pass `idempotencyKey` to outside APIs so a second run has no second effect.

### Methods

| Method | Returns | Meaning |
|---|---|---|
| `remove()` | `Promise<boolean>` | The same as `queue.remove(job.id)`. |
| `cancel()` | `Promise<JobCancelResult<Job<D, R>>>` | The same as `queue.cancel(job.id)`. This snapshot is not changed. |
| `retry(opts?)` | `Promise<RedriveOutcome>` | Move this failed job, dead letter or not, back to waiting. Throws `InvalidJobStateError` for a job in another state. |
| `getAttempts()` | `Promise<AttemptRecord[]>` | Every attempt record of this job, oldest first, read fresh. |

```ts
await job.remove()
const res = await job.cancel()
await job.retry({ delay: '5m' })
const records = await job.getAttempts()
```

`RedriveOptions` and `RedriveOutcome`: see [Admin](14-admin.md).

### Related types

`JobLease`:

| Field | Type | Meaning |
|---|---|---|
| `owner` | `string` | The worker id holding the lease. |
| `token` | `number` | The fencing token of the claim. |
| `expiresAt` | `number` | When the lease runs out, in store time. |

`DeadLetterInfo` is `{ at: number; reason: DeadLetterReason }`.

`JobCancelResult<J>` is `{ cancelled: true; previousState: 'waiting' | 'delayed' | 'active'; job: J }`, or `{ cancelled: false; reason: 'already-terminal'; state: 'completed' | 'failed' | 'cancelled'; job: J }`.

`JobCounts` (from `queue.getCounts()`) has one number per `JobState` and `blocked`: waiting jobs held back by a pause.

`SerializedError` is how errors are stored:

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | The error name, such as `'TypeError'`. |
| `message` | `string` | The message. |
| `code` | `string \| number`, optional | The error's `code`. |
| `stack` | `string`, optional | The stack, when `storeStacks` is on. |
| `cause` | `SerializedError`, optional | The `cause`. |
| `errors` | `SerializedError[]`, optional | The inner errors of an `AggregateError`. |
| `props` | `Record<string, JsonValue>`, optional | Other own fields of the error. |
| `truncated` | `true`, optional | Set when the error was cut to `maxErrorBytes`. |
| `v` | `1` | The format version. |

### Attempt records

Each attempt leaves one `AttemptRecord`. Read them with `job.getAttempts()` or one page at a time with `queue.getAttempts(id, opts)`, which returns an `AttemptPage`: `{ attempts, truncated, nextCursor }`. `truncated` counts old records dropped by `history.maxRecordsPerJob`.

| Field | Type | Meaning |
|---|---|---|
| `jobId` | `string` | The job. |
| `attempt` | `number` | The attempt number, from 1. A refunded attempt can repeat a number. |
| `cycle` | `number` | The job's redrive count at the claim: `0` for the first run. |
| `token` | `number` | The fencing token. Records are ordered by it. |
| `workerId` | `string` | The worker that ran it. |
| `host` | `string \| null` | The worker's host. |
| `batchId` | `string \| null` | The batch it ran in. |
| `startedAt` | `number` | When it was claimed. |
| `finishedAt` | `number \| null` | When it ended. |
| `durationMs` | `number \| null` | `finishedAt - startedAt`. |
| `waitMs` | `number` | How long the job waited to be claimed. |
| `heldMs` | `number \| null` | How long a batch job was held before its handler started. |
| `outcome` | `AttemptOutcome` | `'running'`, `'completed'`, `'failed'`, `'crashed'`, `'cancelled'` or `'released'`. |
| `error` | `SerializedError \| null` | The error of a failed or crashed attempt. |
| `endedBy` | `'worker' \| 'sweeper' \| 'cancel' \| 'shutdown' \| null` | What closed the record. |

```ts
for (const r of await job.getAttempts()) console.log(r.attempt, r.outcome, r.durationMs, r.error?.message)
```

## JobContext

| Member | Type | Meaning |
|---|---|---|
| `signal` | `AbortSignal` | Aborts when this attempt must stop: lease lost (`LeaseLostError`), timeout (`JobTimeoutError`), cancel (`JobCancelledError`) or shutdown (`ShutdownError`). Pass it on to your I/O. |
| `token` | `number` | This attempt's fencing token, the same as `job.token`. |
| `attempt` | `number` | The same as `job.attempt`; `1` on the first run. |
| `isLastAttempt` | `boolean` | `attempt >= maxAttempts`. |
| `workerId` | `string` | The worker running this attempt. |
| `fail(err, opts?)` | `never` | Fail this attempt now and end the handler. `{ retry: false }` makes it final; `{ retry: true }` retries while attempts are left, skipping `retryIf`. |
| `progress(n, total?, message?)` | `Promise<void>` | Report progress as a counter. |
| `progress(value)` | `Promise<void>` | Report progress as any JSON object. |

```ts
await fetch('https://example.com/send', { signal: ctx.signal })
await db.write({ id: job.id, token: ctx.token })
console.log(ctx.attempt, ctx.workerId)
if (ctx.isLastAttempt) console.warn('last try for', job.id)
ctx.fail(new Error('mailbox full'), { retry: false })
await ctx.progress(3, 10, 'sending')
await ctx.progress({ stage: 'render' })
```

In these lines `db` is your own database client. Honour `ctx.signal`: a handler that ignores it runs on after its job was released, and the job may run again elsewhere.

### Progress

- Counter form: `n` is a finite number `>= 0`; `total`, if given, a finite number `> 0`; `message`, if given, a string, cut to 1000 characters. `n` may pass `total`.
- Object form: any `ProgressObject` (`Record<string, unknown>`) whose JSON is at most `maxProgressBytes` (default 4096). A larger one rejects with `PayloadTooLargeError`.
- A bad call rejects with `InvalidOptionError` and does not fail the job. A call after the handler returned rejects too.
- Calls closer than `progressInterval` (default `'250ms'`) are merged: the first is written at once, the latest of the rest at the end of the interval. `await` resolves once its value, or a later one, was stored.
- A call rejects when the lease is lost or the job is cancelled. `await` it, or add `.catch(() => {})`.

`JobProgress`, as read from `job.progress`, is one of:

| `kind` | Fields |
|---|---|
| `'counter'` | `n`, `total` (or `null`), `message` (or `null`), `percent` (or `null`), `etaMs` (or `null`), `etaAt` (or `null`), `updatedAt` |
| `'object'` | `value`, `updatedAt` |

```ts
if (job.progress?.kind === 'counter') console.log(job.progress.percent, job.progress.etaMs)
```

`percent` is `min(100, 100 × n / total)`. `etaMs` is `elapsed × (total - n) / n`, from the attempt's start, in store time; it is `0` once `n >= total`, and `null` with no `total` or while `n` is `0`. A retry starts again from `null`.
