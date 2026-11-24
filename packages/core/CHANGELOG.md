# Changelog

All notable changes to `@sureq/core`. From 1.0, semver applies to the public API and the stored job format: a breaking change needs a major release.
The store contract stays experimental and may change in a minor release until it is declared stable.
1.0.0 is the first published release;

## 1.0.3 - 2026-11-24

Fixes from an end-to-end review of 1.0.2. No stored job format or store contract changes.

**Fixed**
- A merge function (`onDuplicate: fn`) that throws makes `queue.add()` and `producer.add()` reject with `InvalidMergeResultError`, with the thrown value as its `cause`, as documented and as `addBulk` already did. Before, the raw value escaped (a bare string for `throw 'x'`), so `isSureQError` was `false`. A SureQ error thrown inside the merge function is wrapped too: read it from `cause`. An atomic `addBulk`'s `BulkAddError` now has that `InvalidMergeResultError` as its `cause`, not the raw value.
- After the store was unreachable at start-up, `ready()` could resolve while the connection was still `reconnecting`: adds failed with `STORE_UNAVAILABLE` and `health().ready` stayed `false` until the next reconnect probe, up to `reconnect.maxDelay` later. When `ready()` gets an answer from the store, the outage now ends at once and `storeReconnected` fires before `ready()` resolves.
- The registry check behind the `NO_SCHEDULER_RUNNING` warning and the `versionSkew` event runs when a queue's first worker starts, then every 60 s. Before, the first answer came 60 s after `process()`. The check counts this queue object's own running scheduler, so it does not warn while its worker is still registering, and when the first check finds no scheduler it checks again 5 s later, since other pods' workers may still be registering during a rollout.
- Event listeners may return any value: `queue.on('completed', ({ job }) => ids.push(job.id))` compiles. The listener return type of `on`, `once` and `off` (and of the exported worker `Listener` type) was `void | Promise<void>`, which rejected arrows that return a value (TS2322); it is now `unknown`. The return value is still ignored, and a returned promise that rejects is still reported as an `error` event.
- `consoleLogger()` validates its options like every other options object: an unknown `level` (such as `'warning'`) or option throws `InvalidOptionError`. Before, it was accepted and wrote every level.
- `serializeError` keeps the name of an `Error` whose `message` cannot be read (the name, else the constructor's name, with message `'[unserializable error]'`), not `NonErrorThrown`. An `Error` whose `message` is not a string keeps it as text (`42` reads `'42'`, an object as its JSON). Called from plain JavaScript without options, it uses the queue defaults instead of falling back to `'[unserializable error]'`.

**Docs**
- The filter's `operation` is the requested mode: `'replace'` even when the id is free, and an `onDuplicate` function filters the incoming data as `'add'`, then the merged result as `'merge'`.
- A retention count (`completed: n`) never removes a job finished less than `resultGrace` ago, and the cleanup pass runs at most once per worker `sweepInterval`.
- `NO_SCHEDULER_RUNNING` is raised only by pods that run a worker.
- `upsertSchedule`'s `'unchanged'` still records a higher `version`; the `Schedule` table no longer lists `createdAt` and `updatedAt` twice.
- The delays guide's example starts its clock before the delayed add, so it prints `late Reminder` on every run; the guides' outputs show the in-memory store's startup warning.

## 1.0.2 - 2026-11-22

Job data and results are stored as JSON, but their types claimed the handler got back exactly what was added: `new Queue<{ sendAt: Date }>` compiled, `job.data.sendAt.getTime()` threw on every attempt, and the job became a dead letter. No runtime behaviour, stored job format or store contract changes, except what the queue `filter` sees (below).

**Fixed**
- Job data and results are typed as read back from JSON: `job.data` is `Jsonify<D>` and `job.result` is `Jsonify<R>`, in handlers, `getJob`/`getJobs`, dead letters, events (the `completed` event's `result` too), the `filter`, the `onDuplicate` merge's arguments and a schedule's template data. A `Date` field reads as `string`, so `job.data.sendAt.getTime()` is a compile error instead of a runtime crash; `new Date(job.data.sendAt)` compiles. Objects with `toJSON()` read as what it returns; `Map` and `Set` as `{}`; typed arrays as an object of their indexes; a property that may hold a function or `undefined` as optional; `undefined` data as `null`. What `add()`, `addBulk()`, a handler's return and a merge's return accept is unchanged.
- The queue `filter` sees the data as stored, the same shape the handler and the merge get. Before, it got a `structuredClone`, so it saw a real `Date` while the handler got a string. The job stores the JSON the filter saw, so a `toJSON()` method runs once per add. Data that cannot be serialized (a `bigint`, a cycle) still reaches the filter as a frozen copy, and the add is rejected right after unless the filter rejects it first.

**Added**
- The `Jsonify<T>` type: what `T` becomes after a JSON round trip.

**Note:** code that passes `job.data` (or `job.result`) where the original type is expected no longer compiles when that type holds a `Date`, `Map`, `Set`, `toJSON` object, class instance, or a property that may be `undefined` (it reads as optional), even if it happened to work. Type that parameter as `Jsonify<D>` or `Job<D>`, or convert the field (`new Date(job.data.sendAt)`). A filter's data parameter is no longer typed `Readonly`; the data is still frozen at runtime.

## 1.0.1 - 2026-11-20

No code or behaviour changes; the stored job format and the store contract are unchanged.

**Changed**
- The npm packages list keywords, so `@sureq/core` and `@sureq/store-test` show up in npm search.
- The `@sureq/core` and `@sureq/store-test` READMEs show npm, CI, license, Node, security-policy, Snyk and docs badges; the core README states the 1.0 status and the security policy, and links the documentation site.

**Added**
- The documentation site serves [llms.txt](https://sureq-js.github.io/sureq/llms.txt), [llms-full.txt](https://sureq-js.github.io/sureq/llms-full.txt) and a plain Markdown copy of every page, for AI tools and coding agents.

## 1.0.0 - 2026-11-17

**Upgrading from 0.3**
- 0.3 and 1.0 store jobs in the same format, so pods on 0.3.x and 1.0 can share one store during a rolling deploy, and neither goes into degraded mode.
- A store adapter built for 0.3 declares contract version 2, which 1.0 refuses. Set its `contractVersion` to `STORE_CONTRACT_VERSION` (now 1) before the rollout; the contract itself did not change (see Changed).
- Releases with different major versions are never adjacent, so while both run, every pod with a running worker emits `versionSkew` (`{ workers }`) naming the other release's workers. The event is advisory and blocks nothing; it stops once every pod runs 1.0. Finish the rollout instead of leaving both releases running.

**Changed (API decisions before 1.0)**
- The store contract (`Store`, its request and result types, `STORE_CONTRACT_VERSION`, `MemoryStore`'s contract methods and the `store` option) is marked beta: experimental until 1.1, as the docs say.
- `Schedule` is its own type with the fields the docs list. It no longer exposes the store's `rev`; `createdAt` and `updatedAt` are documented.
- A bare number is refused as a job's `keep` (`keep: { completed: 1000 }` was 1000 milliseconds, while the queue `retention` reads a number as a count). Write a duration per outcome, such as `keep: { completed: '1000ms' }` or `keep: { completed: { age: 1000 } }`.

**Added**
- An agent skill, `skills/sureq`, installable with `npx skills add sureq-js/sureq --skill sureq`.
- New error class `UnsupportedRuntimeError` (`UNSUPPORTED_RUNTIME`), thrown on first use (constructing a `Queue` or `Producer`) on a runtime it does not support; importing the package does not throw. Its default message is "SureQ requires Node.js; this runtime is not supported".
- New queue option `storeCallTimeout` (default `30s`): every store call has a deadline. A call that has not answered by then fails with a retryable `StoreUnavailableError` (`outcomeUnknown` for a write) and starts reconnecting, so a hung store call no longer stalls the sweeper, a worker or an admin call for good; its late answer is ignored.
- A versioning and deprecation policy in the `@sureq/core` README: semver applies to the public API; the store contract may change in a minor release until it is declared stable; a deprecated API stays for at least one minor release before removal and is listed here.
- `SECURITY.md` (how to report a vulnerability privately) and `CONTRIBUTING.md` (setup, commands and rules).
- User documentation in the `user-docs` folder: getting started, guides, the API reference, writing a store and operations notes. The package READMEs now link to it.

**Changed**
- Only a running worker's poll loop, an active job's lease and handler timeout, a running scheduler, and a call still waiting on SureQ (an add waiting for the store or its filter, `ready()`, `health()`, `close()`) keep the process alive; every other SureQ timer is unref'd. A running scheduler now keeps the process alive until it stops.
- The built packages use Node built-ins and globals (`node:` modules, `Buffer`, `process`, `setImmediate`) only in a separate `platform-node` chunk; lint and the dist tests fail the build if any appear elsewhere.
- The types that public signatures use are now exported, type-only, so they can be named: from `@sureq/core`, `JobDefaults`, `LeaseOptions`, `PollingOptions`, `ReconnectOptions`, `TimeoutOptions`, `SerializeOptions`, `StoreErrorOptions`, `StoredBackoff`, `Jitter`, `FormatReason`, `RecordKind`, `ProducerEvent`, `Listener`, `NameData`, `NameResult` and `QueueBase` (the shared base of `Queue` and `Producer`; it cannot be constructed or extended); `@sureq/core/producer` re-exports the ones its own types use, including `QueueOptions` and the store contract's request and result types. Internal types and test-only members are no longer in the published declarations: `queue.internals`, the worker constructors, the worker's internal members, `MemoryStore`'s `faults` option, `dump()` and `unsafeMutate()`, and the `random` test seam on queue, worker and producer options. Runtime behaviour is unchanged.
- `new Queue` and `new Producer` check the store's `capabilities` as `defineCapabilities` builds them: a missing or mistyped flag or limit, or an object that is not deeply frozen, throws `InvalidOptionError` with paths under `store.capabilities`. Before, an incomplete object failed with a plain `TypeError` at the first call that read it.
- `health()` on a queue or producer whose store is not open yet opens it first, within the same `timeoutMs`, so the first readiness probe reports the real state. Before, a fresh queue reported `ready: false`, `status: 'degraded'` and `STORE_RECONNECTING` until its first store call.
- A job whose stored data, result or error is not valid JSON now raises `DeserializationError` (`DESERIALIZATION_FAILED`), which was declared but never thrown. A worker fails such a job for good without running the handler, and runs the other jobs it claimed with it; a batch worker leaves it out of the batch. Before, the worker reported `InternalError` "worker claim failed" and every job of that claim stayed active until its lease ran out, again on each retry. Reads throw it instead of a `SyntaxError` that could quote the stored text.
- The default `shutdownTimeout` is 25 s (was 30 s), so a default `close()` (about 28 s with `shutdownAbortGrace` and the releases) fits Kubernetes' default 30 s grace period. Set `shutdownTimeout: '30s'` to keep the old wait.
- **Breaking:** `Worker.running` is renamed `inFlight`. It counts concurrency slots in use (a batch takes one), not jobs, and the old name was easy to confuse with `isRunning()`. Replace `worker.running` with `worker.inFlight`.
- **Breaking (store contract):** `STORE_CONTRACT_VERSION` is 1 (was 2) and `SUPPORTED_CONTRACT_VERSIONS` is `[1, 1]` (was `[2, 2]`). No earlier version was published, so the first public contract is numbered 1. The contract itself did not change. A store that declares 2 is refused with `StoreContractVersionError`; set its `contractVersion` to `STORE_CONTRACT_VERSION`.
- `queue.formatVersion` and `producer.formatVersion` are typed `number` (were the literal `1`), `STORE_CONTRACT_VERSION` is typed `number` (was the literal `2`), `SUPPORTED_CONTRACT_VERSIONS` is typed `readonly [number, number]` (was `readonly [2, 2]`), and `@sureq/store-test`'s `SUITE_VERSION` is typed `string` (was `'1'`). A later version no longer changes these types.
- `runStoreConformance` throws `InvalidOptionError` for a `groups` entry that is not a group, with the closest group name as the suggestion. Before, a misspelt name such as `'stres'` quietly ran nothing extra.
- **Store contract:** a repeated `complete`, `fail` or `release` answers from the earlier job's tombstone even after a new job took its id (removed and added again, or superseded by a new add); before, it answered `not-active`, and a worker whose first answer was lost reported an unconfirmed outcome. A finished job superseded by a new add now leaves a tombstone. A new conformance test checks it; the store template does it.
- `reconnect.maxDelay` above 2^31 - 1 ms (about 24.8 days) throws `InvalidOptionError`, and the probe wait is capped there. Before, such a delay made Node fire the probe after 1 ms, so probes ran without pause and never reconnected.

**Removed**
- The `@sureq/memory` package. It only re-exported `MemoryStore`, which `@sureq/core` exports and uses by default; import `MemoryStore` from `@sureq/core` instead. Its conformance run, stress group included, now runs in `@sureq/store-test`.
- The queue and producer option `logPayloads`. No log line SureQ writes carries job data, so it did nothing but log a warning; passing it now throws `InvalidOptionError` (`unknown option`). To log job data, log it from the job events.

**Fixed**
- A batch worker holding a job whose stored data is not valid JSON no longer crashes the process when that job's lease is lost: the `leaseLost` event's job is built without its unreadable data.
- A claimed job whose stored error is not valid JSON is failed for good with `DeserializationError`, like one with unreadable data. Before, it stayed `active` with a renewed lease and the jobs claimed with it never started (a batch worker also lost a slot).
- A job with unreadable data deleted as it fails (no dead letter, `retention.failed: 0`) still emits `failed`, with no internal errors.
- `close()` while buffered adds are being sent after an outage lets the add already sent settle from the store; only the adds not yet sent are refused with `QueueClosedError`. Before, a stored add could be reported as not sent.
- `pause()` and `resume()` called together on one queue or producer are sent one at a time, so this pod's pause flag ends up agreeing with the store.
- `serializeError` keeps the result within `maxErrorBytes` when `name` or `code` hold many multi-byte characters, and shortens a non-ASCII message to fit instead of emptying it.
- `addBulk` with something that is not an array throws `InvalidOptionError` instead of a `TypeError`.
- The `retrying` event's job shows `waiting`, not `delayed`, for a retry with no delay, on stores that keep a due job `delayed` until it is claimed.
- `SerializationError.cause` for a value that cannot be serialized (a circular reference or a `bigint`) is a `TypeError` with a fixed message; it no longer carries the native message, which could name the value's properties, and an error thrown by a user's `toJSON` is no longer kept as the cause either.

**Tooling**
- Every public declaration and member of `@sureq/core`, `@sureq/core/producer` and `@sureq/store-test` has a doc comment, so editors show it on hover; a hygiene test fails when the API reports list one as undocumented.
- The public API of each package entry point (`@sureq/core`, `@sureq/core/producer`, `@sureq/store-test`) is recorded in an API Extractor report under `etc/`; `npm run api:check` (run in CI) fails when the built types differ from the committed report or a report uses `any`, and `npm run api:update` rewrites the reports.
- `npm run check:licenses` (run in CI and before publishing) fails when a published package has a licence outside MIT, ISC, Apache-2.0, BSD-2-Clause and BSD-3-Clause, a runtime dependency, or a peer dependency outside `@sureq`.
- A publish workflow, run by hand only, builds and checks the packages and publishes them to the public npm registry with provenance; a prerelease version is published under the `next` dist-tag, never `latest`.
