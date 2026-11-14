# Adding jobs

A job is one piece of work: some JSON data plus options. You add it with `queue.add`, or many at once with `queue.addBulk`.
This page adds jobs and reads them back. No worker runs here, so the jobs stay `waiting`.

## Example

```ts
import { Queue } from '@sureq/core'

type Email = { to: string; subject: string }

const queue = new Queue<Email>('emails', {
  defaultJobOptions: { maxAttempts: 5 },
})

// One job. SureQ makes the id.
const { job, added } = await queue.add({ to: 'ada@example.com', subject: 'Welcome' })
console.log(added, job.state, job.maxAttempts)

// Your own id and a name.
await queue.add({ to: 'alan@example.com', subject: 'Welcome' }, { id: 'welcome-alan', name: 'welcome' })

// Many jobs in one call. Each item has `data` and optional `opts`.
const outcomes = await queue.addBulk([
  { data: { to: 'grace@example.com', subject: 'Digest' } },
  { data: { to: 'linus@example.com', subject: 'Digest' }, opts: { name: 'digest' } },
])
console.log(outcomes.map((o) => o.ok))

const stored = await queue.getJob('welcome-alan')
console.log(stored?.name, stored?.data.to)
console.log(await queue.getCounts())
await queue.close()
```

Output:

```text
true waiting 5
[ true, true ]
welcome alan@example.com
{
  waiting: 4,
  delayed: 0,
  active: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  blocked: 0
}
```

- `add` returns `{ job, added }`. `job` is a snapshot of the stored job. `added` is `false` when another job already holds the id. See [Duplicates and unique ids](07-duplicates-and-unique-ids.md).
- `defaultJobOptions` applies to every add that does not set the option itself. Here every job gets `maxAttempts: 5`.
- `addBulk` returns one outcome per item, in input order. An item that fails has `ok: false` and an `error`; the others are still added.
- `getJob` reads the job fresh from the store, or returns `null` for an unknown id. A job that retention or `remove` has deleted is unknown too, so it also gives `null`. Once a finished job's id is reused by a new add, `getJob` returns the new job.

This page adds and reads jobs only, on purpose. To run them, call `queue.process(handler)` in this process (see [Processing jobs](02-processing-jobs.md)), or run a worker in another process that shares a durable store with this one (see [Producer-only pods](12-producer-only-pods.md)). This queue is given no `store`, so it keeps its jobs in its own in-memory store: they live in this process only, and are lost on `close()`.

## Common questions

**Can I add a job before any worker runs?** Yes. Jobs wait in the store until a worker claims them.

**What can job data be?** Any value JSON can store. It is serialized when you add it, and must fit `maxPayloadBytes`: 1 MiB by default, counted as the UTF-8 bytes of its JSON. Set it on the queue or the producer; an add cannot change it. A larger `add` throws `PayloadTooLargeError` and stores nothing. See [Queue options: adding jobs](../03-reference/01-queue.md#adding-jobs).

**What is a job name for?** It picks the handler when a worker runs several kinds of job. A name is optional. A job without one is unnamed (`job.name` is `null`) and runs on `queue.process(handler)`. A named job runs only on a worker that has a handler for that name. See [Named jobs](../03-reference/01-queue.md#named-jobs) and [Job options: identity](../03-reference/02-job-options.md#identity).

**Can `addBulk` add all or nothing?** Yes, pass `{ atomic: true }` as its second argument. One refused item then refuses the whole call with `BulkAddError`, whose `index` names the item, and nothing is stored. A store without `transactions` throws `CapabilityError` instead. The rare cases that can leave items stored are listed under [Queue: adding](../03-reference/01-queue.md#adding). See [Errors: adding jobs](../03-reference/08-errors.md#adding-jobs).

## Reference

- [Queue: adding](../03-reference/01-queue.md#adding)
- [Queue options: adding jobs](../03-reference/01-queue.md#adding-jobs)
- [Job options](../03-reference/02-job-options.md)
- [Job defaults](../03-reference/02-job-options.md#job-defaults)
- [Job fields](../03-reference/07-job-and-context.md#job)
