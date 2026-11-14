# Going to production

A queue that works on your laptop needs a few more settings before it runs real jobs on several pods. Go through this list once per service.
Each item says what to check and links to the page with the details.

## Checklist

- **A durable, shared store.** The built-in `MemoryStore` loses every job when the process exits and cannot be shared between processes. This release ships no durable store, so production needs a store adapter for your database that implements the store contract and passes the conformance kit. See [Store contract](../04-stores/01-store-contract.md) and [Writing your own store](../04-stores/02-writing-your-own.md).
- **No `acknowledgeVolatileStore` in production.** It only silences the warning that the store is not durable. If you see that warning in production, the queue is on the wrong store. See [Worker options: running](../03-reference/04-worker-options.md#running).
- **One namespace per app and environment.** Set `namespace` on every queue and producer, the same on the worker and producer pods. See [Queue options: store and identity](../03-reference/01-queue.md#store-and-identity).
- **Shutdown that fits your orchestrator.** Set `signals: ['SIGTERM']` or call `close()` yourself, and make `shutdownTimeout` plus `shutdownAbortGrace`, plus about a second, fit inside the pod's grace period. See [Graceful shutdown](13-graceful-shutdown.md).
- **Health endpoints.** Serve `live` and `ready` from `health()` on two endpoints. To fail fast when the store is down at start-up, call `await queue.ready()` first. Keep the probe timeout above the `health()` timeout. See [Health and metrics](11-health-and-metrics.md).
- **Alerts and an `error` listener.** Set `alerts` rules for queue depth, waiting age and failure rate, and listen for `alert` and `error` on every queue and worker. Watch `DEAD_LETTERS_HIGH` in `health().warnings`. See [Alerts](../03-reference/11-health-and-metrics.md#alerts) and [Events: store and pods](../03-reference/06-events.md#store-and-pods).
- **Logging into your own logger.** Pass `logger`, for example `pinoLogger(pino())`. SureQ logs errors, alert changes and one-off advice, never each job, so use the `completed`, `failed` and `retrying` events for job logs. See [Logging](../03-reference/12-logging.md).
- **Concurrency and leases.** Pick `concurrency` from what one pod and the services it calls can handle. Give long jobs a longer `leaseDuration`, or `leaseDurationByName` per job name. See [Worker options](../03-reference/04-worker-options.md#leases).
- **Time limits.** Set `timeout` on jobs that can hang, and pass `ctx.signal` to your I/O. See [Worker options: time limits](../03-reference/04-worker-options.md#time-limits).
- **Payload limits.** Keep job data small: store large data elsewhere and put its id in the job. Set `maxPayloadBytes` and `maxResultBytes` to what you expect, so a bad caller fails fast. See [Queue options: adding jobs](../03-reference/01-queue.md#adding-jobs) and [Queue options: results and errors](../03-reference/01-queue.md#results-and-errors).
- **Handlers safe to run twice.** SureQ runs each job at least once, so a job can run again after a crash or a lost lease. Pass `job.idempotencyKey` to outside APIs. See [Core concepts: at least once](../01-getting-started/03-concepts.md#at-least-once).
- **Retention and dead letters.** Check how long finished jobs and dead letters are kept, and decide who redrives dead letters. See [Queue options: retention](../03-reference/01-queue.md#retention) and [Dead letters and redrive](09-dead-letters-and-redrive.md).
- **The store contract is experimental until 1.1,** so a minor release may change it. Pin SureQ and your store adapter together, and read the CHANGELOG before you upgrade. A mismatch fails at start-up with `StoreContractVersionError`. See [Contract version](../04-stores/01-store-contract.md#contract-version).

## Common questions

**Can I run one pod with a `MemoryStore` in production?** Only if losing every waiting job on a restart or a deploy is fine. For most services it is not.

**Do producer pods need all of this?** No. A producer runs no workers, so shutdown, concurrency, leases, alerts and retention are set on the worker pods. It still needs the shared store, the same namespace and the payload limits. See [Producer-only pods](12-producer-only-pods.md).

**Where are the defaults?** In the reference pages linked above. Start with [Queue options](../03-reference/01-queue.md#queue-options).

## Reference

- [Queue options](../03-reference/01-queue.md#queue-options)
- [Worker options](../03-reference/04-worker-options.md)
- [Health and metrics](../03-reference/11-health-and-metrics.md)
- [Logging](../03-reference/12-logging.md)
- [Errors](../03-reference/08-errors.md)
- [Store contract](../04-stores/01-store-contract.md)
