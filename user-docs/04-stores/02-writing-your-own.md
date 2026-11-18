# Writing your own store

This page walks you through writing a store adapter: a `Store` over your own database, so that pods in several processes share one set of jobs. You do not need to know SureQ's code. You need the [store contract](01-store-contract.md), the [store template](#the-template) and the [conformance kit](03-conformance-kit.md).

> **Experimental until 1.1.** The store contract may change in a minor release before 1.1. Your adapter states the `contractVersion` it implements, and core refuses a store whose version it does not support.

## Before you start

- A store is 37 methods plus an optional `subscribe`. The list is in [The Store interface](01-store-contract.md#the-store-interface).
- Required: an atomic claim, fencing tokens, a store clock and unique ids. Everything a capability flag describes is optional.
- Plan for days, not hours, for a first adapter. Most of the time goes into the atomic operations and into running the race tests against a real database.
- Stop here if your database cannot change a single record only when it still has the value you read, or cannot read its own clock inside the atomic step that writes a lease. A store that falls back to the pod's clock fails the `clock:` tests and is not conformant.

## The six primitives

Check that your database gives you these before you write code:

1. **Compare-and-set**: change a record only if it still has the value you read (a revision, a token).
2. **Claim without double-take**: two callers that pick the same waiting job must not both get it.
3. **Unique insert**: two inserts of one id leave exactly one record.
4. **A server clock** you can read in the same atomic step that writes a lease or a due time.
5. **Strong reads**: a read right after a write sees the write. No replica lag.
6. **Integers of at least 53 bits** for times, `seq` and tokens.

## How each operation maps to a database

| Operation | SQL (Postgres, MySQL 8+) | Redis, Valkey | MongoDB | Key-value with compare-and-set |
|---|---|---|---|---|
| claim | `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` | Lua over a sorted set and a hash | `findOneAndUpdate` per job with `state: waiting` in the filter | read candidates, conditional put on the revision |
| fenced write (and the repeat check on `lastFinal`) | `UPDATE ... WHERE id=? AND state='active' AND lease_token=? AND lease_expires_at > clock_timestamp()`, then check the row count | Lua: compare the token and `TIME` | `$expr` filter (`{ $expr: { $gt: ['$leaseExpiresAt', '$$NOW'] } }`) in `findOneAndUpdate`, or an update pipeline with `$cond` and `$$NOW`; check the returned document | conditional put on the revision, clock from a time authority |
| token and seq counters | a counter row, `UPDATE scope SET last_token = last_token + n RETURNING`, in the claim transaction, or a sequence (unique and increasing is enough; gaps are fine) | `INCRBY` inside the claim script | a counter document updated with `$inc` in the claim transaction | a counter item with a conditional update |
| add and unique ids | a unique index (partial for pending ids) and `INSERT ... ON CONFLICT` | `HSETNX` or Lua | a unique index and upsert | conditional put if absent |
| sweep | `UPDATE ... WHERE state='active' AND lease_expires_at <= clock_timestamp()` | Lua over an expiry sorted set | a conditional update per job | scan an expiry index, conditional put per job |
| store clock | `clock_timestamp()` or `NOW(3)` | `TIME` | `$$NOW` (inside `$expr` or an update pipeline) | needs a time authority; a store with no clock readable inside the conditional write (DynamoDB, for example) is not conformant |

## Build order

Build in this order. Each step ends with a part of the conformance suite that must pass. Run a part with your test runner's title filter, for example `vitest run -t "claim:"`.

| Step | Build | Tests that must pass |
|---|---|---|
| 1 | `open`, `close`, `now` and `capabilities` | the `contract:`, `capabilities:` and `clock:` basics |
| 2 | `add`, `get`, `list` and `counts` | the `contract:` tests for records, add, list and counts |
| 3 | duplicates and singleton keys | `dedup:`, `singleton:`, `idem:` and `merge:` |
| 4 | `claim` | `claim:` and `lease-config:` |
| 5 | `renew`, `complete`, `fail` and `release`, with one shared fence check | `lease:`, `fencing:` and `release:` |
| 6 | `sweep` | `sweep:` and `poison:` |
| 7 | `cancel`, `remove`, `update` and pause | `cancel:`, `gpause:` and the rest of `contract:` |
| 8 | optional, gated groups | `capabilities:notify`, `capabilities:transactions`, `capabilities:durable` |

The rest of the suite is in the groups `stats`, `history`, `admin`, `dlq`, `retention`, `progress`, `batch`, `workers`, `meta` and `schedule`, one per remaining area of the contract. Test titles start with the group name, with two exceptions: the `stats` group also has `age:` and `metrics:` titles, and the `schedule` group's titles start with `schedule-store:` and `schedule-fire:`. So run that group with `vitest run -t "schedule-"`.

## Atomicity checklist

One row per method: what must happen as one atomic step, and which two things must never interleave.

| Method | Must be atomic | Must not interleave |
|---|---|---|
| `open` | connect and verify the schema | a call served before the schema is checked |
| `close` | stop serving calls | a call served after close |
| `now` | one clock read | a time that goes backwards |
| `add` | duplicate check, singleton check, seq and insert for each input; the whole call only with `atomic` | two adds of one id both succeeding; an atomic batch half written |
| `claim` | select, lease, token and attempt for every job taken | two claimers taking one job; a claim and a cancel or replace |
| `renew` | fence check and lease extension | a renew and a sweep or a newer claim |
| `complete` | fence check, state change and recording `lastFinal` | a stale complete and a fresh claim; a complete and a cancel |
| `fail` | fence check, retry or fail decision and recording `lastFinal` | a stale fail and a fresh claim |
| `release` | fence check, state change and recording `lastFinal` | a release and a sweep |
| `sweep` | find expired leases, count the crash, requeue or fail | two sweepers counting one crash; a sweep and a renew or complete |
| `cancel` | state change and lease clear | a cancel and a claim or a complete |
| `remove` | delete and leave the tombstone | a remove and a claim |
| `update` | revision check and write | two updates both succeeding on one revision |
| `get` | one consistent read | a half-written record |
| `list` | one consistent page | a job listed twice or missing across the page |
| `counts` | one consistent read of all states | counts that drift from the lists |
| `setPaused` | flip the flag | a claim that ignores a pause already acknowledged |
| `isPaused` | read the flag | a flag that differs from the one `claim` reads |
| `stats` | counts, oldest waiting due time and dead-letter count in one read | numbers taken from different moments |
| `getAttempts` | one consistent page of a job's attempt records | a record listed twice or missing across the page |
| `clean` | select and delete each batch | a clean deleting a job a claim just took |
| `obliterate` | idle check, mark and each delete batch | an add or claim landing in a queue being obliterated |
| `redrive` | failed check, state change and attempt reset per job | two redrives of one job both succeeding |
| `setProgress` | fence check and progress write | a stale worker's progress after a newer claim |
| `registerWorker` | create or replace the worker record | two records for one worker id |
| `heartbeatWorker` | find and refresh the worker record | a heartbeat recreating a purged record |
| `unregisterWorker` | delete the worker record | a heartbeat after unregister bringing it back |
| `listWorkers` | one consistent read of the registry | a worker listed twice |
| `purgeWorkers` | stale check and delete | purging a worker whose heartbeat just landed |
| `ensureNamespaceMeta` | read, compare and create or raise the format record | two pods both creating it, or a raise past a version a pod cannot read |
| `getNamespaceMeta` | one consistent read | a half-written format record |
| `putSchedule` | revision check and write | two puts both succeeding on one revision |
| `getSchedule` | one consistent read | a half-written schedule |
| `listSchedules` | one consistent page in key order | a schedule listed twice or missing across the page |
| `deleteSchedule` | revision check and delete | a delete and a put both succeeding on one revision |
| `listDueSchedules` | one consistent read of due schedules | a due schedule missing from the list |
| `fireSchedule` | revision check, job insert and schedule advance | two pods firing one tick; a job inserted without the schedule advancing |

Keep `stats` cheap. Core reads it on every sweeper and alert tick and on every `metrics()` call, so keep the per-state and dead-letter counts up to date in the writes that change them, or answer from an index. Do not scan every job.

## Common mistakes

Each one has a symptom and the test that catches it.

| Mistake | What goes wrong | Caught by |
|---|---|---|
| Claim as a `SELECT`, then an `UPDATE` with no lock or condition | Two workers get one job. | `claim: concurrent claimers never receive the same job` |
| The fence check in a separate statement from the write | A stale worker completes a re-claimed job. | `fencing: concurrent stale complete and fresh claim — exactly one wins` |
| Using the pod's clock, or the transaction start time, for leases and delays | Leases and delays drift with pod clocks. | `clock: store time is unaffected by pod clock skew +1h` |
| A phantom in the unique-id check at READ COMMITTED | Two adds of one id both succeed. | `dedup: concurrent adds of the same id create exactly one job` |
| Forgetting to keep `token` after a lease ends | A re-claim reuses an old token. | `fencing: re-claim after sweep issues a larger token than the first claim` |
| A per-job token counter that restarts for a re-added id | A stale worker of the old job writes to the new one. | `fencing: stale token from a previous incarnation of a reused id is rejected` |
| `complete`, `fail` or `release` refusing a repeat with the same token | A worker whose answer was lost sees an error. | `contract: complete, fail and release repeated with the same token return the original outcome with repeated true and change nothing, not even rev` |
| A `claim` that ignores `claimId` | A lost answer loses jobs. | `contract: claim repeated with the same claimId returns the same jobs with recovered true and claims nothing new` |
| A `replace` that resets fields the caller did not set | A replaced job loses its settings. | `contract: replace overwrites only specified fields, never lowers maxAttempts below attempt and keeps a retry job's runAt` |
| Reusing `seq` after a delete (`max(seq) + 1`, `min(seq) - 1`) | Jobs run out of order. | `contract: first true after deleting the lowest job still gets a seq below every seq ever issued` |
| Checking a request half way through the write | A bad request leaves a half-done change. | `contract: invalid arguments throw StoreRequestError before any change` |
| A separate counter that drifts from the data | `getCounts` disagrees with `getJobs`. | `contract: counts equal list totals per state after a mixed workload` |
| Stale reads in `claim` or in a fenced write | Races count a crash twice, or lose a write. | the race tests, such as `sweep: concurrent sweepers count each crash exactly once` |

The phantom read cannot show up in the template, because its transactions never overlap. Use a unique index or a conditional write, and run the suite against your real database with `iterations: 1000`.

## Capabilities

Declare each flag from what your store really does, with `defineCapabilities`. A left-out flag is `false`. See [Capabilities](01-store-contract.md#capabilities) for what each flag means.

```ts
import { defineCapabilities } from '@sureq/core'

export const capabilities = defineCapabilities({ transactions: true, skipLocked: true, durable: true })
```

A flag you declare is tested, so declaring a capability you do not have fails the suite. Skipping a gated group, such as `skip: ['capabilities:notify']`, keeps the run conformant; skipping any other group does not.

## The template

The SureQ repository has a complete, commented adapter that passes the whole suite: [`examples/store-template`](https://github.com/sureq-js/sureq/tree/main/examples/store-template). It is not published. Copy it, replace the storage parts, and keep the logic. Its own [README](https://github.com/sureq-js/sureq/blob/main/examples/store-template/README.md) shows how.

> The template's backend is for learning only: one process, one writer, everything held in memory and journaled to a file. Do not run it in production.

| File | What it is |
|---|---|
| `src/store.ts` | The store methods. Each has a `SUREQ-CONTRACT: <method>` block with `WHY:` lines. Places where a real database differs carry a `REPLACE-ME:` line naming the SQL, Redis and MongoDB way. |
| `src/fence.ts` | `fenceCheck`, the one helper behind `renew`, `complete`, `fail` and `release`. |
| `src/admin.ts` | `stats`, `clean`, `obliterate`, and the check that refuses writes to a queue being obliterated. |
| `src/schedules.ts` | The schedule records, with a `rev` compare-and-set. |
| `src/attempts.ts` | Attempt records: the claim opens one per attempt and the call that ends it closes it, in the same transaction. |
| `src/dlq.ts` | Dead letters: the marker written when a job fails for good, the `list` filters, and `redrive`. |
| `src/replace.ts` | How `add` with `onDuplicate: 'replace'` rewrites the existing record. |
| `src/check.ts` | The request checks every method runs first. Unknown fields are refused. |
| `src/namespace.ts` | The per-namespace format record. |
| `src/workers.ts` | The worker registry. |
| `src/retention.ts` | The finishing write that deletes a job or stamps when it may be deleted, and the rules `clean` deletes by. |
| `src/backend.ts` | The toy backend: `transact` (one writer at a time), `serverNow`, and the small `Tx` API the store is written against. This is the file you replace. |
| `tests/conformance.test.ts` | Runs the whole suite against the template and checks the report. |

To use it:

1. Copy the folder into your adapter package and rename it `sureq-store-<backend>`.
2. Replace `src/backend.ts` with code over your database: `transact`, `serverNow` and the `Tx` members. Search for `REPLACE-ME:` to find every place the toy differs from a real database.
3. Keep `src/store.ts` as it is until the suite passes. Then move the checks into your database's own atomic operations: a single `UPDATE ... RETURNING` is much better than a read and a write.
4. Declare your real capabilities in the `defineCapabilities` call.
5. Run the suite and paste its report into your README.

The template's backend runs one transaction at a time, so isolation problems (phantom reads at READ COMMITTED, lost updates, write skew, deadlocks, serialization failures, replica lag) and missing indexes never appear there. Passing the suite on the template proves the logic, not your isolation choices.

## Running the suite

Run the [conformance kit](03-conformance-kit.md) against your real database, in CI as well, with more than one connection. That is where isolation mistakes show.

```ts
import type { Store } from '@sureq/core'
import { runStoreConformance } from '@sureq/store-test'

// Stand-in for your adapter: a store over a database, with its own clock and a way to reopen it.
declare function connect(opts: { prefix: string; clock?: () => number }): { store: Store; reopen(): Promise<Store>; drop(): Promise<void> }

runStoreConformance({
  name: 'sureq-store-mydb',
  report: './conformance-report.json',
  createStore: async (ctx) => {
    const clock = ctx.clock
    const db = connect({ prefix: ctx.scopeId, ...(clock && { clock: () => clock.now() }) })
    return { store: db.store, reopen: db.reopen, cleanup: db.drop }
  },
})
```

- A failing race test is a real bug, not flakiness. Re-run with `iterations: 1000` before you release.
- You may not skip a required test: the report then says `conformant: false`.

## Publishing

- Official adapters are named `@sureq/<store>`. Community adapters are `sureq-store-<backend>` or `@<scope>/sureq-store-<backend>`. There is no registry yet.
- Put `@sureq/core` in `peerDependencies` with a range, and the suite in `devDependencies`:

```json
{
  "name": "sureq-store-mydb",
  "peerDependencies": { "@sureq/core": "^1.0.0" },
  "devDependencies": { "@sureq/store-test": "^1.0.0" }
}
```

- Export your store factory, the `contractVersion` you implement, and your capabilities:

```ts
import { defineCapabilities, STORE_CONTRACT_VERSION, type Store } from '@sureq/core'

export const contractVersion = STORE_CONTRACT_VERSION
export const capabilities = defineCapabilities({ transactions: true, skipLocked: true, durable: true })
export declare function createMyStore(opts: { url: string }): Store
```

- Version your adapter with semver on its own. Its README states the contract version, the suite version and the capabilities, and pastes the conformance report. That report is the certification; it is self-reported.

## When the contract changes

Read the core `CHANGELOG.md` before you upgrade. Every change to the store contract is listed there. A change may raise `STORE_CONTRACT_VERSION`. Core lists the versions it accepts in `SUPPORTED_CONTRACT_VERSIONS`, and a store outside them is refused with `StoreContractVersionError` when a queue opens it. Update your adapter, re-run the suite (it grows with the contract), and publish a new version that names the new contract version.

## Getting help

Open an issue on the SureQ repository with your report and the failing test title. Adapters that pass are welcome to be listed in the SureQ docs; open an issue to ask.
