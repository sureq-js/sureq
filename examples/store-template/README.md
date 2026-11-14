# store-template

A complete, commented SureQ store adapter that passes the full conformance suite. It is not published. Copy it,
replace the storage parts, and keep the logic.

The step-by-step guide is [Writing your own store](../../user-docs/04-stores/02-writing-your-own.md).
This page shows how to use the template alongside it.

> The toy backend is for learning only: one process, one writer, everything held in memory and journaled to a
> file. Do not run it in production.

> Its `stats` scans every job of the queue, so its cost grows with the job count. Core reads `stats` on every
> sweeper and alert tick and every `metrics()` call: a real adapter keeps the per-state and dead-letter counts in
> the writes that change them (or answers from an index), not with a scan.

## Files

| File | What it is |
|---|---|
| [`src/store.ts`](src/store.ts) | The store methods built so far. Each has a `SUREQ-CONTRACT: <method>` block with `WHY:` lines; spots where a real database differs carry a `REPLACE-ME:` line naming the SQL, Redis and Mongo equivalent. |
| [`src/fence.ts`](src/fence.ts) | `fenceCheck`, the one helper behind `renew`, `complete`, `fail` and `release`. |
| [`src/admin.ts`](src/admin.ts) | Queue-wide operations the store methods call inside their transaction: `stats`, `clean`, `obliterate` and the obliterating marker check (`assertWritable`). |
| [`src/schedules.ts`](src/schedules.ts) | The schedule records (`putSchedule` with a `rev` compare-and-set, `getSchedule`, `listSchedules`, `deleteSchedule`); `store.ts` delegates to them. |
| [`src/attempts.ts`](src/attempts.ts) | Attempt records: the claim opens one row per attempt and the call that ends it closes it, in the same transaction; `getAttempts` pages them by token. |
| [`src/dlq.ts`](src/dlq.ts) | Dead letters: `markDeadLetter` (called by `fail` and `sweep` in the write that fails the job), the `list` filters, and `redrive`, one conditional write per job. |
| [`src/replace.ts`](src/replace.ts) | How `add` with `onDuplicate: 'replace'` rewrites the existing record. |
| [`src/check.ts`](src/check.ts) | The request checks every method runs first; unknown fields are refused. |
| [`src/namespace.ts`](src/namespace.ts) | The per-namespace format record (`ensureNamespaceMeta`, `getNamespaceMeta`) that lets pods of adjacent releases share one store. |
| [`src/workers.ts`](src/workers.ts) | The worker registry: `registerWorker` (an upsert), `heartbeatWorker` (`ok: false` when the record is gone), `unregisterWorker`, `listWorkers` (records plus store now) and `purgeWorkers` (a bounded delete of records silent for `staleIntervals` of their own heartbeat interval), one record per `(namespace, workerId)`. |
| [`src/pending.ts`](src/pending.ts) | Contract methods not built yet (none at the moment): each rejects with `StoreRequestError`. Delete a name when you build its method. |
| [`src/backend.ts`](src/backend.ts) | The toy backend: `transact` (one writer at a time), `serverNow`, and the small `Tx` API the store is written against. This is the file you replace. |
| [`src/index.ts`](src/index.ts) | The exports. |
| [`tests/conformance.test.ts`](tests/conformance.test.ts) | Runs the whole suite against the template and checks the report. |
| [`tests/template.test.ts`](tests/template.test.ts) | Keeps the template honest: method list, comment tags, no pod clock, no `any`. |

## Copy it

1. Copy the folder to your adapter package and rename it (`sureq-store-<backend>`).
2. Replace `src/backend.ts` with code over your database: implement `transact` and `serverNow`, and the `Tx`
   members. Search for `REPLACE-ME:` to find every place the toy differs from a real database.
3. Keep `src/store.ts` as it is until the suite passes, then move the checks into your database's own atomic
   operations (a single `UPDATE ... RETURNING` is much better than a read and a write).
4. Declare your real capabilities in the `defineCapabilities` call.
5. Run the suite (below) and paste the report JSON into your README.

## Follow the build order

The guide's build order maps onto this code:

1. `open`, `close`, `now`, capabilities: top of the class.
2. `add` (with `#addOne`), `get`, `list`, `counts`.
3. Duplicate rules and singleton keys: inside `#addOne`.
4. `claim`.
5. `renew`, `complete`, `fail`, `release`, all through `fenceCheck`.
6. `sweep`.
7. `cancel`, `remove`, `update`, `setPaused`, `isPaused`.
8. Durability: the journal in `backend.ts`; `reopen` in the conformance test.

Run one group at a time while you build:

```text
npx vitest run tests/conformance.test.ts -t "claim:"
```

## Run the suite

```text
npm run test:conformance -w store-template
```

The `clock:` and `lease:` groups wait for real leases, so a full run takes several minutes.
`npm test -w store-template` runs only the quick checks of the template itself.
