# Progress and long jobs

A handler can report how far it got with `ctx.progress`. Long jobs also need a lease long enough to survive, and maybe a time limit.
This page exports files with progress, and gives a second job a timeout it cannot meet.

## Example

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { Queue } from '@sureq/core'

type Export = { files: string[] }

// A longer lease for long jobs. The worker renews it while the handler runs.
const queue = new Queue<Export>('exports', { leaseDuration: '2m' })

const worker = queue.process(
  async (job, ctx) => {
    const { files } = job.data
    for (const [i, file] of files.entries()) {
      await sleep(300, undefined, { signal: ctx.signal }) // stops on timeout, cancel or shutdown
      await ctx.progress(i + 1, files.length, `exported ${file}`)
    }
  },
)

worker.on('progress', ({ job, progress }) => {
  if (progress.kind === 'counter') console.log(job.id, `${progress.percent?.toFixed(0)}%`, progress.message)
})
worker.on('completed', ({ job }) => console.log(job.id, 'completed'))
worker.on('failed', ({ job, error }) => console.log(job.id, 'failed:', error.name))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))

await queue.add({ files: ['a.csv', 'b.csv', 'c.csv', 'd.csv'] }, { id: 'export-1' })
// This one gets 500 ms in total, and one attempt.
await queue.add({ files: ['e.csv', 'f.csv', 'g.csv'] }, { id: 'export-2', timeout: 500, maxAttempts: 1 })

await drained
const job = await queue.getJob('export-1')
if (job?.progress?.kind === 'counter') console.log(job.progress.n, job.progress.total, job.progress.etaMs)
await queue.close()
```

Output:

```text
export-1 25% exported a.csv
export-1 50% exported b.csv
export-1 75% exported c.csv
export-1 100% exported d.csv
export-1 completed
export-2 33% exported e.csv
export-2 failed: JobTimeoutError
4 4 0
```

- `ctx.progress(n, total, message)` reports a counter. You can also pass any small JSON object, such as `{ stage: 'upload' }`.
- Each value is stored on the job, so `getJob` shows it from any pod. A counter with a `total` also gets a `percent` and an ETA (`etaMs`), which is `0` once `n` reaches `total`.
- `await` each `ctx.progress` call. It rejects when the lease is lost or the job is cancelled.
- `timeout: 500` aborted `ctx.signal` with `JobTimeoutError` half a second after the handler started. The sleep stopped, and the attempt failed.
- `leaseDuration` is how long a claimed job is held before another worker may take it. The worker renews the lease while the handler runs, so a job may run far longer than its lease.

## Common questions

**Why did my long job run twice?** Its lease probably ran out. A handler that keeps the CPU busy without an `await` stops the renewals. Add `await` inside long loops, or give that job name a longer lease with `leaseDurationByName`.

**What lease does a job get?** 30 s unless you set one. For a named job SureQ uses the first it finds: the worker's `leaseDurationByName`, the queue's `leaseDurationByName`, the worker's `leaseDuration`, the queue's `leaseDuration`. An unnamed job skips the `leaseDurationByName` steps. Each value must be from 1 s to 1 d. See [Worker options: leases](../03-reference/04-worker-options.md#leases).

**What if my handler ignores `ctx.signal` after a timeout?** It is given a short grace period (`timeoutGrace`). Then the attempt fails anyway and its late result is ignored.

**Does a retry keep the old progress?** No. Progress starts from `null` on each attempt. A finished job keeps its last value.

**Why do I see fewer progress events than calls?** Calls closer together than `progressInterval` are merged; the latest value wins.

## Reference

- [JobContext](../03-reference/07-job-and-context.md#jobcontext)
- [Progress](../03-reference/07-job-and-context.md#progress)
- [Worker options: leases](../03-reference/04-worker-options.md#leases)
- [Worker options: time limits](../03-reference/04-worker-options.md#time-limits)
- [Worker options: progress](../03-reference/04-worker-options.md#progress)
- [Events: running](../03-reference/06-events.md#running)
