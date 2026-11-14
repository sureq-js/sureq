# Health and metrics

A queue reports on itself in four ways: `health()` for probes, `metrics()` for dashboards, alerts for thresholds, and `getWorkers()` for the live workers of every pod.

```ts
const report = await queue.health()
const snapshot = await queue.metrics()
const firing = queue.getAlerts()
const workers = await queue.getWorkers()
```

## health

`queue.health(opts?)` returns a `HealthReport`. It never rejects, except for a bad `timeoutMs`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `timeoutMs` | `number` | `2000` | Longest the store check may take, in ms. |

```ts
const report = await queue.health({ timeoutMs: 1000 })
```

The report has two answers:

- `live`: every running worker's loop is alive. It never depends on the store, so a store outage does not restart every pod. A queue with no workers is live.
- `ready`: one store `now()` call answered within `timeoutMs`, the store is connected, the queue is not closing, and this release reads the store's format.

On a fresh queue, `health()` opens the store first, within the same `timeoutMs`, so the first probe already reports the real state. If the store cannot be opened in time, `ready` is `false` and `store.state` shows `'reconnecting'`.

Serve them on two endpoints, 200 when true and 503 when false:

```ts
import { createServer } from 'node:http'
import { Queue } from '@sureq/core'

const queue = new Queue('emails')

createServer(async (req, res) => {
  if (req.url !== '/livez' && req.url !== '/readyz') return void res.writeHead(404).end()
  const report = await queue.health()
  const ok = req.url === '/livez' ? report.live : report.ready
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(report))
}).listen(8080)
```

SureQ cannot see a blocked event loop: `health()` simply does not run. The probe's own timeout detects it, so keep the probe timeout above `timeoutMs`.

### HealthReport

| Field | Type | Meaning |
|---|---|---|
| `live` | `boolean` | Use for liveness probes. |
| `ready` | `boolean` | Use for readiness probes. |
| `status` | `'ok' \| 'degraded' \| 'down'` | `'down'` when not live. `'degraded'` when not ready, a lease renewal is late, the queue is paused, or there is any warning or firing alert. Else `'ok'`. |
| `checkedAt` | `number` | Pod time of the check, in epoch ms. |
| `store` | object | `ok`, `latencyMs` (`null` when not probed), `state` (`ConnectionState`), `durable` (the store's capability flag) and `error`, set only when `ok` is `false`: `'store is <state>'` when the store is not connected, `'timeout'` when the check ran out, the thrown error's description when the check failed, or `'unknown'` when the health check itself failed. |
| `workers` | array | One entry per worker of this queue object on this pod. See below. |
| `queue` | `{ paused: boolean }` | The pause flag as this pod last saw it. |
| `format` | object | `storeFormat` (`null` before it was read), `supported` (`{ min, max }`) and `degraded` (the pod stopped claiming because the store moved to a newer format). |
| `warnings` | `HealthWarning[]` | Advice, each `{ code, message }`. See below. |
| `alerts` | `AlertEvent[]` | This pod's firing alerts. |

Each entry of `workers`:

| Field | Type | Meaning |
|---|---|---|
| `workerId` | `string` | The worker id. |
| `state` | `WorkerState` | `'created'`, `'running'`, `'stopping'` or `'stopped'`. |
| `paused` | `boolean` | The worker is paused. |
| `loopAlive` | `boolean` | `false` when a running worker's loop has not gone round for `max(3 × pollMax, 10 s)`. Not judged while the store is reconnecting. |
| `lastLoopAt` | `number \| null` | Pod time of the loop's last turn. |
| `activeJobs` | `number` | Jobs running now. |
| `renewals` | `{ onTime: boolean; lateJobs: number; worstLagMs: number }` | Lease renewals. A job is late when it has had no good renewal for twice its heartbeat interval. |

A producer's report has no workers and no alerts.

### Health warnings

| Code | When |
|---|---|
| `QUEUE_PAUSED` | The queue is paused for every pod. |
| `RENEWALS_LATE` | Running jobs have not renewed their lease on time. |
| `STORE_RECONNECTING` | The store is not connected. |
| `STORE_FORMAT_AHEAD` | The store moved to a format this pod cannot read. It claims nothing and fires no schedule. |
| `SWEEP_STALLED` | This pod's sweeper has not finished a tick in 5 × `sweepInterval`. |
| `SCHEDULER_STALE` | This pod's running scheduler has not finished a loop turn in 5 × `tickMs`. |
| `NO_SCHEDULER_RUNNING` | The queue has unpaused schedules and no live worker reports a running scheduler. A scheduler started with `startScheduler()` on a pod with no worker is not seen. |
| `DEAD_LETTERS_HIGH` | The dead-letter count is above `deadLetter.warnAbove`. |

```ts
for (const w of report.warnings) console.warn(w.code, w.message)
```

The `DEAD_LETTERS_HIGH` count is the one this pod's last sweeper or alert tick read. There is none before the first tick, none on a pod that runs neither, and none with `warnAbove: false` or `deadLetter: false`.

### Format support

`FormatSupport` is `{ current, minReadable, maxReadable }`: the stored record format this release writes, and the range it reads. In `HealthReport.format`, `supported.min` and `supported.max` are that range.

## Live workers

`queue.getWorkers(opts?)` lists the workers of this queue on every pod, ordered by `startedAt`, then `workerId`. Producers are never listed.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `includeStale` | `boolean` | `false` | Also list workers not heard from for more than three of their heartbeat intervals. |

```ts
const all = await queue.getWorkers({ includeStale: true })
```

Each `WorkerInfo`:

| Field | Type | Meaning |
|---|---|---|
| `workerId` | `string` | The worker id. |
| `host` | `string` | The worker option `host`, default the host name. |
| `pid` | `number \| null` | The process id. |
| `queues` | `string[]` | The queues it serves. |
| `concurrency` | `number` | Its concurrency. |
| `activeJobs` | `number` | Jobs it was running at its last heartbeat. |
| `status` | `WorkerStatus` | `'running'`, `'paused'` or `'draining'` (closing). |
| `sureqVersion` | `string` | Its SureQ release. |
| `formatVersion` | `number` | The record format it writes. |
| `scheduler` | `boolean` | Its queue runs a scheduler on that pod. |
| `startedAt` | `number` | Store time it registered. |
| `lastHeartbeatAt` | `number` | Store time of its last heartbeat. |
| `heartbeatAgeMs` | `number` | Age of that heartbeat by store time. |
| `stale` | `boolean` | Not heard from for more than three of its heartbeat intervals. |
| `labels` | `Record<string, string>` | The worker option `labels`. |

The registry is for display only. Claims, renewals and sweeps never read it.

## metrics

`queue.metrics()` returns a `MetricsSnapshot` from one store read.

| Field | Type | Meaning |
|---|---|---|
| `at` | `number` | Store time of the read. |
| `scope` | `Record<string, 'cluster' \| 'pod'>` | For each metric name: `'cluster'` (read from the store, the same on every pod) or `'pod'` (what this pod did since it started). |
| `samples` | `MetricSample[]` | The values. |

A `MetricSample` is `{ name, labels, value }` for a gauge or counter, or `{ name, labels, count, sum, buckets }` for a histogram. `buckets` is a list of `{ le, count }` with cumulative counts; the `+Inf` bucket is `count`.

```ts
for (const s of snapshot.samples) if ('value' in s) console.log(s.name, s.labels, s.value)
```

Pod metrics count only this pod. Scrape every pod and sum them.

### The metrics

`describeMetrics()` returns one `MetricDescriptor` per metric: `{ name, type, unit, labels, help }`. `MetricType` is `'gauge' | 'counter' | 'histogram'`. `MetricUnit` is `'jobs' | 'seconds' | 'ratio' | 'jobs_per_second'`.

```ts
for (const m of describeMetrics()) console.log(m.name, m.type, m.unit, m.labels.join(','))
```

Every metric has the labels `namespace` and `queue`, then its own.

| Name | Type | Unit | Own labels | Scope | Meaning |
|---|---|---|---|---|---|
| `sureq_jobs` | gauge | jobs | `state` | cluster | Jobs in each state. |
| `sureq_jobs_added_total` | counter | jobs | `name` | pod | Jobs this pod added. |
| `sureq_jobs_finished_total` | counter | jobs | `name`, `outcome` | pod | Jobs this pod finished, by outcome. |
| `sureq_jobs_crashed_total` | counter | jobs | `name` | pod | Attempts whose lease expired and this pod swept. |
| `sureq_attempts_retried_total` | counter | jobs | `name` | pod | Failed attempts this pod scheduled for a retry. |
| `sureq_job_wait_seconds` | histogram | seconds | `name` | pod | Time from due to claimed, per attempt. A delay is not waiting. |
| `sureq_job_processing_seconds` | histogram | seconds | `name`, `outcome` | pod | Time from claimed to the attempt's end. |
| `sureq_job_processing_peak_seconds` | gauge | seconds | `name` | pod | Longest processing time in the window. |
| `sureq_success_ratio` | gauge | ratio | `name` | pod | `completed / (completed + failed)` over the window. Absent with no finished job. |
| `sureq_throughput_per_second` | gauge | jobs_per_second | `name` | pod | Jobs finished in the window, per second. A pod younger than the window divides by its uptime. |
| `sureq_oldest_waiting_age_seconds` | gauge | seconds | none | cluster | Age of the oldest waiting job that is not held back by a pause. `0` when none. |
| `sureq_alert_firing` | gauge | ratio | `type` | pod | `1` while the alert fires on this pod, else `0`. Only configured rules. |
| `sureq_jobs_rejected_total` | counter | jobs | `name` | pod | Adds the queue filter rejected on this pod. |
| `sureq_batch_held_seconds` | histogram | seconds | `name` | pod | Time a batch job was held before its handler started. |

- Times use store time, so pod clock skew does not change them. A write the store refused, such as one after a lost lease, records nothing.
- `name` is the job name, `""` for unnamed jobs. Past `maxNameLabels` distinct names it is `__other__`, with one warning in the log.

### Metrics options

`MetricsOptions`, the queue option `metrics`.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `window` | `Duration` | `'5m'` | Window of the peak, success ratio and throughput, in 1-minute buckets. 1 minute to 1 day. |
| `buckets` | `number[]` | `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800]` | Histogram bucket bounds, in seconds. Non-empty, above 0, strictly ascending. |
| `maxNameLabels` | `number` | `100` | Most distinct `name` label values. At least 1. |

```ts
new Queue('emails', { metrics: { window: '15m' } })
new Queue('emails', { metrics: { buckets: [0.1, 1, 10, 60] } })
new Queue('emails', { metrics: { maxNameLabels: 20 } })
```

A name takes a slot the first time this pod adds, runs or rejects a job of that name.

## Alerts

The queue option `alerts` is `AlertRules & { interval?: Duration }`. With it, the queue checks its rules every `interval`, with or without workers. Each check is one store read. Leave `alerts` out to check nothing; `alerts: {}` still reads every `interval`.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `interval` | `Duration` | `'15s'` | How often the rules are checked. 1 s to 1 day. |
| `depth` | `{ above: number; resolveBelow?: number }` | none | Waiting jobs. |
| `age` | `{ aboveMs: number; resolveBelowMs?: number }` | none | Age of the oldest waiting job, in ms. |
| `failureRate` | `{ above: number; resolveBelow?: number; minJobs?: number }` | none | `failed / (completed + failed)` over this pod's metrics window. |

```ts
new Queue('emails', { alerts: { interval: '30s', depth: { above: 1000 } } })
new Queue('emails', { alerts: { depth: { above: 1000, resolveBelow: 800 } } })
new Queue('emails', { alerts: { age: { aboveMs: 60_000, resolveBelowMs: 30_000 } } })
new Queue('emails', { alerts: { failureRate: { above: 0.2, resolveBelow: 0.1, minJobs: 20 } } })
```

The keys of each rule:

| Rule | Key | Type | Default | Meaning |
|---|---|---|---|---|
| `depth` | `above` | `number` | required | Fire when the waiting count reaches this. A whole number, at least 1. |
| `depth` | `resolveBelow` | `number` | `above` | Resolve when the count drops below this. 0 to `above`. |
| `age` | `aboveMs` | `number` | required | Fire when the oldest waiting job is this old, in ms. At least 1. |
| `age` | `resolveBelowMs` | `number` | `aboveMs` | Resolve below this age, in ms. 0 to `aboveMs`. |
| `failureRate` | `above` | `number` | required | Fire at this ratio. Above 0, at most 1. |
| `failureRate` | `resolveBelow` | `number` | `above` | Resolve below this ratio. 0 to `above`. |
| `failureRate` | `minJobs` | `number` | `10` | Finished jobs in the window before the rule is checked. At least 1. |

- A rule fires once when its value reaches the fire level, and resolves once when it drops below the resolve level. With no gap between the two, a value near the level may flap.
- Each change is one `alert` event and one log line: `warn` when firing, `info` when resolved.
- Alerts are per pod. Every pod checks and fires its own; the failure rate counts only this pod's jobs.
- A failed store read skips that check and changes nothing.

### AlertEvent

`queue.getAlerts()` and `health().alerts` list the firing ones. The `alert` event carries one per change.

| Field | Type | Meaning |
|---|---|---|
| `type` | `AlertType` | `'depth'`, `'age'` or `'failureRate'`. |
| `status` | `'firing' \| 'resolved'` | What changed. |
| `value` | `number` | The value read: jobs, seconds, or a ratio. |
| `threshold` | `number` | The level crossed, in the same unit. For `age` this is seconds, not ms. |
| `namespace` | `string` | The namespace. |
| `queue` | `string` | The queue name. |
| `at` | `number` | Store time of the read. |

```ts
queue.on('alert', (e) => console.warn(`${e.queue} ${e.type} ${e.status}: ${e.value} (threshold ${e.threshold})`))
```
