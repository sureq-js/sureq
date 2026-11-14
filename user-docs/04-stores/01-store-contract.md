# Store contract

A store is where jobs live. SureQ talks to every store through one interface, `Store`, exported by `@sureq/core`. The built-in [MemoryStore](../03-reference/10-memory-store.md) implements it, and so does any store adapter for a database.

> **Experimental until 1.1.** The store contract may still change in a minor release before 1.1, where it is declared stable. Every change is listed in the CHANGELOG. A change may raise `STORE_CONTRACT_VERSION`. The rest of the public API follows semver from 1.0.

You only need this page to write or check a store. To use one, pass it as the queue's `store` option.

```ts
import { MemoryStore, Queue, type Store } from '@sureq/core'

const store: Store = new MemoryStore()
const queue = new Queue('emails', { store })
```

## Contract version

| Export | Value | Meaning |
|---|---|---|
| `STORE_CONTRACT_VERSION` | `1` | The contract version this core implements. A store sets its `contractVersion` to this. |
| `SUPPORTED_CONTRACT_VERSIONS` | `[1, 1]` | The inclusive range of store versions this core accepts. |

A queue checks the store's `contractVersion` before its first `open()`. A version outside the range throws `StoreContractVersionError`, and the store is never opened.

```ts
import { STORE_CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS } from '@sureq/core'

console.log(STORE_CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS) // 1 [ 1, 1 ]
```

## The Store interface

A store has two properties, 37 methods and one optional method. Every method is async.

Most methods take a `Scope`, `{ namespace: string; queue: string }`: one queue in one namespace. The worker registry and the format record are per namespace and take a `NamespaceScope`, `{ namespace: string }`.

### Properties

| Property | Type | Meaning |
|---|---|---|
| `contractVersion` | `number` | The contract version the store implements. |
| `capabilities` | `StoreCapabilities` | What the store can do. Build it with `defineCapabilities`. See [Capabilities](#capabilities). |

### Life cycle and clock

| Method | Returns | Does |
|---|---|---|
| `open()` | `void` | Connects and checks the schema. Calls before `open` throw `StoreRequestError`. |
| `close()` | `void` | Stops serving calls. Calls after `close` throw `StoreRequestError`. Closing twice is harmless. |
| `now()` | `StoreTime` | The store's own clock, in integer epoch ms. Leases, delays and schedules all use it, never a pod's clock. |
| `subscribe?(scope, onWake)` | `() => Promise<void>` | Optional. Calls `onWake` soon after a job becomes ready. Resolves to an unsubscribe function. Only with the `notify` capability. |

### Jobs

| Method | Returns | Does |
|---|---|---|
| `add(scope, jobs, opts?)` | `AddOutcome[]` | Inserts jobs in input order under the duplicate rules. `opts.atomic`: one refused input writes nothing. |
| `claim(scope, req)` | `ClaimResult` | Atomically leases up to `limit` waiting jobs to one worker, best first. |
| `renew(scope, req)` | `RenewResult` | Extends a lease, if the caller's token still holds it. |
| `complete(scope, req)` | `CompleteResult` | Finishes an active job with its result. Fenced by token. |
| `fail(scope, req)` | `FailResult` | Records a failed attempt: retry later, or fail for good. Fenced by token. |
| `release(scope, req)` | `ReleaseResult` | Gives a claimed job back without finishing it. Fenced by token. |
| `sweep(scope, req)` | `SweepResult` | Finds expired leases, counts a crash, and requeues or fails each job. |
| `cancel(scope, req)` | `CancelResult` | Cancels a job that has not finished. |
| `remove(scope, { id })` | `RemoveResult` | Deletes a job that is not active. |
| `update(scope, req)` | `UpdateResult` | Edits a waiting or delayed job, guarded by its revision. |
| `get(scope, id)` | `JobRecord \| null` | One job. |
| `list(scope, req)` | `JobRecord[]` | One page of jobs in one state. |
| `counts(scope)` | `JobCounts` | Jobs per state, plus `blocked`. |
| `stats(scope, {})` | `StatsResult` | Counts, the oldest waiting job's due time and the dead-letter count, in one read. |
| `setProgress(scope, req)` | `SetProgressResult` | Writes an active job's progress. Fenced by token. |
| `getAttempts(scope, req)` | `GetAttemptsResult` | One page of a job's attempt records, oldest first. |

### Pause, admin and dead letters

| Method | Returns | Does |
|---|---|---|
| `setPaused(scope, paused)` | `{ changed: boolean }` | Sets or clears the queue's pause flag. |
| `isPaused(scope)` | `boolean` | Reads the pause flag. `claim` must read the same flag. |
| `clean(scope, req)` | `CleanResult` | Deletes up to `limit` jobs in one state, each with its attempt records. |
| `obliterate(scope, req)` | `ObliterateResult` | Deletes a queue's jobs, schedules and pause flag in batches. |
| `redrive(scope, req)` | `RedriveOutcome[]` | Moves failed jobs back to waiting or delayed, by id or by a dead-letter filter. |

### Schedules

| Method | Returns | Does |
|---|---|---|
| `putSchedule(scope, req)` | `PutScheduleResult` | Creates or replaces a schedule, guarded by its revision. |
| `getSchedule(scope, { key })` | `ScheduleRecord \| null` | One schedule. |
| `listSchedules(scope, req)` | `ListSchedulesResult` | One page of schedules in key order. |
| `deleteSchedule(scope, req)` | `DeleteScheduleResult` | Deletes a schedule, optionally guarded by its revision. |
| `listDueSchedules(scope, { limit })` | `ListDueSchedulesResult` | Unpaused schedules due at store time, earliest first. |
| `fireSchedule(scope, req)` | `FireScheduleResult` | Inserts a schedule's job for its due tick and advances the schedule, in one atomic step. |

### Workers and format

| Method | Returns | Does |
|---|---|---|
| `registerWorker(ns, req)` | `RegisterWorkerResult` | Creates or replaces a worker's registry record. |
| `heartbeatWorker(ns, req)` | `{ ok: boolean }` | Refreshes a worker's record. `ok: false` when it is gone. |
| `unregisterWorker(ns, { workerId })` | `void` | Deletes a worker's record. |
| `listWorkers(ns, { queue? })` | `ListWorkersResult` | Worker records, optionally only those serving one queue, with store now. |
| `purgeWorkers(ns, { staleIntervals, limit })` | `{ removed: number }` | Deletes up to `limit` records not heard from for `staleIntervals` of their own heartbeat interval. |
| `ensureNamespaceMeta(ns, req)` | `EnsureNamespaceMetaResult` | Creates the namespace's format record or raises its version, refusing a version this pod cannot read. |
| `getNamespaceMeta(ns)` | `StoreMeta \| null` | The namespace's format record. |

## Rules every store follows

- **One store clock.** Every time the store writes (a lease, a due time, a finish time) comes from its own clock, read inside the same atomic step. Never the caller's clock.
- **Atomic claims.** Two claimers never get the same job.
- **Fencing tokens.** Each claim issues a token larger than any before it for that job id, even across a delete and re-add. `renew`, `complete`, `fail`, `release` and `setProgress` succeed only for the current token and an unexpired lease; otherwise they return a `FencedRejection`, `{ ok: false, reason: 'superseded' | 'expired' | 'not-active' }`.
- **Repeats are safe.** A `complete`, `fail` or `release` repeated with the same token returns the first outcome with `repeated: true` and changes nothing. That holds after the job was deleted, and after a new job took its id (removed and added again, or superseded by a new add): keep the last write as a tombstone under the id, and answer a repeat from it whenever its token matches. Tokens are unique per queue, so a matching tombstone can only be that earlier job's. Any other write with the old token is refused, and the new job is never touched. A `claim` repeated with the same `claimId` returns the same jobs with `recovered: true`.
- **Unique ids.** Two adds of one id leave exactly one job.
- **Opaque payloads.** Job data, results, errors, backoff, timeout, `keep` and progress are a `Payload`, `string | Uint8Array`. The store keeps them as they are and never reads them.
- **Check first.** A malformed request throws `StoreRequestError` before anything changes. Any other failure should throw a `StoreError`; SureQ turns anything else a store throws into a retryable `StoreUnavailableError`.
- **Superseded records.** When an add reuses the id of a finished job that no longer holds it, the old record moves to the key `id#seq`, and `get`, `list`, `counts` and `claim` no longer see it. A superseded dead letter stays a dead letter: `stats` counts it and the dead-letter `list` filter returns it.

The step-by-step rules for each method, and the database operations that meet them, are in [Writing your own store](02-writing-your-own.md). The [conformance kit](03-conformance-kit.md) checks all of them.

## Capabilities

`StoreCapabilities` tells core what the store can do. Core reads it before it uses a feature.

| Flag | Meaning when `true` | Core uses it |
|---|---|---|
| `transactions` | An `add` with `atomic: true` is all or nothing. Without it, `atomic` must throw `CapabilityError`. | `addBulk` with `atomic: true` |
| `skipLocked` | Many claimers do not block each other. | Without it, workers claim fewer jobs per call and spread their polls more. |
| `notify` | The store has `subscribe`, and a wake arrives within about two seconds of an add. | Workers wake at once instead of waiting for the next poll. |
| `durable` | An acknowledged write survives a restart. | `health().store.durable`; without it, the first `process()` logs a warning. |
| `shared` | Several store objects, even in several processes, can use one backend. | Checked by the conformance kit. |

| Limit | Default | Meaning |
|---|---|---|
| `limits.maxIdBytes` | `255` | Longest job id the store takes, in UTF-8 bytes. At least 36. |
| `limits.maxClaimLimit` | `1000` | Most jobs one `claim` may return. At least 1. |

The other flags, `ttl`, `claimConstraints`, `boundedAdd`, `flows`, `logs`, `archive`, `audit`, `metricsHistory`, `changeFeed`, `externalTransaction`, `migrations`, `singleNode`, `patch`, `deadlines` and `queueRecords`, are reserved. This release does not use them; leave them `false`.

### defineCapabilities

`defineCapabilities(input)` builds a complete, deeply frozen `StoreCapabilities`. A left-out flag is `false` and a left-out limit gets its default. A value of the wrong type throws `InvalidOptionError`.

`CapabilitiesInput` is what it takes: any flag may be left out, and so may either limit.

```ts
import { defineCapabilities } from '@sureq/core'

const capabilities = defineCapabilities({ transactions: true, skipLocked: true, durable: true, limits: { maxClaimLimit: 500 } })
```

Always build `capabilities` with `defineCapabilities`. `new Queue` and `new Producer` check the store's `capabilities` the same way: an object that misses a flag or a limit, has a value of the wrong type, or is not deeply frozen throws `InvalidOptionError`, with each problem under the path `store.capabilities`.

## Request and result types

Each store method has its own request and result types, all exported from `@sureq/core` and `@sureq/core/producer`. You need them only to write a store. They are listed here by group; the fields are in the type definitions, and the comments in [the store template](02-writing-your-own.md#the-template) explain each one.

| Group | Types |
|---|---|
| Common | `Scope`, `NamespaceScope`, `StoreTime`, `Payload`, `JobState`, `JobCounts` |
| Jobs | `JobRecord`, `NewJob`, `AddOutcome`, `DeadLetterInfo`, `DeadLetterReason`, `StoredProgress`, `RetentionDirective`, `HistoryOption`, `ClaimHistoryOption`, `FencedRejection` |
| Claim and leases | `ClaimRequest`, `ClaimResult`, `ClaimBlocked`, `RenewRequest`, `RenewResult`, `CompleteRequest`, `CompleteResult`, `FailRequest`, `FailResult`, `ReleaseRequest`, `ReleaseResult`, `SetProgressRequest`, `SetProgressResult` |
| Sweep | `SweepRequest`, `SweepResult`, `SweptJob` |
| Control | `CancelRequest`, `CancelResult`, `RemoveResult`, `UpdateRequest`, `UpdateResult`, `ListRequest`, `StatsResult` |
| History | `GetAttemptsRequest`, `GetAttemptsResult`, `StoredAttempt`, `AttemptOutcome` |
| Admin and dead letters | `CleanRequest`, `CleanResult`, `CleanableState`, `ObliterateRequest`, `ObliterateResult`, `RedriveRequest`, `RedriveOutcome` |
| Schedules | `ScheduleRecord`, `NewSchedule`, `OverlapPolicy`, `PutScheduleRequest`, `PutScheduleResult`, `ListSchedulesRequest`, `ListSchedulesResult`, `DeleteScheduleRequest`, `DeleteScheduleResult`, `ListDueSchedulesResult`, `FireScheduleRequest`, `FireScheduleResult` |
| Workers | `RegisterWorkerRequest`, `RegisterWorkerResult`, `HeartbeatWorkerRequest`, `WorkerRecord`, `ListWorkersResult`, `WorkerStatus` |
| Format | `EnsureNamespaceMetaRequest`, `EnsureNamespaceMetaResult`, `StoreMeta` |

A few that shape every store:

- `AddOutcome` is `{ status: 'added', job }`, `{ status: 'duplicate', action: 'ignored' | 'replaced' | 'rejected', by, existingState, job }` or `{ status: 'not-applied' }` (an `atomic` add that another input refused).
- `ClaimResult` is `{ jobs, now, nextRunAt, paused, blocked?, recovered? }`. `nextRunAt` is the next due time, so an idle worker knows how long to sleep.
- `FailResult` is `{ ok: true, state: 'delayed' | 'failed', runAt?, now, repeated? }` or a `FencedRejection`.
- `StoreMeta` is `{ formatVersion, createdBy, lastRaisedBy, updatedAt }`: the namespace's format record, which lets pods of adjacent releases share one store.

## Store errors

| Throw | When |
|---|---|
| `StoreRequestError` | A malformed request, or a call before `open` or after `close`. Never retried. |
| `StoreUnavailableError` | The backend cannot be reached. Retried by core. |
| `StoreError` | Any other store failure. Set `retryable` and `outcomeUnknown` honestly. |
| `CapabilityError` | A request needs a capability the store does not declare, such as `atomic` without `transactions`. |
| `QueueObliteratingError` | A write to a queue that is being obliterated. |
| `QueueNotIdleError` | `obliterate` without `force` while jobs are active. |
| `StoreFormatError` | A record in a format the caller cannot read. |

See [Errors](../03-reference/08-errors.md#store) for each class.

## Next

- [Writing your own store](02-writing-your-own.md): the walk-through, from primitives to publishing.
- [Conformance kit](03-conformance-kit.md): the test suite that checks a store against this contract.
