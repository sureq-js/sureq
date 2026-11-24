# Batches

A batch worker hands your handler several jobs at once, for work that is cheaper in bulk. Each job still keeps its own attempts, retries and result.
This page sends five emails in batches of up to three, and fails one of them on its own.

## Example

```ts
import { Queue, TaskFailure } from '@sureq/core'

type Email = { to: string }

const queue = new Queue<Email, { sent: true }>('emails')

async function send(to: string, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!to.includes('@')) throw new Error(`bad address ${to}`)
  return { sent: true } as const
}

const worker = queue.processBatch(
  async (batch) => {
    console.log('batch of', batch.jobs.length)
    const results = []
    for (const job of batch.jobs) {
      try {
        results.push(await send(job.data.to, job.signal))
      } catch (err) {
        // Fail this job only. retry: false makes it final.
        results.push(new TaskFailure(err, { retry: false }))
      }
    }
    return results
  },
  { batchSize: 3, batchDelay: '100ms' },
)

worker.on('completed', ({ job }) => console.log(job.data.to, 'sent'))
worker.on('failed', ({ job, error }) => console.log(job.data.to, 'failed:', error.message))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))

await queue.addBulk(
  ['ada@example.com', 'alan@example.com', 'nobody', 'grace@example.com', 'linus@example.com'].map((to) => ({ data: { to } })),
)

await drained
await queue.close()
```

Output:

```text
store is not durable; jobs are lost on restart { queue: 'emails' }
batch of 3
ada@example.com sent
alan@example.com sent
nobody failed: bad address nobody
batch of 2
grace@example.com sent
linus@example.com sent
```

- `batchSize: 3` is the most jobs per handler call. The last batch held the two jobs that were left.
- `batchDelay: '100ms'` lets a part-full batch wait a little for more jobs before it runs.
- The handler returns one element per job, in `batch.jobs` order. A value completes that job; a `TaskFailure` fails only that job.
- `job.signal` is per job. It aborts when that one job is cancelled or loses its lease, and the other jobs carry on.

## Common questions

**What if the handler throws?** Every job in the batch that is not settled yet fails with that error, each by its own retry rules. Catch per job and return a `TaskFailure` instead.

**Can I settle jobs one by one as I go?** Yes. Call `ctx.complete(job, result)` or `ctx.fail(job, err)` from the second handler argument. The write goes out at once.

**Can a batch worker run named jobs?** No. It takes unnamed jobs only.

**What does `concurrency` mean here?** It counts batches, not jobs.

## Reference

- [Batch worker](../03-reference/05-batch-worker.md)
- [Batch worker options](../03-reference/05-batch-worker.md#batch-worker-options)
- [The handler](../03-reference/05-batch-worker.md#the-handler)
- [BatchContext](../03-reference/05-batch-worker.md#batchcontext)
- [TaskFailure](../03-reference/05-batch-worker.md#taskfailure)
