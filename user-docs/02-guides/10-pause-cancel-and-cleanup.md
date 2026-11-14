# Pause, cancel and cleanup

You can stop a whole queue for a while with `pause()`, stop one job with `cancel(id)`, and delete old jobs with `clean`. Pause and cancel work while workers run, on every pod.
This page pauses a queue, cancels one waiting and one running job, resumes, then cleans up.

## Example

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { Queue } from '@sureq/core'

type Email = { to: string }

const queue = new Queue<Email>('emails')

// Pause first, so the worker claims nothing yet.
await queue.pause()

const worker = queue.process(
  async (job, ctx) => {
    console.log('start', job.id)
    await sleep(job.id === 'slow' ? 10_000 : 50, undefined, { signal: ctx.signal })
    console.log('done', job.id)
  },
)
worker.on('error', ({ error }) => console.error('worker error', error))

await queue.add({ to: 'ada@example.com' }, { id: 'ada' })
await queue.add({ to: 'alan@example.com' }, { id: 'alan' })
await queue.add({ to: 'grace@example.com' }, { id: 'slow' })
console.log('blocked', (await queue.getCounts()).blocked)

// A waiting job can be cancelled before it ever runs.
const res = await queue.cancel('alan')
console.log('cancel alan', res.cancelled)

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))
const slowStarted = new Promise<void>((resolve) =>
  queue.on('active', ({ job }) => {
    if (job.id === 'slow') resolve()
  }),
)
await queue.resume()

// A running job can be cancelled too: its ctx.signal aborts.
await slowStarted
console.log('cancel slow', (await queue.cancel('slow')).cancelled)
await drained

console.log(await queue.getCounts())
console.log('cleaned', await queue.clean('completed', 0), await queue.clean('cancelled', 0))
await queue.close()
```

Output:

```text
blocked 3
cancel alan true
start ada
done ada
start slow
cancel slow true
{
  waiting: 0,
  delayed: 0,
  active: 0,
  completed: 1,
  failed: 0,
  cancelled: 2,
  blocked: 0
}
cleaned { removed: 1, done: true } { removed: 2, done: true }
```

- `pause()` sets a flag in the store. No worker on any pod claims a job until `resume()`. Adds still work, and `getCounts().blocked` counts the waiting jobs held back.
- Cancelling a waiting job makes it `cancelled` at once. It never runs.
- Cancelling a running job aborts its `ctx.signal`, so `sleep` stops early. `done slow` is never printed, and the job is not counted as `failed` or retried.
- `clean(state, olderThan)` deletes jobs in one state that are at least that old. `0` matches all of them. Deleted jobs cannot be brought back.

## Common questions

**Does pause stop running jobs?** No. They finish normally. Cancel them if they must stop.

**Can I pause one worker only?** Yes. `worker.pause()` stops that worker and leaves the rest of the queue running. See [Worker](../03-reference/04-worker-options.md#worker).

**Do I have to clean finished jobs myself?** No. Retention deletes them on a timer on worker pods. Use `clean` for a one-off cleanup. See [Queue options: retention](../03-reference/01-queue.md#retention).

**What is the difference between `drain` and `obliterate`?** `drain()` deletes the waiting jobs. `obliterate()` deletes the whole queue: every job, dead letter and schedule. See [Clean, drain and obliterate](../03-reference/14-admin.md#clean-drain-and-obliterate).

## Reference

- [Admin: cancel and remove](../03-reference/14-admin.md#cancel-and-remove)
- [Admin: pause and resume](../03-reference/14-admin.md#pause-and-resume)
- [Admin: clean, drain and obliterate](../03-reference/14-admin.md#clean-drain-and-obliterate)
- [Queue: pausing](../03-reference/01-queue.md#pausing)
- [Events: managing jobs](../03-reference/06-events.md#managing-jobs)
- [Events: pause and close](../03-reference/06-events.md#pause-and-close)
