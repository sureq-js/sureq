# Custom store

How to write a SureQ store for your own database, and how to prove it is correct.
Most users do not need this page: use a published store, or `MemoryStore` in tests.

## What a store is

A store is the object a queue talks to for every read and write. It keeps jobs, leases, schedules and the worker registry.
You write one store class per database. Several queues and pods can share one backend through it.
Core never touches the database directly, so everything SureQ promises rests on the store keeping the contract.

## The contract

The contract is `export interface Store` in `@sureq/core`. It has 38 methods: 37 required and the optional `subscribe`.
It also has two read-only properties: `contractVersion` (set it to `STORE_CONTRACT_VERSION`) and `capabilities` (built with `defineCapabilities` and deeply frozen).
The full signatures are in [The Store interface](../../../user-docs/04-stores/01-store-contract.md#the-store-interface).

### Lifecycle

- `open`: connect and check the schema; calls before it throw `StoreRequestError`.
- `close`: stop serving calls; calls after it throw `StoreRequestError`, and closing twice is harmless.
- `now`: the store's current time.
- `subscribe` (optional): a wake-up channel that resolves to an unsubscribe function; needed for the `notify` capability.

### Jobs

- `add`: insert jobs in input order under the duplicate rules; with `atomic: true`, one refused input writes nothing (needs `transactions`).
- `get`: one job by id, or null.
- `list`: one page of jobs in one state.
- `counts`: jobs per state, plus `blocked`.
- `update`: edit a waiting or delayed job, guarded by its revision.
- `cancel`: cancel a job that has not finished.
- `remove`: delete a job that is not active.

### Claims and leases

- `claim`: atomically lease up to `limit` due jobs to one worker, best first.
- `renew`: extend a lease if the caller's token still holds it.
- `complete`: finish an active job with its result, fenced by its token.
- `fail`: record a failed attempt, to retry later or fail for good, fenced by its token.
- `release`: give a claimed job back without finishing it, fenced by its token.
- `sweep`: find expired leases, count a crash, and requeue or fail each job.
- `setProgress`: write an active job's progress, fenced by its token.

### Admin

- `setPaused`: set or clear the queue's pause flag; `changed` is false when it already had that value.
- `isPaused`: read the pause flag; `claim` must honour the same flag.
- `stats`: job counts, the oldest waiting job's due time and the dead-letter count, in one read.
- `getAttempts`: one page of a job's attempt records, oldest first.
- `clean`: delete up to `limit` jobs in one state that match the request, each with its attempt records.
- `obliterate`: delete a queue's jobs, schedules and pause flag in batches of `limit`.
- `redrive`: move failed jobs back to waiting or delayed.

### Schedules

- `putSchedule`: create or replace a schedule, guarded by its revision.
- `getSchedule`: one schedule by key, or null.
- `listSchedules`: one page of a queue's schedules in key order.
- `deleteSchedule`: delete a schedule, optionally guarded by its revision.
- `listDueSchedules`: unpaused schedules due at the store's time, earliest first.
- `fireSchedule`: insert a schedule's job for its due tick and advance the schedule in one atomic step.

### Workers

- `registerWorker`: create or replace a worker's registry record.
- `heartbeatWorker`: refresh a worker's registry record; `ok: false` when it is gone.
- `unregisterWorker`: delete a worker's registry record.
- `listWorkers`: worker registry records, optionally only those serving one queue.
- `purgeWorkers`: delete up to `limit` worker records not heard from for `staleIntervals` of their own heartbeat interval.
- `ensureNamespaceMeta`: create the namespace's format record or raise its version, refusing a version this pod cannot read.
- `getNamespaceMeta`: the namespace's format record, or null when none exists.

## Rules a store must keep

The full list is in [Rules every store follows](../../../user-docs/04-stores/01-store-contract.md#rules-every-store-follows).

- **Atomic claim.** Two claimers never get the same job, so a job never runs twice at once. See [the contract](../../../user-docs/04-stores/01-store-contract.md#rules-every-store-follows).
- **Lease expiry and fencing.** Each claim issues a larger token, and `renew`, `complete`, `fail`, `release` and `setProgress` succeed only for the current token and an unexpired lease. See [the contract](../../../user-docs/04-stores/01-store-contract.md#rules-every-store-follows).
- **The clock.** Every time the store writes comes from its own clock, read in the same atomic step, never the caller's clock. See [the contract](../../../user-docs/04-stores/01-store-contract.md#rules-every-store-follows).
- **At most one live lease per job.** A job holds at most one lease. `claim` never takes an active job, even one whose lease has expired: `sweep` must first put it back to waiting, and the next claim issues a larger token. The old handler may still be running then; fencing refuses its writes, which is why handlers must be safe to run twice. See [the contract](../../../user-docs/04-stores/01-store-contract.md#rules-every-store-follows).
- **A retried run does not leak writes.** A repeat of `complete`, `fail` or `release` with the same token and the same kind returns the first outcome with `repeated: true` and changes nothing, until the job is claimed again; after that, a write with the old token is refused as `superseded`. Keep the last finishing write as a tombstone under the id, so a repeat after a delete or after a new job took the id still answers `repeated: true` and never touches the new job. Any other write with an old token is refused. See [the contract](../../../user-docs/04-stores/01-store-contract.md#rules-every-store-follows).

## Contract version

`STORE_CONTRACT_VERSION` is 1 in this release. A store sets its `contractVersion` to it.
Core accepts the versions in `SUPPORTED_CONTRACT_VERSIONS`. A queue checks the version before the first `open`, and a store outside that range is refused with `StoreContractVersionError` and never opened.
The contract is experimental until 1.1, so read the core changelog before you upgrade. See [Contract version](../../../user-docs/04-stores/01-store-contract.md#contract-version).

## Build one

1. Copy the template folder, [examples/store-template](../../../examples/store-template/src), and read its [README](../../../examples/store-template/README.md).
2. Replace its toy backend with your database, and keep the store logic until the suite passes.
3. Implement the methods in the order of the [build order](../../../user-docs/04-stores/02-writing-your-own.md#build-order). Each step ends with a group of the suite that must pass.
4. Run the conformance kit with `runStoreConformance` from `@sureq/store-test`.
5. Declare your real capabilities with `defineCapabilities`, and pass the gated groups for each one you declare, such as `capabilities:notify` or `capabilities:durable`.

The full guide is [Writing your own store](../../../user-docs/04-stores/02-writing-your-own.md).

## The conformance kit

`runStoreConformance(options)` from `@sureq/store-test` registers the suite with your test runner. It finds `node:test`, Vitest with globals and Jest by itself.
`createStore` is called once per group and returns `{ store, cleanup }`, plus `reopen` when the store declares `durable`.
When `ctx.clock` is not null, the store must read its time from `ctx.clock.now()`.

```ts
import { MemoryStore } from '@sureq/core'
import { runStoreConformance } from '@sureq/store-test'

runStoreConformance({
  name: 'memory-store',
  report: './conformance-report.json',
  createStore: async (ctx) => {
    const clock = ctx.clock
    const store = new MemoryStore(clock ? { clock: () => clock.now() } : {})
    return { store, cleanup: async () => {} }
  },
})
```

A passing run proves the store keeps the contract under races: claims, leases, fencing, sweeping, the store clock, the duplicate rules, schedules and the worker registry.
The report's `conformant` is true only when nothing failed, no group other than a `capabilities:` gate or `merge:core` was skipped, `concurrency` is at least 10, and the `clock` and `lease` groups ran in real time.
Options such as `concurrency`, `iterations`, `timeScale`, `skip`, `realTime` and `report` are in [Conformance kit](../../../user-docs/04-stores/03-conformance-kit.md).
