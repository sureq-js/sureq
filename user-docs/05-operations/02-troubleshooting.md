# Troubleshooting

Each entry starts with what you see, then says why it happens and what to do.
Error codes are listed in [Errors](../03-reference/08-errors.md). Health warning codes are listed in [Health warnings](../03-reference/11-health-and-metrics.md#health-warnings).

Two things help with almost every problem:

```ts
queue.on('error', ({ error, source, context }) => console.error(source, context.operation, error.code, error.message))
console.log((await queue.health()).warnings)
```

## Start-up

### The log says "store is not durable; jobs are lost on restart"

**Cause.** A worker started on a store that is not durable, such as the built-in `MemoryStore`. A `Queue` with no `store` option makes its own `MemoryStore`.

**Fix.** In production, pass a durable store adapter as `store`. In tests and local scripts, pass `acknowledgeVolatileStore: true` to `queue.process` to silence the warning. See [Going to production](../02-guides/16-going-to-production.md).

### The readiness probe fails right after start-up

**Cause.** On a fresh queue, `health()` opens the store first. When the store cannot be opened within the `health()` timeout (default 2 s), it reports `ready: false`, `store.state` is `'reconnecting'`, and the warnings hold `STORE_RECONNECTING`.

**Fix.** Check that the store is reachable. Keep the probe timeout above the `health()` timeout. To fail fast at start-up instead, call `await queue.ready()` before you start the server: it throws `StoreNotReadyError` when the store does not open in time.

```ts
await queue.ready()
server.listen(8080)
```

### `ready()` throws `STORE_NOT_READY`

**Cause.** The store did not open and answer within the `ready()` timeout.

**Fix.** Check that the store is reachable and its settings are right, then call `ready()` again. Pass a longer wait with `ready({ timeoutMs })` if the store is slow to start.

### `new Queue(...)` throws `INVALID_OPTION`

**Cause.** An option has a bad type, is out of range, is unknown, or conflicts with another.

**Fix.** Read `error.issues`. Each issue names the option in `path`, and a misspelt option has a `suggestion`. See [InvalidOptionError issues](../03-reference/08-errors.md#invalidoptionerror-issues).

### Start-up fails with `STORE_CONTRACT_VERSION`

**Cause.** The store adapter was built for a different store contract version than this SureQ release accepts.

**Fix.** Install the adapter version made for your SureQ version. The store contract is experimental until 1.1, so upgrade both together. See [Contract version](../04-stores/01-store-contract.md#contract-version).

### Start-up fails with `STORE_FORMAT_UNSUPPORTED`

**Cause.** The store holds records in a format this release cannot read. `reason` says `'too-new'`, `'too-old'` or `'missing'`.

**Fix.** Deploy a release that reads the store's format. With `'too-new'`, a newer release already wrote to this namespace: finish rolling forward rather than back. See [Upgrade notes](01-upgrade-notes.md#mixed-version-pods).

### Constructing a queue throws `UNSUPPORTED_RUNTIME`

**Cause.** The code runs on a runtime with no Node-style `process.versions.node`. SureQ throws this error only then. Bun and Deno are not supported or tested yet; support is planned for a later release.

**Fix.** Run on Node.js 22 or newer.

## Adding jobs

### `add` throws `STORE_UNAVAILABLE`

**Cause.** The store could not be reached, or the call ran past `storeCallTimeout`. By default, `add` fails at once while the store is down.

**Fix.** Retry later; the queue reconnects by itself. To make adds wait for the store instead, set the queue option `onDisconnected: 'wait'`. See [Queue options: store and identity](../03-reference/01-queue.md#store-and-identity). When `outcomeUnknown` is `true`, read the job back with `getJob` before you add it again.

### `add` throws `PAYLOAD_TOO_LARGE` or `SERIALIZATION_FAILED`

**Cause.** The job data is over `maxPayloadBytes` (1 MiB by default), or it is not JSON: a circular reference, a `bigint` or a function.

**Fix.** Pass plain JSON, and keep it small. Store large data elsewhere and put its id in the job.

### `add` throws `QUEUE_CLOSED`

**Cause.** The queue or producer is closing or closed. This often happens when a request arrives during shutdown.

**Fix.** Stop taking requests before you call `close()`. Close the HTTP server first, then the queue.

### `add` throws `DUPLICATE_JOB`

**Cause.** The add used `onDuplicate: 'reject'` and a job with the same id or singleton key exists.

**Fix.** Treat it as "already queued", or use another id. See [Duplicates and unique ids](../02-guides/07-duplicates-and-unique-ids.md).

## Running jobs

### Jobs stay in `waiting` and never run

Check these causes in order:

- **No handler for the job's name.** A worker only claims jobs whose name it has a handler for. A job named `digest` waits for ever on a worker that handles only `welcome`. Add the handler, or start a worker that has one.
- **The queue is paused.** `health().warnings` holds `QUEUE_PAUSED`. Call `queue.resume()`.
- **The worker is paused.** Call `worker.resume()`. A paused worker still counts as running.
- **No worker runs.** A producer never runs jobs. Start a worker with `queue.process` on some pod that shares the store and namespace.
- **The namespace differs.** A worker sees only jobs in its own `namespace`. Set the same one on producer and worker pods.
- **The pod is degraded.** See [A pod stopped claiming after a deploy](#a-pod-stopped-claiming-after-a-deploy).

A job with a delay is `delayed`, not `waiting`, until it is due. That is expected.

### `process` throws `DUPLICATE_HANDLER`

**Cause.** Another running worker of this queue object already handles that job name.

**Fix.** Use one worker per job name, or close the old worker first.

### A job ran twice

**Cause.** SureQ runs each job at least once, never exactly once. A job runs again after a crash, after its lease is lost (`LEASE_LOST`), or after it was released on shutdown while its handler kept going.

**Fix.** Make handlers safe to run twice: pass `job.idempotencyKey` to outside APIs. Pass `ctx.signal` to your I/O, so work stops when the attempt must stop. See [Core concepts: at least once](../01-getting-started/03-concepts.md#at-least-once).

### Handlers abort with `LEASE_LOST`, or `health()` warns `RENEWALS_LATE`

**Cause.** The worker could not renew the job's lease in time. Most often the handler keeps the CPU busy for a long stretch, so the event loop cannot run the renewal. A slow store can do it too.

**Fix.** `await` inside long loops so other work can run. Give long jobs a longer lease with `leaseDuration` or `leaseDurationByName`. See [Worker options: leases](../03-reference/04-worker-options.md#leases).

### Jobs fail with `JOB_STALLED` or `POISON_PILL`

**Cause.** The worker running the job stopped renewing its lease: it crashed, hung or was killed. `JOB_STALLED` means the job had no attempts left. `POISON_PILL` means the lease expired `maxCrashes` times, so the job itself likely crashes the worker.

**Fix.** Find why the worker stopped: check memory limits, crash logs and pod restarts. Fix the cause, then redrive the job. See [Dead letters and redrive](../02-guides/09-dead-letters-and-redrive.md).

### Jobs fail with `JOB_TIMEOUT`

**Cause.** The handler ran past its `timeout`, so `ctx.signal` aborted with `JobTimeoutError`. A handler still running `timeoutGrace` later is abandoned, and its late result is ignored.

**Fix.** Pass `ctx.signal` to your I/O, or raise `timeout` for that job. See [Worker options: time limits](../03-reference/04-worker-options.md#time-limits).

### `health()` warns `DEAD_LETTERS_HIGH`

**Cause.** More jobs have failed for good than `deadLetter.warnAbove` (10 000 by default).

**Fix.** Read them with `queue.getDeadLetters()` and look at their errors. Fix the cause, then redrive them or remove them. See [Dead letters and redrive](../02-guides/09-dead-letters-and-redrive.md).

### Expired leases are never recovered, and finished jobs pile up

**Cause.** The sweeper and the cleanup pass run only on pods with a worker. A fleet of producers alone sweeps and trims nothing.

**Fix.** Run at least one worker pod for the queue.

### `health()` warns `SWEEP_STALLED`

**Cause.** This pod's sweeper has not finished a tick in five sweep intervals. Its store calls are slow or hanging, or the event loop is blocked.

**Fix.** Check `health().store.latencyMs` and the store itself. A lower `storeCallTimeout` makes a hung call fail sooner.

## Schedules

### Schedules do not fire, and `health()` warns `NO_SCHEDULER_RUNNING`

**Cause.** The queue has unpaused schedules, but no live worker runs a scheduler. Either no worker runs, or every worker's queue has `scheduler: { enabled: false }`.

**Fix.** Run a worker with the scheduler on, on at least one pod. A scheduler started with `startScheduler()` on a pod with no worker does fire schedules, but the warning stays, because only workers report a scheduler. See [Schedules](../02-guides/05-schedules.md).

### `health()` warns `SCHEDULER_STALE`

**Cause.** This pod's scheduler has not finished a loop turn in five times `tickMs`. Its store calls are slow, or the event loop is blocked.

**Fix.** Check the store's latency and look for handlers that block the CPU.

## Store and deploys

### `health()` warns `STORE_RECONNECTING`, and `ready` is `false`

**Cause.** The store is not connected. At start-up, it could not be opened within the `health()` timeout. Later, a store call failed and the queue is reconnecting.

**Fix.** Check the store. The queue reconnects by itself and emits `storeReconnected`. A liveness probe on `live` does not depend on the store, so the pods are not restarted.

### A pod stopped claiming after a deploy

**Cause.** The store moved to a format this pod cannot read. The pod is degraded: it emits `degraded`, `health()` warns `STORE_FORMAT_AHEAD` and reports `ready: false`, and it claims, sweeps and fires nothing. Its active jobs finish.

**Fix.** Finish the deploy so that every pod runs the new release. The old pod resumes by itself if the format becomes readable again. See [Upgrade notes](01-upgrade-notes.md#mixed-version-pods).

### The log warns about workers of releases not adjacent to this one

**Cause.** Pods of releases that are not adjacent share the queue, and the queue emitted `versionSkew`.

**Fix.** Finish the deploy so every pod runs the same major and minor release. See [Upgrade notes](01-upgrade-notes.md#mixed-version-pods).

## Shutdown

### Pods are killed before shutdown ends, and jobs run again later

**Cause.** `close()` can take `shutdownTimeout` (default 25 s), plus `shutdownAbortGrace` (default 2 s), plus about 1 s. With a raised `shutdownTimeout` or a `preStop` hook, that can be longer than the 30 s Kubernetes waits by default before it kills a pod. A killed pod does not release its jobs, so they run again when their leases expire.

**Fix.** Lower `shutdownTimeout`, or raise the pod's `terminationGracePeriodSeconds` above the total, `preStop` hook included. See [Graceful shutdown](../02-guides/13-graceful-shutdown.md).

```ts
queue.process(handler, { shutdownTimeout: '20s' })
```

### The process does not exit

**Cause.** A running worker, an active job, a running scheduler, or a call still waiting on SureQ (an add, `ready()`, `health()` or `close()`) keeps the process alive. SureQ never exits the process for you.

**Fix.** Call `await queue.close()` when you are done, and close your other resources, such as an HTTP server. Or set the queue option `signals: ['SIGTERM']` so a signal closes the queue.

## Health probes and logs

### The health endpoint times out

**Cause.** The event loop is blocked, so `health()` cannot run at all. SureQ cannot detect this from inside.

**Fix.** Keep the probe's timeout above the `health()` timeout, so the probe itself catches it. Then find the code that blocks the CPU.

### No log line appears for each job

**Cause.** SureQ logs only errors and one-off advice. It writes no line per job.

**Fix.** Log from the `completed`, `failed` and `retrying` events. See [Logging](../03-reference/12-logging.md).

### The `error` event reports `INTERNAL_ERROR`

**Cause.** Something happened that SureQ did not expect.

**Fix.** Report it as a bug, with the message and `details`.
