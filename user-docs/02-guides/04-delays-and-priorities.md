# Delays and priorities

A job can wait before it runs: give it a `delay` or a `runAt` time. Among jobs that are ready, a higher `priority` runs first.
This page adds five jobs before a worker starts, so you can see the order they run in.

## Example

```ts
import { Queue } from '@sureq/core'

type Email = { to: string; subject: string }

const queue = new Queue<Email>('emails')

// Add every job before a worker starts, so the order is easy to see.
await queue.add({ to: 'ada@example.com', subject: 'Reminder' }, { delay: '500ms' })
await queue.add({ to: 'alan@example.com', subject: 'Newsletter' })
await queue.add({ to: 'grace@example.com', subject: 'Newsletter' })
await queue.add({ to: 'linus@example.com', subject: 'Password reset' }, { priority: 10 })
await queue.add({ to: 'barbara@example.com', subject: 'Newsletter' }, { first: true })

const { waiting, delayed } = await queue.getCounts()
console.log({ waiting, delayed })

const started = Date.now()
const worker = queue.process(async (job) =>
  console.log(`${Date.now() - started >= 500 ? 'late ' : 'now  '}${job.data.subject} to ${job.data.to}`),
)
worker.on('error', ({ error }) => console.error('worker error', error))

await new Promise<void>((resolve) => queue.once('drained', () => resolve()))
await queue.close()
```

Output:

```text
{ waiting: 4, delayed: 1 }
now  Password reset to linus@example.com
now  Newsletter to barbara@example.com
now  Newsletter to alan@example.com
now  Newsletter to grace@example.com
late Reminder to ada@example.com
```

- The job with `delay: '500ms'` is `delayed` until its time comes, then `waiting`. It ran last, after the wait.
- `priority: 10` put the password reset ahead of the jobs with no priority.
- Jobs of the same priority run in the order they were added, unless the queue uses `order: 'lifo'`. `first: true` put Barbara's job at the front of its level.
- A delay is a `Duration`: whole milliseconds, or a string such as `'30s'` or `'5m'`.

## Common questions

**How do I run a job at a set time?** Pass `runAt` with a `Date` or epoch milliseconds. A time in the past runs now. Set `delay` or `runAt`, not both.

**Whose clock times the delay?** The store's, not the pod's. Pods with skewed clocks still agree on when a job is due.

**Can a high priority job stop a running one?** No. Priority only decides which waiting job a free worker claims next.

**Can I give every job of a queue the same priority?** Yes, set `priority` in `defaultJobOptions`. To run newest first among equals, use the queue option `order: 'lifo'`.

## Reference

- [Job options: timing and order](../03-reference/02-job-options.md#timing-and-order)
- [Durations](../03-reference/01-queue.md#durations)
- [Queue options: adding jobs](../03-reference/01-queue.md#adding-jobs)
- [Job defaults](../03-reference/02-job-options.md#job-defaults)
