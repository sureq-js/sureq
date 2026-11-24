# Errors

Every error SureQ itself raises is a `SureQError` with a stable `code`. Check the `code`, or use `instanceof`, to decide what to do.

```ts
import { isSureQError, JobNotFoundError } from '@sureq/core'

try {
  await queue.cancel(id)
} catch (e) {
  if (e instanceof JobNotFoundError) console.log('no such job', e.jobId)
  else if (isSureQError(e)) console.log(e.code, e.message)
  else throw e
}
```

- Both `@sureq/core` and `@sureq/core/producer` export every error class, and both share one copy of each, so `instanceof` works across them.
- `isSureQError(e)` is `true` for any SureQ error, even one made by a second copy of the package. Use it when `instanceof` may fail.
- `isStoreError(e)` is `true` for `StoreError` and its subclasses, by code. `isUnrecoverable(e)` is described in [Retry and backoff](03-retry-and-backoff.md).

## SureQError

The base class of every SureQ error.

| Member | Type | Meaning |
|---|---|---|
| `code` | `string` | The stable code from the catalogue below. |
| `message` | `string` | A readable message. Do not parse it. |
| `details` | `Record<string, unknown>` | The error's own fields, as plain data. `{}` when it has none. |
| `cause` | `unknown` | The error that caused this one, when there is one. |
| `toJSON()` | `SureQErrorJSON` | `{ name, code, message, details? }`. `details` is left out when empty. |

```ts
console.log(JSON.stringify(new JobNotFoundError({ jobId: 'a' })))
// {"name":"JobNotFoundError","code":"JOB_NOT_FOUND","message":"Job \"a\" was not found","details":{"jobId":"a"}}
```

## Catalogue

`errorCatalogue` maps each code to its class. It has 42 entries.

```ts
import { errorCatalogue } from '@sureq/core'

const ErrorClass = errorCatalogue['JOB_NOT_FOUND'] // JobNotFoundError
```

`SureQErrorClass` is the type of each value: a class whose instances are `SureQError`s.

### Options, input and closed objects

| Class | Code | When thrown | What to do |
|---|---|---|---|
| `SureQError` | `SUREQ_ERROR` | Never on its own. It is the base class of every error below. | Check `code` or a subclass instead. |
| `InvalidOptionError` | `INVALID_OPTION` | A bad option, argument or configuration, anywhere. One error lists every problem in `issues`. | Fix the listed options. Retrying the same call cannot help. |
| `SerializationError` | `SERIALIZATION_FAILED` | Job data, a result, progress or a schedule template is not JSON: a circular reference, a `bigint`, or a top-level value with no JSON form, such as a function. A handler result of `undefined` is fine: nothing is stored. | Pass plain JSON values. |
| `DeserializationError` | `DESERIALIZATION_FAILED` | A job's stored data, result or error is not valid JSON, for example after a store adapter bug or a hand edit in the database. Reading the job (`getJob`, `getJobs` and the like) throws it. A worker that claims such a job fails it for good with this error, without running the handler and without retries, so it becomes a dead letter with reason `unrecoverable`; a batch worker leaves it out of the batch. The failed job shows `data: null`. `details` has `jobId` and `field` (`'data'` or `'result'`). The message never quotes the stored text. | Fix or remove the stored record, then redrive the job if it should run. |
| `PayloadTooLargeError` | `PAYLOAD_TOO_LARGE` | Job data (or a schedule template's data) is over `maxPayloadBytes`, or a progress value is over its limit. `field` is `'data'` or `'progress'`; `size`, `limit` and `queue` say by how much. | Send a smaller payload, such as an id to look up, or raise the limit. |
| `ResultTooLargeError` | `RESULT_TOO_LARGE` | A handler returned a result over `maxResultBytes`. The attempt fails with it. | Return less, or store the result elsewhere and return a reference. |
| `QueueClosedError` | `QUEUE_CLOSED` | `add`, `process`, `cancel` or another call on a queue or producer that is closing or closed. | Make the call before `close()`, or create a new queue. |
| `WorkerClosedError` | `WORKER_CLOSED` | `run`, `pause` or `resume` on a worker that is closing or closed. | Start a new worker with `queue.process`. |
| `DuplicateHandlerError` | `DUPLICATE_HANDLER` | `process` with a handler for a job name that another running worker of this queue object already handles. `jobName` names it. | Use one worker per job name, or close the old worker first. |
| `UnsupportedRuntimeError` | `UNSUPPORTED_RUNTIME` | A `Queue` or `Producer` was made on a runtime without Node's `process`. Importing SureQ does not throw, and the Node version is not checked. | Run on Node.js 22 or newer. |
| `InternalError` | `INTERNAL_ERROR` | Something SureQ did not expect happened. It is reported through the `error` event or thrown. | Report it as a bug, with the message and `details`. |

### Adding jobs

| Class | Code | When thrown | What to do |
|---|---|---|---|
| `DuplicateJobError` | `DUPLICATE_JOB` | An add with `onDuplicate: 'reject'` met a job with the same id or singleton key. Also `queue.redrive(id)` of a dead letter whose id a newer job took (`reason: 'superseded'`). `jobId`, `existingState` and `by` (`'id'` or `'singletonKey'`) describe the clash. | Treat it as "already queued", or pick another id. |
| `MergeConflictError` | `MERGE_CONFLICT` | An add with a merge function kept losing to other writers of the same job and gave up. `jobId` names the job. | Retry the add. |
| `InvalidMergeResultError` | `INVALID_MERGE_RESULT` | A merge function returned `undefined`, a promise, or a value that cannot be stored. With a `cause`, the function threw. | Return the merged data synchronously, as plain JSON. |
| `JobRejectedError` | `JOB_REJECTED` | The queue `filter` rejected the add. `reason`, `reasonCode` and `operation` (`'add'`, `'replace'`, `'merge'` or `'schedule'`) come from the verdict; the filter's own details are under `details.details`. | Expected for bad input. Fix the data or show the reason to the caller. |
| `FilterError` | `FILTER_ERROR` | The queue `filter` threw, returned something that is not a verdict, or ran past `filterTimeoutMs` (`timedOut: true`). The add is refused. | Fix the filter. A timed-out add may be retried. |
| `BulkAddError` | `BULK_ADD_FAILED` | An `addBulk` with `atomic: true` refused an input (`index`), or an `addBulk` write ended with an unknown outcome. `jobIds` lists the ids it sent. | With an `index`, fix that input. Otherwise read `jobIds` back with `getJob` before you retry. |
| `CapabilityError` | `UNSUPPORTED_CAPABILITY` | A call needs a store feature the store does not declare, such as `addBulk` with `atomic: true` on a store without `transactions`. `capability` names it. | Drop the option, or use a store that has the feature. |

### Running jobs

These usually reach you as `ctx.signal.reason`, as the `error` of a `failed` or `retrying` event, or in the job's stored error.

| Class | Code | When thrown | What to do |
|---|---|---|---|
| `UnrecoverableError` | `UNRECOVERABLE` | Thrown by your handler to fail the job at once, with no retry. | Throw it for errors that retrying cannot fix. |
| `PoisonPillError` | `POISON_PILL` | A job's lease expired `maxCrashes` times (its worker kept crashing or hanging). The job fails for good; `crashCount` and `maxCrashes` say why. A subclass of `UnrecoverableError`. | Find what crashes the worker on this job, then redrive it. |
| `StalledJobError` | `JOB_STALLED` | A job's lease expired and it had no attempts left. The sweeper fails the job with this error. | Check why the worker stopped; raise `leaseDuration` for long jobs. |
| `JobTimeoutError` | `JOB_TIMEOUT` | A handler ran past its `timeout`. `ctx.signal` aborts with it; past `timeoutGrace` the attempt fails with it (`abandoned: true`). | Honour `ctx.signal`, or raise `timeout`. |
| `JobCancelledError` | `JOB_CANCELLED` | The running job was cancelled. `ctx.signal` aborts with it and the attempt's outcome is discarded. | Stop work when `ctx.signal` aborts. |
| `LeaseLostError` | `LEASE_LOST` | This worker no longer holds the job's lease: it `'expired'`, was `'superseded'` by a newer claim, or the job is `'not-active'`. `ctx.signal` aborts with it and none of the worker's writes land. | Stop work. Another worker may run the job again. |
| `ShutdownError` | `SHUTDOWN` | The worker is shutting down and its shutdown timeout passed. `ctx.signal` aborts with it and the job is released. | Stop work. The job runs again later. |
| `BackoffStrategyError` | `BACKOFF_STRATEGY_ERROR` | A backoff strategy is unknown, threw, or returned a bad value (`reason`). Reported through the `error` event; the default backoff is used instead. | Fix the strategy. |
| `RetryIfError` | `RETRY_IF_ERROR` | `retryIf` threw or did not return a boolean. Reported through the `error` event; the job is retried. | Fix `retryIf`. |
| `BatchResultMismatchError` | `BATCH_RESULT_MISMATCH` | A batch handler returned an array whose length is not the batch size (`expected`, `got`). The whole batch fails with it. | Return one entry per job, in batch order. |
| `AlreadySettledError` | `ALREADY_SETTLED` | A batch job was completed or failed a second time. The first outcome stands. | Settle each batch job once. |

### Job and schedule lookups

| Class | Code | When thrown | What to do |
|---|---|---|---|
| `JobNotFoundError` | `JOB_NOT_FOUND` | `cancel` (or `job.cancel()`) of an unknown id, or `job.retry()` of a job that was removed. `jobId` names it. | Treat the job as gone. |
| `InvalidJobStateError` | `INVALID_JOB_STATE` | A call not allowed in the job's state, such as `remove` of an active job or `job.retry()` of a job that is not failed. `jobId` and `state` say which. | Wait for the job to finish, or cancel it first. |
| `ScheduleNotFoundError` | `SCHEDULE_NOT_FOUND` | `pauseSchedule`, `resumeSchedule` or `nextRuns` of an unknown key. `key` names it. | Create it with `upsertSchedule`, or check the key. |
| `ScheduleConflictError` | `SCHEDULE_CONFLICT` | A schedule kept changing under other writers while this call tried to write it. `key` names it. | Retry the call. |

### Admin

| Class | Code | When thrown | What to do |
|---|---|---|---|
| `QueueNotIdleError` | `QUEUE_NOT_IDLE` | `obliterate()` while jobs are running. `active` counts them. | Stop the workers, or pass `force: true`. |
| `QueueObliteratingError` | `QUEUE_OBLITERATING` | An add, claim, sweep, redrive, progress write or schedule write on a queue that is being obliterated. | Wait for `obliterate()` to finish. If it died part way, call it again. |

### Store

| Class | Code | When thrown | What to do |
|---|---|---|---|
| `StoreError` | `STORE_ERROR` | A store call failed. The base class of the store errors below. `operation`, `retryable` and `outcomeUnknown` describe it. | Retry when `retryable`. When `outcomeUnknown`, read the job back before you retry a write. |
| `StoreUnavailableError` | `STORE_UNAVAILABLE` | The store could not be reached, or a call ran past `storeCallTimeout`. Any non-SureQ error a store throws becomes this, with the original as `cause`. Always `retryable`. | Retry later. The queue reconnects by itself. |
| `StoreRequestError` | `STORE_BAD_REQUEST` | The store refused a malformed request, or a call before `open` or after `close`. Never retryable. | Fix the call. In a store adapter, this is the error for bad input. |
| `StoreContractVersionError` | `STORE_CONTRACT_VERSION` | The store implements a contract version this core does not accept. `core` lists the versions accepted; `store` is the store's. | Use a store adapter built for this SureQ release. |
| `StoreNotReadyError` | `STORE_NOT_READY` | `ready()` timed out before the store opened and answered. Retryable. | Check the store, then call `ready()` again. |
| `StoreFormatError` | `STORE_FORMAT_UNSUPPORTED` | A stored record, or the namespace's format record, was written in a format this release cannot read. `reason` is `'too-new'`, `'too-old'` or `'missing'`; `recordKind` is `'job'`, `'attempt'`, `'schedule'`, `'settings'` or `'meta'`. | Deploy a release that reads the store's format. |

### Events

| Class | Code | When thrown | What to do |
|---|---|---|---|
| `ListenerError` | `LISTENER_ERROR` | One of your event listeners threw. It is reported through the `error` event, never thrown to the emitter. `event` names the event. | Fix the listener. |

## InvalidOptionError issues

`InvalidOptionError` has `scope` (what was checked, such as `Queue "emails"`) and `issues`, sorted by path. `Issue` is another name for `ConfigIssue`.

```ts
try {
  new Queue('emails', { maxCrashes: 0 })
} catch (e) {
  if (e instanceof InvalidOptionError) for (const i of e.issues) console.log(i.path, i.code, i.message)
}
// maxCrashes out_of_range expected integer >= 1 <= 9007199254740991, received 0
```

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | The option, such as `leaseDuration` or `alerts.depth.above`. |
| `code` | `ConfigIssueCode` | `'invalid_type'`, `'out_of_range'`, `'invalid_value'`, `'unknown_option'`, `'missing_option'`, `'conflict'` or `'unsupported'`. |
| `message` | `string` | What is wrong. |
| `expected` | `string`, optional | What was expected. |
| `received` | `string`, optional | What was given. |
| `suggestion` | `string`, optional | The closest known option, for a misspelt one. |
| `reason` | `'bad-cron' \| 'bad-timezone' \| 'no-occurrence' \| 'bad-interval' \| 'bad-overlap'`, optional | Why a schedule timing or definition is invalid. See [Schedules](13-schedules.md). |

## Error fields by class

Each class also has its fields as properties.

| Class | Properties |
|---|---|
| `PayloadTooLargeError` | `size`, `limit`, `queue`, `field` |
| `ResultTooLargeError` | `size`, `limit`, `jobId` |
| `InvalidJobStateError` | `jobId`, `state` |
| `BackoffStrategyError` | `reason`: `'unknown' \| 'threw' \| 'invalid-result'` |
| `StoreError` and subclasses | `operation`, `retryable`, `outcomeUnknown`, `jobId?`, `jobIds?` |
| `StoreContractVersionError` | `core`, `store` |
| `StoreFormatError` | `reason` (`FormatReason`), `found`, `supported`, `recordKind` (`RecordKind`), `recordId?`, `storeFormat?`, `minReadable?`, `maxReadable?`, `sureqVersion?` |
| `ListenerError` | `event` |
| `DuplicateHandlerError` | `jobName` |
| `BulkAddError` | `jobIds`, `index?` |
| `CapabilityError` | `capability` |
| `LeaseLostError` | `jobId`, `token`, `reason` |
| `JobTimeoutError` | `jobId`, `attempt`, `timeoutMs`, `graceMs`, `abandoned` |
| `JobCancelledError` | `jobId` |
| `PoisonPillError` | `jobId`, `crashCount`, `maxCrashes` |
| `DuplicateJobError` | `jobId`, `existingState`, `by`, `reason?` |
| `MergeConflictError` | `jobId` |
| `InvalidMergeResultError` | `jobId` |
| `JobNotFoundError` | `jobId` |
| `JobRejectedError` | `reason`, `reasonCode?`, `operation`, `jobId` |
| `FilterError` | `timedOut` |
| `AlreadySettledError` | `jobId` |
| `BatchResultMismatchError` | `expected`, `got` |
| `ScheduleNotFoundError` | `key` |
| `ScheduleConflictError` | `key` |
| `QueueObliteratingError` | `queue` |
| `QueueNotIdleError` | `queue`, `active` |

`StoreErrorOptions` is the second argument of `new StoreError(message, opts)`: `{ operation, retryable, outcomeUnknown, jobId?, jobIds?, cause?, details? }`. Store adapters use it; see [Writing your own store](../04-stores/02-writing-your-own.md).

```ts
throw new StoreError('journal is corrupt', { operation: 'open', retryable: false, outcomeUnknown: false })
```

## Filter and duplicate types

These types go with `JobRejectedError`, `FilterError` and `DuplicateJobError`. The options themselves are in [Queue](01-queue.md#adding-jobs) and [Job options](02-job-options.md#duplicates).

- `FilterVerdict` is what a filter returns: `true`, `false`, a reason string, or `{ reject: string; code?: string; details?: unknown }`.
- `FilterContext<D>` is the filter's second argument: `{ queue, name, id, opts, operation }`. `id` is `null` when core makes the id; `opts` are the add's options over `defaultJobOptions`; `operation` is `'add'`, `'replace'`, `'merge'` or `'schedule'`. The filter runs before the store is asked, so `operation` is what the add asks for, not what happens: an add with `onDuplicate: 'replace'` is checked as `'replace'` even when the id is free and a new job is made. With an `onDuplicate` function the filter runs twice when the id is held by a waiting or delayed job: first on the incoming data as `'add'` (it becomes the job if the id is free), then on the merged result as `'merge'`. Rejecting the incoming data rejects the add, so no merge happens.
- `DuplicateInfo` is `AddResult.duplicate`: `{ action: 'ignored' | 'replaced' | 'merged'; existingState: JobState; by: 'id' | 'singletonKey' }`.

```ts
const filter: FilterFn<{ to: string }> = (data, ctx: FilterContext<{ to: string }>): FilterVerdict =>
  ctx.operation === 'schedule' || data.to.includes('@') || { reject: 'not an email address', code: 'bad_to' }
```

## Stored errors

Errors are stored as a `SerializedError` (see [Job and context](07-job-and-context.md#related-types)). Two functions convert them.

| Function | Returns | Meaning |
|---|---|---|
| `serializeError(err, opts)` | `SerializedError` | Describes any thrown value as JSON-safe data, cut to `opts.maxErrorBytes`. Never throws. |
| `deserializeError(s)` | `Error` | Builds a plain `Error` (or `AggregateError`) with the stored name, message, code, stack, cause and fields. Never throws. It never rebuilds a SureQ class, so `instanceof` and `isSureQError` are `false`; check `code`. |

`SerializeOptions` is `{ maxErrorBytes: number; storeStacks: boolean }`, the same meaning as the queue options of those names.

```ts
const stored = serializeError(new Error('smtp down'), { maxErrorBytes: 16_384, storeStacks: false })
const shown = deserializeError(stored)
console.log(shown.name, shown.message)
```
