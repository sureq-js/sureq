# Known limits

These are the limits of this release that you should plan around. Most are by design. Some will change in a later release.

## Delivery

- **At least once, never exactly once.** A job can run again after a crash, a lost lease or a release on shutdown. Use `job.idempotencyKey` for side effects.
- **A `retrying`, `completed` or `failed` event can go missing.** When an attempt's finishing write lands but its answer is lost, and the job moves on before the worker repeats the write, the worker reports the outcome as unconfirmed and emits no event. The stored job is still correct.

## Runtime and stores

- **Node.js 22 or newer only.** Bun and Deno are not supported or tested yet; support is planned for a later release. `UnsupportedRuntimeError` is thrown only on a runtime with no Node-style `process.versions.node`.
- **The only store that ships is in memory.** `MemoryStore` keeps jobs in the process, so they are lost when it exits, and other processes cannot see them. To share jobs across pods, use a store adapter that implements the store contract. See [Writing your own store](../04-stores/02-writing-your-own.md).
- **The store contract is experimental until 1.1.** It may change in a minor release before then. See [Contract version](../04-stores/01-store-contract.md#contract-version).
- **`MemoryStore` time never goes backwards.** When the system clock steps back, store time stands still until the clock catches up. For the length of the step, delays, leases and schedules run late. Other stores follow their own clock.

## Pods and upkeep

- **Upkeep runs on worker pods.** Recovering expired leases and trimming finished jobs need a pod with a worker. Alerts need a pod with a worker or with `alerts` set. A fleet of producers alone sweeps, trims and alerts nothing.
- **Some health numbers are per pod.** The `DEAD_LETTERS_HIGH` count comes from this pod's last sweeper or alert tick. Alerts and the failure-rate window count only this pod's jobs.
- **Only adjacent releases share a store safely.** That is the same major version, with minor versions at most one apart. Others emit `versionSkew`, which only warns. See [Upgrade notes](01-upgrade-notes.md#mixed-version-pods).
- **SureQ cannot see a blocked event loop.** When the loop is blocked, `health()` does not run at all. Your probe's timeout is what detects it.
- **The default shutdown leaves little room in Kubernetes' default grace period.** `close()` can take 25 s plus 2 s plus about 1 s, and Kubernetes kills a pod after 30 s by default. A `preStop` hook or a longer `shutdownTimeout` can push it over: then raise the grace period. See [Graceful shutdown](../02-guides/13-graceful-shutdown.md).
- **Job names are freed when a worker's close begins.** You can start a new worker for the same names while the old one is still draining.

## Payloads and logging

- **`maxPayloadBytes` and `maxResultBytes` default to 1 MiB**, counted as UTF-8 bytes of the JSON.
- **SureQ writes no log line per job.** Use the job events for job logs.
- **Backoff strategy and `retryIf` failures log at `error`.** A strategy or `retryIf` that throws or returns a bad value is reported as an `error` event and logged at `error`, not `warn`. The job is still retried; a broken strategy falls back to the default backoff.
- **`factor` on a `fixed` backoff is ignored**, with no warning.

## Retention

See [Queue options: retention](../03-reference/01-queue.md#retention) for the policies these refer to.

- A job's own age `keep` does not exempt it from the queue's or `byName` count. Jobs kept for none that are still inside `resultGrace` take count slots too.
- A job the sweeper fails, that is not a dead letter, gets the queue's `failed` policy only. `byName` and the job's own `keep` do not apply.
- With `cancelled: 0` and `resultGrace: 0`, cancelling a running job deletes it at once. A worker on another pod then sees its lease lost (`leaseLost`), not a cancel.
- Adding an age to a state that had a count-only or keep-forever policy also ages the jobs already finished under it, from their `finishedAt`.
- Counts are approximate, by up to `pageSize`.
