# FAQ

Short answers to common questions. Each one links to the page with the details.

## Setup

**Which Node.js versions does SureQ run on?** Node.js 22 or newer. See [Install SureQ](../01-getting-started/01-install.md#requirements).

**Does it run on Bun or Deno?** Not yet. They are not supported or tested, and support is planned for a later release. `UnsupportedRuntimeError` is thrown when you construct a `Queue` or `Producer` on a runtime with no Node-style `process.versions.node`.

**Can I use CommonJS?** Yes. `require('@sureq/core')` works. See [ESM and CommonJS](../01-getting-started/01-install.md#esm-and-commonjs).

**Does SureQ need Redis or a database?** Not to get started. A `Queue` with no `store` option makes its own in-memory store. For production you need a durable store; see the next section.

## Stores

**Which stores ship with SureQ?** Only the in-memory `MemoryStore`. It keeps jobs in the process, so they are lost when the process exits and other processes cannot see them. See [MemoryStore](../03-reference/10-memory-store.md).

**How do I use my own database?** Write a store adapter that implements the store contract, and check it with the conformance kit. See [Writing your own store](../04-stores/02-writing-your-own.md).

**Is the store contract stable?** Not yet. It is experimental until 1.1 and may change in a minor release before then. Upgrade SureQ and your store adapter together. See [Contract version](../04-stores/01-store-contract.md#contract-version).

**How do I silence "store is not durable; jobs are lost on restart"?** Pass `acknowledgeVolatileStore: true` to `queue.process`. Do that only in tests and local scripts: in production the warning means the queue is on the wrong store.

## Running jobs

**Does a job run exactly once?** No. SureQ runs each job at least once. A job can run again after a crash, a lost lease or a shutdown, so make handlers safe to run twice with `job.idempotencyKey`. See [Core concepts: at least once](../01-getting-started/03-concepts.md#at-least-once).

**Can the pods that add jobs be separate from the pods that run them?** Yes. Use a `Producer` on the pods that only add jobs, with the same store and namespace. See [Producer-only pods](../02-guides/12-producer-only-pods.md).

**Why does `health()` say `ready: false` right after start-up?** On a fresh queue, `health()` opens the store first, and `ready` stays `false` while the store cannot be opened within its timeout. Check that the store is reachable. See [Health and metrics](../02-guides/11-health-and-metrics.md).

**How long does shutdown take?** By default up to about 28 s: 25 s `shutdownTimeout`, 2 s `shutdownAbortGrace`, and about 1 s more. That fits Kubernetes' default 30 s grace period. If you raise `shutdownTimeout` or add a `preStop` hook, raise the grace period too. See [Graceful shutdown](../02-guides/13-graceful-shutdown.md).

## Logs and monitoring

**Why don't I see a log line for each job?** SureQ logs only errors and one-off advice. Log jobs yourself from the `completed`, `failed` and `retrying` events. See [Logging](../03-reference/12-logging.md).

**Can I send logs to my own logger?** Yes. Pass the queue option `logger`, for example `pinoLogger(pino())`. See [Logging](../03-reference/12-logging.md#logger).

**Can I export metrics to Prometheus?** There is no exporter built in, but `queue.metrics()` and `describeMetrics()` give you what a client library needs. See [Health and metrics](../02-guides/11-health-and-metrics.md#common-questions).

## Upgrades

**Can old and new pods share a store during a deploy?** Yes, between adjacent releases: the same major version and minor versions at most one apart. Others emit `versionSkew`. See [Upgrade notes](01-upgrade-notes.md#mixed-version-pods).

**What else should I know before production?** Read [Going to production](../02-guides/16-going-to-production.md) and [Known limits](04-known-limits.md).
