// The README "Metrics and alerts" sample, verbatim between the markers (checked by tests/unit/readme.test.ts)
// and type-checked with the package.
import { Queue } from '@sureq/core'

// --- snippet start
const queue = new Queue('emails', {
  alerts: {
    interval: '15s',
    depth: { above: 1000, resolveBelow: 800 },  // waiting jobs
    age: { aboveMs: 60_000 },                   // oldest waiting job, ms
    failureRate: { above: 0.2, minJobs: 20 },   // over this pod's metrics window
  },
})
queue.on('alert', (e) => console.warn(`${e.queue} ${e.type} ${e.status}: ${e.value} (threshold ${e.threshold})`))

const snapshot = await queue.metrics()  // { at, scope, samples }
const ageMs = await queue.getOldestWaitingAge()  // null when nothing is waiting
// --- snippet end
void snapshot
void ageMs
await queue.close()
