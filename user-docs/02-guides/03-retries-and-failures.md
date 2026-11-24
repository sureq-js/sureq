# Retries and failures

When a handler throws, SureQ retries the job after a wait, until its attempts are used up. Some errors should never be retried, and you can say so.
This page runs one job that succeeds on its third try, one that runs out of attempts and one that fails at once.

## Example

```ts
import { Queue, UnrecoverableError } from '@sureq/core'

type Email = { to: string }

const queue = new Queue<Email>('emails', {
  defaultJobOptions: { maxAttempts: 3, backoff: '200ms' },
})

const worker = queue.process(
  async (job, ctx) => {
    if (job.data.to === 'nobody') throw new UnrecoverableError('invalid address')
    if (job.data.to === 'bounce@example.com') throw new Error('mailbox full')
    if (ctx.attempt < 3) throw new Error('mail server busy')
  },
)

worker.on('retrying', ({ job, error, delayMs }) => console.log(job.id, 'retry in', delayMs, 'ms:', error.message))
worker.on('completed', ({ job }) => console.log(job.id, 'completed on attempt', job.attempt))
worker.on('failed', ({ job, reason, error }) => console.log(job.id, 'failed:', reason, error.message))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))

await queue.add({ to: 'ada@example.com' }, { id: 'busy' })
await queue.add({ to: 'bounce@example.com' }, { id: 'bounce' })
await queue.add({ to: 'nobody' }, { id: 'bad' })

await drained
const { attempts } = await queue.getAttempts('bounce')
for (const r of attempts) {
  console.log('bounce attempt', r.attempt, r.outcome)
}
await queue.close()
```

Output:

```text
store is not durable; jobs are lost on restart { queue: 'emails' }
busy retry in 200 ms: mail server busy
bounce retry in 200 ms: mailbox full
bad failed: unrecoverable invalid address
busy retry in 200 ms: mail server busy
bounce retry in 200 ms: mailbox full
busy completed on attempt 3
bounce failed: attempts-exhausted mailbox full
bounce attempt 1 failed
bounce attempt 2 failed
bounce attempt 3 failed
```

- `maxAttempts: 3` counts the first run, so a job runs at most three times.
- `backoff: '200ms'` waits the same 200 ms before every retry. Leave `backoff` out to get the default, which grows with each attempt. See [BackoffSpec](../03-reference/03-retry-and-backoff.md#backoffspec).
- `retrying` fires each time a failed attempt will run again. `failed` fires once, when the job fails for good. Its `reason` says why.
- `UnrecoverableError` skips the retries. The job fails at once with reason `unrecoverable`.
- Each attempt leaves a record. `queue.getAttempts(id)` or `job.getAttempts()` reads them.

## Common questions

**How many attempts does a job get by default?** Three, the first run included. Set `maxAttempts` on the add, or in `defaultJobOptions` for every add. See [Job options: retries and time limits](../03-reference/02-job-options.md#retries-and-time-limits).

**How do I retry only some errors?** Give the worker a `retryIf(err, job)` function. Return `false` to fail the job for good. See [Worker options: retries](../03-reference/04-worker-options.md#retries).

**Can I fail a job for good without throwing `UnrecoverableError`?** Yes. Call `ctx.fail(err, { retry: false })` in the handler.

**Can a worker change the backoff of a job?** Not the spec. `maxAttempts` and `backoff` are stored on the job when it is added, so every worker uses the same ones. But a worker registers the functions behind custom strategy names, with `backoffStrategies`. See [Custom strategies](../03-reference/03-retry-and-backoff.md#custom-strategies).

**Where does a job go when it fails for good?** It stays `failed`. By default it is also kept as a dead letter, with its data and error. See [Admin: dead letters](../03-reference/14-admin.md#dead-letters).

## Reference

- [Retry and backoff](../03-reference/03-retry-and-backoff.md)
- [The retry decision](../03-reference/03-retry-and-backoff.md#the-decision)
- [BackoffSpec](../03-reference/03-retry-and-backoff.md#backoffspec)
- [Job options: retries and time limits](../03-reference/02-job-options.md#retries-and-time-limits)
- [Attempt records](../03-reference/07-job-and-context.md#attempt-records)
- [Errors](../03-reference/08-errors.md)
