# Core concepts

These are the words the rest of the docs use.

## Glossary

- **Job**: one piece of work. It has data (any JSON value), an id, a state and options such as `maxAttempts` or `delay`. When it finishes, it also has a result or an error.
- **Queue**: a named list of jobs, such as `emails`. You create one with `new Queue('emails')`, add jobs to it and start workers on it.
- **Worker**: runs the jobs of one queue. `queue.process(handler)` starts one. The handler is your function that does the work for one job.
- **Store**: where jobs are kept. A queue with no `store` option creates its own in-memory store. Several queues, processes or pods share jobs by using the same store. See [Stores](../04-stores/01-store-contract.md).
- **Attempt**: one run of the handler for a job. A failed attempt is retried until the job's `maxAttempts` is used up. Each attempt leaves a record you can read with `job.getAttempts()`.
- **Lease**: while a worker runs a job, it holds a lease on it, so no other worker takes the same job. The worker renews the lease while the handler runs. If the worker crashes, the lease runs out and another worker picks the job up.
- **Namespace**: a name that groups queues inside one store. Queues with the same name in different namespaces never see each other's jobs. The default is `default`.
- **Producer**: adds and reads jobs but never runs them. Use it in processes that only add jobs, such as an API server. See [Producer-only pods](../02-guides/12-producer-only-pods.md).
- **Dead letter**: a job that failed for good. It is kept with its data and error until you redrive (retry) it or remove it (or clean it up, or `deadLetter.keep` expires it). See [Dead letters and redrive](../02-guides/09-dead-letters-and-redrive.md).
- **Store time**: delays, leases and retries are timed by the store's clock, not by the clock of each pod.

## At least once

SureQ runs each job at least once, never exactly once. A job can run again after a crash, a lost lease or a release during shutdown. Write handlers so a second run does no harm. `job.idempotencyKey` stays the same on every attempt of a job, so you can pass it to external APIs.

## Job lifecycle

A job is always in one of six states: `waiting`, `delayed`, `active`, `completed`, `failed` or `cancelled`.

```text diagram=job-lifecycle
            add                     add with delay
             |                            |
             v                            v
        +---------+   delay is over  +---------+
        | waiting | <--------------- | delayed |
        +---------+                  +---------+
          |     ^                         ^
    claim |     | released, or            | attempt failed,
          |     | lease ran out (too many | retry after a wait
          |     | crashes: failed)        |
          v     |                         |
        +-----------------------------------+
        |              active               |
        +-----------------------------------+
            |                       |
   handler  |                       | no attempts left,
   returned |                       | or not retryable
            v                       v
      +-----------+            +--------+
      | completed |            | failed | --- redrive ---> waiting or delayed
      +-----------+            +--------+

  cancel: waiting, delayed or active ---> cancelled
```

- **waiting**: ready to run. A worker claims it when it has a free slot.
- **delayed**: waits until a set time. A job is delayed when you add it with `delay` or `runAt`, or while it waits to be retried. A retry goes through `delayed` even when its wait is zero.
- **active**: a worker is running it and holds its lease.
- **completed**: the handler returned. The job keeps its result.
- **failed**: no attempts are left, or the error was not retryable (for example `UnrecoverableError`). The job keeps its last error.
- **cancelled**: you cancelled it with `queue.cancel(id)` or `job.cancel()`. It never runs again.

`completed`, `failed` and `cancelled` are final states. A job stays in a final state until retention deletes it, or until you redrive a failed job.

## Next

- [Adding jobs](../02-guides/01-adding-jobs.md)
- [Processing jobs](../02-guides/02-processing-jobs.md)
- [Queue reference](../03-reference/01-queue.md)
