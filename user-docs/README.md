# SureQ documentation

SureQ is a job queue for Node.js, written in TypeScript.
You add jobs to a queue, and workers run them with retries, delays, priorities and schedules.
Jobs live in a store: an in-memory store is built in, and other stores plug in through the store contract.

## Start here

1. [Install SureQ](01-getting-started/01-install.md)
2. [Build your first queue](01-getting-started/02-first-queue.md)
3. [Learn the core concepts](01-getting-started/03-concepts.md)

## Sections

| Section | What you find there |
|---|---|
| [Getting started](01-getting-started/01-install.md) | Install, a first working queue, and the words the rest of the docs use. |
| [Guides](02-guides/01-adding-jobs.md) | Short, task-based pages, each with one runnable example. |
| [Reference](03-reference/01-queue.md) | Every option, default, method, event and error. |
| [Stores](04-stores/01-store-contract.md) | The store contract, writing your own store, and the conformance kit. |
| [Operations](05-operations/01-upgrade-notes.md) | Upgrade notes, troubleshooting, FAQ and known limits. |

## Common tasks

- Add jobs: [Adding jobs](02-guides/01-adding-jobs.md)
- Run jobs: [Processing jobs](02-guides/02-processing-jobs.md)
- Retry failed jobs: [Retries and failures](02-guides/03-retries-and-failures.md)
- Shut down cleanly: [Graceful shutdown](02-guides/13-graceful-shutdown.md)
- Get ready for production: [Going to production](02-guides/16-going-to-production.md)
