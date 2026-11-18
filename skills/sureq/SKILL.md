---
name: sureq
description: Use when building or changing a SureQ job queue in Node.js or TypeScript - adding a queue, a job or a worker, background work, retries, delays, priorities, schedules, dead letters, graceful shutdown, or a custom SureQ store.
metadata:
  version: 1.0.0
---

# SureQ

SureQ is a job queue for Node.js and TypeScript, published as `@sureq/core`.
A `Queue` stores jobs, `queue.process(handler)` starts a worker that runs them, and a store keeps the jobs.
This skill documents SureQ 1.0.0.
Read the rules here first, then open a reference file for the details.

## Use SureQ for

- Background work that must not block a request, because a worker runs the job after the caller returns.
- Work that must retry on failure, because SureQ retries with backoff up to `maxAttempts`.
- Work that runs later or in order of importance, because jobs take a `delay` and a `priority`.
- Work that runs on a schedule, because a schedule makes a job on a `cron` rule or a fixed `every` period.
- Work that must not be lost when it fails for good, because failed jobs become dead letters you can redrive.

## Do not use SureQ for

- A request and response call, because a job runs later and the caller should not wait on a worker for an answer.
- A fan-out message bus, because each job runs on one worker, not on every subscriber.
- A stream of events, because SureQ keeps no ordered log for consumers to replay.

## Start from these defaults

- Create one queue per kind of job, because each queue gets its own retries, retention, alerts and workers.
- Use a durable, shared store in production, because the built-in `MemoryStore` loses every job when the process exits.
- Set a `namespace` per app and environment, because it keeps their jobs apart in one store.
- Set `maxAttempts` on purpose, because the default of 3 attempts rarely fits every kind of job.
- Write handlers that are safe to run twice, because SureQ runs each job at least once and a job can run again after a crash.

## Production checklist

Each line follows [Going to production](../../user-docs/02-guides/16-going-to-production.md).

- Use a durable, shared store that passes the conformance kit, because `MemoryStore` cannot be shared between processes. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Remove `acknowledgeVolatileStore` from production code, because it only hides the warning that the store is not durable. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Set the same `namespace` on every queue and producer of an app and environment, because pods only share jobs inside one namespace. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Set `signals: ['SIGTERM']` or call `close()` yourself, and fit `shutdownTimeout` plus `shutdownAbortGrace` plus about a second inside the pod's grace period, because a killed pod does not release its jobs. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Serve `live` and `ready` from `health()` on two endpoints, and call `await queue.ready()` at start-up, because the orchestrator needs them to route and restart pods. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Set `alerts` rules and listen for `alert` and `error` on every queue and worker, because store failures and alert changes reach your code only as events. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Pass your own `logger`, because SureQ logs errors and alert changes but never each job. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Pick `concurrency` from what one pod can handle, and give long jobs a longer `leaseDuration`, because a lease that runs out lets another worker run the job again. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Set `timeout` on jobs that can hang and pass `ctx.signal` to your I/O, because a hung handler holds a worker slot. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Keep job data small and set `maxPayloadBytes` and `maxResultBytes`, because a bad caller then fails fast. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Make handlers safe to run twice and pass `job.idempotencyKey` to outside APIs, because a job can run again after a crash or a lost lease. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Check how long finished jobs and dead letters are kept, and decide who redrives dead letters, because nobody else will. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).
- Pin SureQ and your store adapter together and read the CHANGELOG before you upgrade, because the store contract is experimental until 1.1. See [Going to production](../../user-docs/02-guides/16-going-to-production.md#checklist).

## Mistakes to avoid

- Do not set `acknowledgeVolatileStore` outside tests and local scripts, because in production the warning it hides means the queue is on the wrong store.
- Do not share the in-memory store across processes, because each process gets its own copy and the other process never sees the jobs.
- Do not create a `Queue` per request, because a queue with no `store` makes its own in-memory store, so jobs added to it never reach your worker; create the queue once at start-up and reuse it.
- Do not leave out the `error` listener, because store and listener failures are reported as `error` events.
- Do not call `close()` without `await`, because the process can exit before running jobs finish or are released.
- Do not pass a bare number as a job's `keep` value, because it is refused on a job (only `0`, meaning none, is accepted); `keep` is per outcome, so write `keep: { completed: '1d' }` or `keep: { completed: { age: 1000 } }`.

## Where to look

- [references/options.md](references/options.md): queue, worker, batch worker, job and producer options, with names, defaults and ranges.
- [references/recipes.md](references/recipes.md): the common tasks, each a complete sample.
- [references/custom-store.md](references/custom-store.md): the store contract, what a store must keep, a template and the conformance kit.
- The user docs in this repository, starting at [Your first queue](../../user-docs/01-getting-started/02-first-queue.md).
- The public docs: https://sureq-js.github.io/sureq/.
