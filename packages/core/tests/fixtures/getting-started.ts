// The README "Getting started" snippet, verbatim between the markers (checked by tests/unit/readme.test.ts),
// run by the readme test and type-checked by the consumer smoke test under node16, nodenext and bundler.
/* eslint-disable @typescript-eslint/no-unused-vars -- README text is fixed; it names ctx to point at ctx.signal */
// --- snippet start
import { Queue, UnrecoverableError } from '@sureq/core'

type Email = { to: string; subject: string }

// With no `store` option the queue creates its own in-memory store.
const queue = new Queue<Email, { sent: true }>('emails', {
  defaultJobOptions: { maxAttempts: 5 },
})

const worker = queue.process(
  async (job, ctx) => {
    if (!job.data.to.includes('@')) throw new UnrecoverableError('invalid address') // never retried
    // ... send the email; pass ctx.signal to your client
    return { sent: true }
  },
  { concurrency: 5 },
)

worker.on('completed', ({ job, result }) => console.log(job.id, 'sent', result))
worker.on('failed', ({ job, reason }) => console.log(job.id, 'failed:', reason))
worker.on('error', ({ error }) => console.error(error))

const drained = new Promise<void>((resolve) => queue.on('drained', () => resolve()))

await queue.add({ to: 'ada@example.com', subject: 'Welcome' })
await queue.add(
  { to: 'alan@example.com', subject: 'Later' },
  { delay: '1s', backoff: { type: 'exponential', delay: '2s', factor: 3, jitter: 'none', maxDelay: '10m' } },
)
await queue.add({ to: 'not-an-email', subject: 'Oops' })

await drained
console.log(await queue.getCounts())
await queue.close()
// --- snippet end
export {}
