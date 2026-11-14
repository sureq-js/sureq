# Health and metrics

A queue tells you how it is doing: `health()` answers liveness and readiness probes, `metrics()` gives numbers for dashboards, and alert rules fire when a threshold is crossed.
This page serves `/livez` and `/readyz`, lets jobs pile up until a depth alert fires, and reads the job counts from the metrics.

## Example

```ts
import { createServer } from 'node:http'
import { Queue } from '@sureq/core'

type Email = { to: string }

const queue = new Queue<Email>('emails', {
  alerts: { interval: '1s', depth: { above: 3, resolveBelow: 1 } },
})
queue.on('alert', (e) => console.log('alert', e.type, e.status, e.value))
queue.on('error', ({ error }) => console.error('queue error', error))

const server = createServer(async (req, res) => {
  if (req.url !== '/livez' && req.url !== '/readyz') return void res.writeHead(404).end()
  const report = await queue.health()
  const ok = req.url === '/livez' ? report.live : report.ready
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(report))
})
await new Promise<void>((resolve) => server.listen(3000, resolve))

// No worker yet, so jobs pile up and the depth alert fires.
for (const to of ['ada', 'alan', 'grace', 'linus']) await queue.add({ to: `${to}@example.com` })
await new Promise<void>((resolve) => queue.once('alert', () => resolve()))

const res = await fetch('http://localhost:3000/readyz')
const report = await res.json()
console.log(res.status, report.status, report.alerts.length)

const snapshot = await queue.metrics()
for (const s of snapshot.samples) {
  if (s.name === 'sureq_jobs' && 'value' in s && s.value > 0) console.log(s.name, s.labels.state, s.value)
}

server.close()
await queue.close()
```

Output:

```text
alert depth firing { queue: 'emails', type: 'depth', value: 4, threshold: 3 }
alert depth firing 4
200 degraded 1
sureq_jobs waiting 4
```

- On a new queue, the first `health()` opens the store, so the first probe already reports the real state. To fail fast at start-up when the store is down, call `await queue.ready()`: it throws `StoreNotReadyError` after its timeout.
- `live` never depends on the store, so a store outage does not get every pod restarted. `ready` does: it is `false` while the store does not answer.
- The first line is the default logger's `warn` line for the alert. The second is the `alert` event.
- `/readyz` still answers 200: a firing alert makes `status` `'degraded'`, but the queue is ready. Use `status` and `warnings` for dashboards, not for probes.
- `sureq_jobs` counts jobs per state for the whole queue. Most other metrics count only what this pod did, so scrape every pod and sum them.

## Common questions

**Can I export the metrics to Prometheus?** SureQ has no exporter of its own. Each sample has a `name`, `labels` and a value or histogram buckets, and `describeMetrics()` gives each metric's type and help text, so a short loop can feed any client library. See [metrics](../03-reference/11-health-and-metrics.md#metrics).

**Are alerts cluster-wide?** No. Each pod checks its own rules and fires its own alerts. The failure rate counts only that pod's jobs.

**Which workers are running right now?** `queue.getWorkers()` lists the live workers of the queue on every pod. See [Live workers](../03-reference/11-health-and-metrics.md#live-workers).

## Reference

- [health](../03-reference/11-health-and-metrics.md#health)
- [HealthReport](../03-reference/11-health-and-metrics.md#healthreport)
- [Health warnings](../03-reference/11-health-and-metrics.md#health-warnings)
- [The metrics](../03-reference/11-health-and-metrics.md#the-metrics)
- [Alerts](../03-reference/11-health-and-metrics.md#alerts)
- [Events: store and pods](../03-reference/06-events.md#store-and-pods)
