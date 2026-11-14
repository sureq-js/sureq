// The README "Producer-only processes" sample, verbatim between the markers (checked by tests/unit/readme.test.ts)
// and type-checked with the package.
import { MemoryStore, Queue } from '@sureq/core'

const store = new MemoryStore()
// --- snippet start
// api.ts: adds and reads only; no worker, sweeper, scheduler or timer in this process
import { Producer } from '@sureq/core/producer'

const emails = new Producer<{ to: string }>('emails', { store, namespace: 'shop' })
const { job } = await emails.add({ to: 'a@example.com' }, { maxAttempts: 5 })
console.log((await emails.getJob(job.id))?.state)
await emails.upsertSchedule('digest', { cron: '0 7 * * *', template: { data: { to: 'team@example.com' } } })

// worker.ts: a separate pod on the same store runs the jobs and fires the schedule
const worker = new Queue<{ to: string }>('emails', { store, namespace: 'shop' })
worker.process(async (job) => console.log('send to', job.data.to))
// --- snippet end
await emails.close()
await worker.close()
