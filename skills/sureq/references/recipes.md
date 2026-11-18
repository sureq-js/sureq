# Recipes

Nine common tasks, each with a complete sample for `@sureq/core` 1.0.0.
A sample whose first line is `// runs: memory` needs no database: it runs as it is, on the in-memory store, and exits.
The other samples need a durable store; they show it as a `store` value you create once per process.

### Send an email with retries

Send each email in its own job, retry a failure that may pass, and fail a bad address at once.

```ts
// runs: memory
import { Queue, UnrecoverableError } from '@sureq/core'

type Email = { to: string; subject: string }

const queue = new Queue<Email, { sent: true }>('emails', {
  logger: false,
  defaultJobOptions: { maxAttempts: 5, backoff: { type: 'exponential', delay: '50ms', maxDelay: '1m' } },
})

let busy = 2
const worker = queue.process(async (job) => {
  if (!job.data.to.includes('@')) throw new UnrecoverableError('invalid address')
  // Pass job.idempotencyKey to the mail API, so a repeated attempt sends no second email.
  if (busy-- > 0) throw new Error('mail server busy')
  console.log('sent', job.data.to, 'key', job.idempotencyKey)
  return { sent: true }
}, { acknowledgeVolatileStore: true })

worker.on('retrying', ({ job, delayMs }) => console.log(job.id, 'retry in', delayMs, 'ms'))
worker.on('failed', ({ job, reason }) => console.log(job.id, 'failed:', reason))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))
await queue.add({ to: 'ada@example.com', subject: 'Welcome' }, { id: 'welcome-ada' })
await queue.add({ to: 'nobody', subject: 'Welcome' }, { id: 'welcome-nobody' })
await drained
await queue.close()
```

Set `maxAttempts` on purpose (the default is 3) and throw `UnrecoverableError` for an error no retry can fix, so a bad address does not use up every attempt.

### A delayed and prioritised job

Run a reminder later, and let a password reset jump ahead of the newsletters already waiting.

```ts
// runs: memory
import { Queue } from '@sureq/core'

type Email = { to: string; subject: string }

const queue = new Queue<Email>('emails', { logger: false })

await queue.add({ to: 'ada@example.com', subject: 'Reminder' }, { delay: '300ms' })
await queue.add({ to: 'alan@example.com', subject: 'Newsletter' })
await queue.add({ to: 'grace@example.com', subject: 'Newsletter' })
await queue.add({ to: 'linus@example.com', subject: 'Password reset' }, { priority: 10 })
console.log(await queue.getCounts())

const worker = queue.process(async (job) => console.log(job.data.subject, 'to', job.data.to), {
  acknowledgeVolatileStore: true,
})
worker.on('error', ({ error }) => console.error('worker error', error))

// The reminder runs last, once its delay is over.
await new Promise<void>((resolve) =>
  queue.on('completed', ({ job }) => {
    if (job.data.subject === 'Reminder') resolve()
  }),
)
await queue.close()
```

A higher `priority` runs first, and `delay` keeps a job out of reach until its time; set `delay` or `runAt`, not both, and do not sleep inside a handler to wait.

### A recurring schedule with upsertSchedule

Send a digest on a fixed rule, defined in code and safe to define again on every start-up.

```ts
// runs: memory
import { Queue } from '@sureq/core'

type Digest = { to: string }

const queue = new Queue<Digest>('digests', { logger: false })

// The same definition on every start-up answers 'unchanged'; it never adds a second schedule.
const result = await queue.upsertSchedule('team-digest', {
  every: '1s',
  template: { data: { to: 'team@example.com' } },
})
console.log('schedule', result.action)

// A cron rule in a time zone; previewSchedule stores nothing.
const next = await queue.previewSchedule({ cron: '0 7 * * 1-5', tz: 'Europe/Berlin' }, 2)
console.log(next.map((t) => new Date(t).toISOString()))

let finish!: () => void
const done = new Promise<void>((resolve) => (finish = resolve))
// A worker on the queue also runs the scheduler.
const worker = queue.process(async (job) => {
  console.log('digest for', job.data.to, 'from', job.schedule?.key)
  finish()
}, { acknowledgeVolatileStore: true })
worker.on('error', ({ error }) => console.error('worker error', error))

await done
await queue.deleteSchedule('team-digest')
await queue.close()
```

The schedule key is what matters: `upsertSchedule` with the same key updates one schedule, so a loop of `add` calls with timers, which repeats on every pod, is never needed.

### A batch worker

Hand jobs to the handler in groups, for an API that takes many items in one call.

```ts
// runs: memory
import { Queue, TaskFailure } from '@sureq/core'

type Email = { to: string }

const queue = new Queue<Email, { sent: true }>('emails', { logger: false })

const worker = queue.processBatch(
  async (batch) => {
    console.log('batch of', batch.jobs.length)
    // Return one result per job, in the same order.
    return batch.jobs.map((job) =>
      job.data.to.includes('@') ? { sent: true as const } : new TaskFailure(new Error('bad address'), { retry: false }),
    )
  },
  { batchSize: 3, batchDelay: '50ms', acknowledgeVolatileStore: true },
)
worker.on('failed', ({ job, error }) => console.log(job.data.to, 'failed:', error.message))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))
await queue.addBulk(['ada@example.com', 'alan@example.com', 'nobody', 'grace@example.com'].map((to) => ({ data: { to } })))
await drained
await queue.close()
```

`batchSize` is required and caps each call; return a `TaskFailure` for one bad job instead of throwing, because a throw fails every job in the batch.

### A dead letter and redrive

Find the jobs that used up their attempts, fix the cause, and put them back.

```ts
// runs: memory
import { Queue } from '@sureq/core'

type Email = { to: string }

const queue = new Queue<Email>('emails', { logger: false, defaultJobOptions: { maxAttempts: 2, backoff: '50ms' } })

let smtpUp = false
const worker = queue.process(async (job) => {
  if (!smtpUp) throw new Error('smtp down')
  console.log('sent', job.data.to)
}, { acknowledgeVolatileStore: true })
worker.on('deadLettered', ({ job, reason }) => console.log('dead letter', job.id, reason))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = () => new Promise<void>((resolve) => queue.once('drained', () => resolve()))
let idle = drained()
await queue.add({ to: 'ada@example.com' }, { id: 'ada' })
await idle

const { jobs } = await queue.getDeadLetters({ limit: 10 })
for (const job of jobs) console.log(job.id, job.deadLetter?.reason, job.error?.message)

// The cause is fixed: move the job back. redriveAll() moves every dead letter.
smtpUp = true
idle = drained()
const outcome = await queue.redrive('ada')
console.log('redrive', outcome.status)
await idle
console.log('state', (await queue.getJob('ada'))?.state, 'dead letters', await queue.countDeadLetters())
await queue.close()
```

`redrive` resets the attempt count by default (`resetAttempts: true`); redrive only after the cause is fixed, or the jobs fail again and come straight back.

### A graceful shutdown on SIGTERM

Let running jobs finish when the orchestrator stops the pod, and stop the rest cleanly.

```ts
// runs: memory
import { setTimeout as sleep } from 'node:timers/promises'
import { Queue } from '@sureq/core'

type Report = { name: string }

const queue = new Queue<Report>('reports', {
  logger: false,
  signals: ['SIGTERM', 'SIGINT'],
  shutdownTimeout: '500ms',
})

const worker = queue.process(async (job, ctx) => {
  // Pass ctx.signal on, so a long step stops when the shutdown timeout runs out.
  await sleep(job.data.name === 'quick' ? 50 : 60_000, undefined, { signal: ctx.signal })
  console.log('done', job.data.name)
}, { concurrency: 2, acknowledgeVolatileStore: true })
worker.on('error', ({ error }) => console.error('worker error', error))

const closed = new Promise<void>((resolve) => queue.once('closed', () => resolve()))
await queue.add({ name: 'quick' })
await queue.add({ name: 'slow' })
await sleep(20)

// What the orchestrator sends when it stops the pod.
process.kill(process.pid, 'SIGTERM')
await closed
console.log('closed')
```

Keep `shutdownTimeout` shorter than the orchestrator's grace period, and pass `ctx.signal` to slow calls; a job cut off at shutdown is not lost: it goes back to waiting with its attempt refunded.

### A producer-only web pod

Add jobs from a web server that runs no worker, sharing the worker pods' durable store.

```ts
import { createServer } from 'node:http'
import type { Store } from '@sureq/core'
import { Producer } from '@sureq/core/producer'

type Email = { to: string }

// Your durable store, created once per process.
declare const store: Store

// One producer for the whole process, never one per request.
const producer = new Producer<Email>('emails', { store, namespace: 'production' })
producer.on('error', ({ error }) => console.error('producer error', error))
await producer.ready()

const server = createServer(async (req, res) => {
  const to = new URL(req.url ?? '/', 'http://localhost').searchParams.get('to')
  if (!to) return void res.writeHead(400).end()
  const { job } = await producer.add({ to })
  res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ id: job.id }))
})
server.listen(3000)

process.once('SIGTERM', () => {
  server.close()
  void producer.close()
})
```

The queue name and `namespace` must match the worker pods exactly, or the jobs wait where no worker looks; and create the producer once, not per request.

### A health endpoint

Answer the orchestrator's liveness and readiness probes from the queue's own health report.

```ts
// runs: memory
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Queue } from '@sureq/core'

const queue = new Queue<{ to: string }>('emails', { logger: false })
const worker = queue.process(async () => {}, { acknowledgeVolatileStore: true })
worker.on('error', ({ error }) => console.error('worker error', error))

const server = createServer(async (req, res) => {
  if (req.url !== '/livez' && req.url !== '/readyz') return void res.writeHead(404).end()
  const report = await queue.health()
  // Liveness never depends on the store; readiness does.
  const ok = req.url === '/livez' ? report.live : report.ready
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(report))
})
await new Promise<void>((resolve) => server.listen(0, resolve))
const { port } = server.address() as AddressInfo

for (const path of ['/livez', '/readyz']) {
  const res = await fetch(`http://localhost:${port}${path}`)
  const report = (await res.json()) as { status: string }
  console.log(path, res.status, report.status)
}

server.close()
await queue.close()
```

Use `live` for the liveness probe and `ready` for the readiness probe; a liveness probe that checks the store restarts every pod when the database blips.

### A test with the in-memory store

Test a handler through a real queue on a fresh `MemoryStore`, with real timers and no mocks.

```ts
// runs: memory
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { MemoryStore, Queue, type JobHandler } from '@sureq/core'

type Email = { to: string }

// The code under test; in your app it lives in its own module.
const sendEmail: JobHandler<Email, { ok: true }> = async (job, ctx) => {
  if (!job.data.to.includes('@')) ctx.fail(new Error('bad address'), { retry: false })
  if (ctx.attempt === 1 && job.data.to.startsWith('flaky')) throw new Error('smtp busy')
  return { ok: true }
}

let store: MemoryStore
let queue: Queue<Email, { ok: true }>

beforeEach(() => {
  store = new MemoryStore()
  queue = new Queue('emails', { store, logger: false, defaultJobOptions: { backoff: 10 } })
  queue.process(sendEmail, { acknowledgeVolatileStore: true })
})

afterEach(async () => {
  await queue.close()
  await store.close()
})

// Listen before the add, so the final event cannot be missed.
const settled = (id: string) =>
  new Promise<string>((resolve) => {
    queue.on('completed', ({ job }) => {
      if (job.id === id) resolve('completed')
    })
    queue.on('failed', ({ job }) => {
      if (job.id === id) resolve('failed')
    })
  })

test('sends after one retry', async () => {
  const done = settled('a')
  await queue.add({ to: 'flaky@example.com' }, { id: 'a', maxAttempts: 3 })
  assert.equal(await done, 'completed')
  assert.equal((await queue.getJob('a'))?.attempt, 2)
})

test('fails a bad address at once', async () => {
  const done = settled('b')
  await queue.add({ to: 'nobody' }, { id: 'b', maxAttempts: 3 })
  assert.equal(await done, 'failed')
  assert.equal((await queue.getJob('b'))?.deadLetter?.reason, 'unrecoverable')
})
```

Give each test its own store and queue, and set `acknowledgeVolatileStore: true` only here in tests; in production it hides the warning that every job is lost on restart.
