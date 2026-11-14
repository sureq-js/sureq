# Dead letters and redrive

A job that fails for good is kept as a dead letter, with its data, its error and its attempt history. Once you fix the cause, you redrive it: the job goes back to `waiting` and runs again.
This page lets two jobs fail while the mail server is down, lists them, then redrives them.

## Example

```ts
import { Queue } from '@sureq/core'

type Email = { to: string }

const queue = new Queue<Email>('emails', {
  defaultJobOptions: { maxAttempts: 2, backoff: '100ms' },
})

let smtpUp = false

const worker = queue.process(
  async (job) => {
    if (!smtpUp) throw new Error('smtp down')
    console.log('sent', job.data.to)
  },
)

worker.on('deadLettered', ({ job, reason }) => console.log('dead letter', job.id, reason))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = () => new Promise<void>((resolve) => queue.once('drained', () => resolve()))

let idle = drained()
await queue.add({ to: 'ada@example.com' }, { id: 'ada' })
await queue.add({ to: 'alan@example.com' }, { id: 'alan' })
await idle

console.log('count', await queue.countDeadLetters())
const { jobs } = await queue.getDeadLetters({ limit: 10 })
for (const job of jobs) console.log(job.id, job.state, job.deadLetter?.reason, job.error?.message)

// The cause is fixed. Put the dead letters back.
smtpUp = true
idle = drained()
const summary = await queue.redriveAll()
console.log('redriven', summary.redriven, 'done', summary.done)
await idle

console.log('count', await queue.countDeadLetters())
const ada = await queue.getJob('ada')
console.log(ada?.state, ada?.redriveCount, ada?.lastError?.message)
await queue.close()
```

Output:

```text
dead letter ada exhausted
dead letter alan exhausted
count 2
ada failed exhausted smtp down
alan failed exhausted smtp down
redriven 2 done true
sent ada@example.com
sent alan@example.com
count 0
completed 1 smtp down
```

- A dead letter is a `failed` job with `job.deadLetter` set. Its `reason` says why it failed for good: here `exhausted`, because both attempts were used up.
- `deadLettered` fires right after `failed`, once per job.
- `getDeadLetters` lists the oldest first, a page at a time. `countDeadLetters` counts them. Both take a `reason` filter.
- `redriveAll` moves every dead letter back to `waiting`. It resets the attempt count by default, so each job gets its full `maxAttempts` again.
- A redriven job keeps its id and its history. `redriveCount` goes up by one, and `lastError` keeps the error from before the redrive.

## Common questions

**Can I redrive one job?** Yes. `queue.redrive(id)` or `job.retry()`. Pass a list of ids to `redrive` for several.

**Can I redrive later instead of now?** Yes. Pass `{ delay: '5m' }`, and the jobs wait as `delayed` first. See [Redrive](../03-reference/14-admin.md#redrive) for `priority` and `resetAttempts`.

**What can `redriveAll` filter, and what does it skip?** Pass `{ reason, olderThan }` as its first argument to pick dead letters, and `limit` and `pageSize` with the other options. It takes dead letters only, oldest first, and passes by superseded ones, whose id a newer job holds. Use `redrive(id)` for a failed job that is not a dead letter. It is not atomic: if it stops part way, the jobs already moved stay moved, so run it again for the rest. See [Redrive](../03-reference/14-admin.md#redrive).

**What reasons can a dead letter have?** `exhausted`, `unrecoverable`, `retryRejected`, `crashLimit` or `legacy` (a pod of the previous release failed it). A worker, as in the example, hears only the dead letters it makes. Those the queue's sweeper makes, such as every `crashLimit` one, reach only the queue, so listen with `queue.on('deadLettered', ...)` to hear both. A `legacy` dead letter fires no event in this release. See [Admin: dead letters](../03-reference/14-admin.md#dead-letters).

**How long are dead letters kept?** As long as `deadLetter.keep` says; see [Queue options: deadLetter](../03-reference/01-queue.md#deadletter). `clean('failed', ...)` deletes them too.

**How do I know when they pile up?** `health()` warns with `DEAD_LETTERS_HIGH` past `deadLetter.warnAbove`. See [Health and metrics](11-health-and-metrics.md).

## Reference

- [Admin: dead letters](../03-reference/14-admin.md#dead-letters)
- [Admin: redrive](../03-reference/14-admin.md#redrive)
- [Superseded dead letters](../03-reference/14-admin.md#superseded-dead-letters)
- [Queue options: deadLetter](../03-reference/01-queue.md#deadletter)
- [Events: running](../03-reference/06-events.md#running)
- [Job fields](../03-reference/07-job-and-context.md#fields)
