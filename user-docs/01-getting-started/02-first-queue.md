# Your first queue

This page builds a small email queue. It adds three jobs, runs them, reports each outcome, waits until the queue is empty and then closes it.

## The code

Save this as `first-queue.ts`:

```ts
import { Queue, UnrecoverableError } from '@sureq/core'

type Email = { to: string; subject: string }

// No `store` option: the queue makes its own in-memory store.
const queue = new Queue<Email, { sent: true }>('emails', {
  defaultJobOptions: { maxAttempts: 3 },
})

const worker = queue.process(
  async (job) => {
    if (!job.data.to.includes('@')) {
      throw new UnrecoverableError('invalid address') // fail now, no retry
    }
    // Send the email here.
    return { sent: true }
  },
  { concurrency: 5 },
)

worker.on('completed', ({ job, result }) => console.log(job.id, 'completed', result))
worker.on('failed', ({ job, reason, error }) => console.log(job.id, 'failed:', reason, error.message))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = new Promise<void>((resolve) => queue.on('drained', () => resolve()))

await queue.add({ to: 'ada@example.com', subject: 'Welcome' }, { id: 'welcome-ada' })
await queue.add({ to: 'alan@example.com', subject: 'Welcome' }, { id: 'welcome-alan' })
await queue.add({ to: 'not-an-email', subject: 'Oops' }, { id: 'oops' })

await drained
console.log(await queue.getCounts())
await queue.close()
```

Run it. In a new folder, run `npm init -y`, then `npm install @sureq/core`, and add `"type": "module"` to `package.json`. Node 22.18 or newer runs a TypeScript file directly (plain type annotations only). On an older Node 22, use a runner such as `tsx`.

```sh
node first-queue.ts
# or
npx tsx first-queue.ts
```

## The output

```text
store is not durable; jobs are lost on restart { queue: 'emails' }
welcome-ada completed { sent: true }
welcome-alan completed { sent: true }
oops failed: unrecoverable invalid address
{
  waiting: 0,
  delayed: 0,
  active: 0,
  completed: 2,
  failed: 1,
  cancelled: 0,
  blocked: 0
}
```

## What happened

- `new Queue('emails', ...)` made a queue. `Email` is the type of the job data, and `{ sent: true }` is the type of the result.
- `defaultJobOptions` sets options for every job added to this queue. Here each job gets at most 3 attempts.
- `queue.process(handler, options)` started a worker. The handler runs once per attempt. What it returns is the job's result. `concurrency: 5` lets up to five jobs run at once.
- The first line, `store is not durable; jobs are lost on restart`, is a warning the worker logs once when it starts. It is expected with the built-in in-memory store, which loses every job when the process exits. A [durable store](../04-stores/01-store-contract.md) makes it go away. In tests and local scripts you can silence it with the worker option `acknowledgeVolatileStore: true`; see [Testing your jobs](../02-guides/15-testing-your-jobs.md).
- `queue.add(data, { id })` stored each job. The `id` is optional; without it SureQ makes one for you.
- The third job threw `UnrecoverableError`, so it failed at once with reason `unrecoverable`. Any other error is retried until `maxAttempts` is used up.
- The worker emits `completed` and `failed` once per job. It emits `error` for problems that are not a job failure, such as a store error. Always listen for `error`.
- The queue emits `drained` when no job is left to run.
- `queue.getCounts()` shows how many jobs are in each state.
- `blocked` counts waiting jobs held back by a pause. It is not a seventh state.
- `queue.close()` stopped the worker and closed the in-memory store the queue made.

## Next

- Learn the words used in these docs: [Core concepts](03-concepts.md).
- Add jobs with delays, priorities and names: [Adding jobs](../02-guides/01-adding-jobs.md).
- Write handlers and tune workers: [Processing jobs](../02-guides/02-processing-jobs.md).
- Control retries: [Retries and failures](../02-guides/03-retries-and-failures.md).
