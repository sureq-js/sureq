# Graceful shutdown

When a pod stops, its workers should finish what they can and hand the rest back, so no job is lost or left waiting for a lease to run out. `queue.close()` does that, and the queue option `signals` calls it for you on `SIGTERM`.
This page sends itself `SIGTERM` while one short and one long job run, and shows what happens to each.

## Example

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { MemoryStore, Queue } from '@sureq/core'

type Email = { to: string }

const store = new MemoryStore()
const queue = new Queue<Email>('emails', {
  store,
  signals: ['SIGTERM', 'SIGINT'],
  shutdownTimeout: '500ms',
  shutdownAbortGrace: '200ms',
})

const worker = queue.process(
  async (job, ctx) => {
    console.log('start', job.id)
    try {
      await sleep(job.id === 'quick' ? 100 : 60_000, undefined, { signal: ctx.signal })
    } catch (err) {
      console.log('stopped', job.id, ctx.signal.reason?.name)
      throw err
    }
    console.log('done', job.id)
  },
  { concurrency: 2 },
)
worker.on('error', ({ error }) => console.error('worker error', error))

queue.on('closing', () => console.log('closing'))
const closed = new Promise<void>((resolve) => queue.once('closed', () => resolve()))

await queue.add({ to: 'ada@example.com' }, { id: 'quick' })
await queue.add({ to: 'alan@example.com' }, { id: 'slow' })
await sleep(50)

// What your orchestrator sends when it stops the pod.
process.kill(process.pid, 'SIGTERM')
await closed

// The store is still open, so read the jobs back.
const reader = new Queue<Email>('emails', { store })
for (const id of ['quick', 'slow']) {
  const job = await reader.getJob(id)
  console.log(id, job?.state, job?.attempt)
}
await reader.close()
await store.close()
```

Output:

```text
start quick
start slow
closing
done quick
stopped slow ShutdownError
quick completed 1
slow waiting 0
```

- On `SIGTERM` the queue calls `close()`. Its workers stop claiming, and running handlers get `shutdownTimeout` to finish. `quick` finishes in time.
- After that, `ctx.signal` aborts with `ShutdownError`, and handlers get `shutdownAbortGrace` more to stop. Then their jobs are released.
- A released job goes back to `waiting` at once, with its attempt refunded. Another worker picks `slow` up and it runs again from the start.
- A second signal exits the process with code 1 without releasing jobs. Those jobs run again when their leases run out.
- SureQ never exits the process after a clean close. Close your other resources, such as an HTTP server, and Node.js exits by itself.

## Common questions

**What `shutdownTimeout` should I pick?** Long enough for a typical job to finish, and short enough to fit your orchestrator's grace period. With the default settings `close()` can take about 28 s: 25 s of `shutdownTimeout`, 2 s of `shutdownAbortGrace`, and about 1 s for the releases. See [Worker options: shutdown](../03-reference/04-worker-options.md#shutdown). That fits the Kubernetes default `terminationGracePeriodSeconds` of 30 s. A `preStop` hook counts against the same period, so with one, or with a longer `shutdownTimeout`, raise `terminationGracePeriodSeconds` above the total. A `shutdownTimeout` set on a worker overrides the queue's.

**What if a handler ignores `ctx.signal`?** Its job is released anyway, so it may run twice at once: once here, once on another worker. Pass `ctx.signal` to your I/O. See [JobContext](../03-reference/07-job-and-context.md#jobcontext).

**Can I close by hand instead of with `signals`?** Yes. Call `await queue.close()` from your own shutdown code. `close({ timeoutMs })` replaces `shutdownTimeout` for that call.

## Reference

- [Worker options: shutdown](../03-reference/04-worker-options.md#shutdown)
- [Worker](../03-reference/04-worker-options.md#worker)
- [Queue options: workers, leases and time limits](../03-reference/01-queue.md#workers-leases-and-time-limits)
- [Queue: closing](../03-reference/01-queue.md#closing)
- [Events: pause and close](../03-reference/06-events.md#pause-and-close)
