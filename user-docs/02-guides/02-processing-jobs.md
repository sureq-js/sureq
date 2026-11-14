# Processing jobs

A worker claims jobs from a queue and runs your handler on each one. You start one with `queue.process(handler, options)`.
This page runs three jobs, two at a time, and stops the worker when the queue is empty.

## Example

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { Queue } from '@sureq/core'

type Email = { to: string; subject: string }

const queue = new Queue<Email, { sentAt: number }>('emails')

const worker = queue.process(
  async (job, ctx) => {
    console.log('start', job.data.to, 'attempt', ctx.attempt)
    // Pass ctx.signal on, so the work stops when the job must stop.
    await sleep(100, undefined, { signal: ctx.signal })
    return { sentAt: Date.now() }
  },
  { concurrency: 2 },
)

worker.on('completed', ({ job }) => console.log('done', job.data.to))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))

for (const to of ['ada@example.com', 'alan@example.com', 'grace@example.com']) {
  await queue.add({ to, subject: 'Welcome' })
}

await drained
console.log(worker.state, (await queue.getCounts()).completed)
await queue.close()
console.log(worker.state)
```

Output:

```text
start ada@example.com attempt 1
start alan@example.com attempt 1
done ada@example.com
start grace@example.com attempt 1
done alan@example.com
done grace@example.com
running 3
stopped
```

- The handler gets the `job` and a `ctx` for this attempt. What it returns is the job's result. What it throws fails the attempt.
- `concurrency: 2` lets two handlers run at once, so the third job starts only when a slot is free.
- `ctx.signal` aborts when the attempt must stop: a timeout, a cancel, a lost lease or a shutdown. Hand it to your I/O.
- Listen for `error` on every worker. It reports problems that are not a job failure, such as a store error.
- `queue.close()` stops the worker. Its state goes from `running` to `stopped`.

## Common questions

**Can one worker run several kinds of job?** Yes. Give each job a `name`, and pass `process` an object with one handler per name. See [Named jobs](../03-reference/01-queue.md#named-jobs).

**Should I listen on the worker or on the queue?** Either. The queue passes on its workers' job events, so `queue.on('completed', ...)` hears all of them. See [Events](../03-reference/06-events.md#who-emits-what).

**Can a job run twice?** Yes. SureQ runs each job at least once, never exactly once. Pass `job.idempotencyKey` to outside APIs so a second run does no harm.

**How do I start a worker later?** Pass `autorun: false`, then call `worker.run()`.

**What happens to a job whose name has no handler?** No worker claims it. A worker asks the store only for the job names it has handlers for, and `process(handler)` handles unnamed jobs only. So the job stays `waiting`, with no error or event, until a worker with a handler for that name runs. See [Queue: running jobs](../03-reference/01-queue.md#running-jobs).

## Reference

- [Worker options](../03-reference/04-worker-options.md)
- [Handlers](../03-reference/04-worker-options.md#handlers)
- [Worker](../03-reference/04-worker-options.md#worker)
- [Job and context](../03-reference/07-job-and-context.md)
- [Events: running](../03-reference/06-events.md#running)
