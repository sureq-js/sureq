# Duplicates and unique ids

Give a job your own id, and a second add with the same id does not make a second job. You choose what that second add does instead.
This page sends one welcome email per user, tries to add it again in several ways, and uses a singleton key.

## Example

```ts
import { DuplicateJobError, Queue } from '@sureq/core'

type Welcome = { user: string; to: string }

// Every job's id comes from its data: one welcome email per user.
const queue = new Queue<Welcome>('emails', { id: (data) => `welcome-${data.user}` })

const a = await queue.add({ user: 'ada', to: 'ada@example.com' })
console.log(a.added, a.job.id)

// Same id. With no `onDuplicate` set, the first job is kept.
const b = await queue.add({ user: 'ada', to: 'ada@work.example.com' })
console.log(b.added, b.duplicate?.action, b.job.data.to)

// 'replace' swaps the data of a job that has not started yet.
const c = await queue.add({ user: 'ada', to: 'ada@work.example.com' }, { onDuplicate: 'replace' })
console.log(c.added, c.duplicate?.action, c.job.data.to)

// 'reject' throws instead.
try {
  await queue.add({ user: 'ada', to: 'ada@example.com' }, { onDuplicate: 'reject' })
} catch (err) {
  console.log(err instanceof DuplicateJobError)
}

// At most one waiting job per singleton key, whatever its id.
await queue.add({ user: 'alan', to: 'alan@example.com' }, { singletonKey: 'sync' })
const d = await queue.add({ user: 'grace', to: 'grace@example.com' }, { singletonKey: 'sync' })
console.log(d.added, d.duplicate?.by, d.job.id)

// The idempotency key is the same on every attempt of a job.
console.log(a.job.idempotencyKey)
console.log((await queue.getCounts()).waiting)
await queue.close()
```

Output:

```text
true welcome-ada
false ignored ada@example.com
false replaced ada@work.example.com
true
false singletonKey welcome-alan
default:emails:welcome-ada:1
2
```

- The queue option `id` makes each job's id from its data. You can also pass `id` on a single add.
- An add whose id is taken returns `added: false` and a `duplicate` with the `action` taken. The queue also emits `duplicate`.
- `onDuplicate` can be `'ignore'`, `'replace'`, `'reject'` or a function that merges the old and new data. Set it per add or on the queue.
- `singletonKey` allows one waiting or delayed job per key. Grace's add returned Alan's job, because it held the key.
- At the end two jobs are waiting: Ada's welcome and Alan's.

## Common questions

**How long does a job hold its id?** As long as `uniqueWhile` says. See [Job options: Duplicates](../03-reference/02-job-options.md#duplicates).

**Can a running job be replaced?** No. An add for a job that already started reports `ignored`, with `existingState: 'active'`.

**Must a merge function be pure?** Yes. It may run more than once.

**Does a unique id stop a job from running twice?** No. A job can still run again after a crash. Pass `job.idempotencyKey` to outside APIs so a second run has no second effect.

## Reference

- [Job options: identity](../03-reference/02-job-options.md#identity)
- [Job options: duplicates](../03-reference/02-job-options.md#duplicates)
- [Queue options: adding jobs](../03-reference/01-queue.md#adding-jobs)
- [Events: adding](../03-reference/06-events.md#adding)
- [Errors](../03-reference/08-errors.md)
