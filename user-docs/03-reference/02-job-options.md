# Job options

Options for one job, given as the second argument of `queue.add(data, opts)` or as `opts` of an `addBulk` item. An option set to `undefined` counts as not given.

```ts
await queue.add({ to: 'ada@example.com' }, { name: 'welcome', priority: 10, delay: '5m' })
```

In the examples, `queue` is a `Queue<{ to: string }>` and `data` is `{ to: 'ada@example.com' }`.

## Add options

Every key of `AddOptions`.

### Identity

| Name | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string \| ((data: D) => string)` | the queue's `id` function, else a UUIDv7 | The job id, or a synchronous function that makes it from the data. |
| `name` | `string` | none (`null`) | The job name. Picks the handler in `process({ name: handler })`. 1 to 128 characters from `A-Z a-z 0-9 . _ : / -`. |
| `idempotencyKey` | `string` | `namespace:queue:id:seq` | Stored as `job.idempotencyKey`. Pass it to outside APIs so a repeated run has no second effect. |

```ts
await queue.add(data, { id: 'welcome-ada' })
await queue.add(data, { name: 'welcome' })
await queue.add(data, { idempotencyKey: 'order-42-receipt' })
```

### Duplicates

| Name | Type | Default | Meaning |
|---|---|---|---|
| `onDuplicate` | `DuplicateRule<D>` | the queue's `onDuplicate` (`'ignore'`) | What to do when the id is taken. |
| `uniqueWhile` | `'pending' \| 'retained'` | the queue's `uniqueWhile` (`'pending'`) | How long the job holds its id. |
| `singletonKey` | `string \| null` | none | At most one waiting or delayed job per key. `null` holds nothing. |

```ts
await queue.add(data, { id: 'welcome-ada', onDuplicate: 'replace' })
await queue.add(data, { id: 'welcome-ada', uniqueWhile: 'retained' })
await queue.add(data, { singletonKey: 'sync:acme' })
```

`DuplicateRule<D>` is one of:

| Rule | What happens when the id is taken |
|---|---|
| `'ignore'` | Nothing is written. The add returns the existing job with `added: false`. |
| `'replace'` | A waiting or delayed job gets the new data and the options this add sets. |
| `'reject'` | The add throws `DuplicateJobError`. |
| `(existing, incoming) => D` | Merges the two into new data. The function must be pure: it may run more than once. |

```ts
await queue.add(data, { id: 'welcome-ada', onDuplicate: (existing, incoming) => ({ ...existing.data, ...incoming }) })
```

`existing.data` and `incoming` are the data as read back from JSON (`Jsonify<D>`), while the merge returns `D`. For JSON data they are the same type and the example compiles as is. When `D` holds a `Date`, `Map`, `Set` or other non-JSON value, convert those fields in the merge (`{ ...incoming, sendAt: new Date(incoming.sendAt) }`), or declare the field as what JSON stores (an ISO string).

A job that already started is never replaced or merged. The add then reports `ignored` with `existingState: 'active'`.

`uniqueWhile`:

- `'pending'`: the id is held while the job is waiting, delayed or active. Once it finishes, a new job may take the id.
- `'retained'`: the id is held until the job is deleted, by retention or by `remove`. Such jobs are kept for `retention.retainedAge` (default 7 days) unless a rule gives an age.

`singletonKey`: while another job holds the key, the add returns that job (`by: 'singletonKey'`). The key is free again once the holder starts.

### Timing and order

| Name | Type | Default | Meaning |
|---|---|---|---|
| `delay` | `Duration` | `0` | Wait this long before the job can run. At most 100 years. |
| `runAt` | `Date \| number` | none | Run at this time (a `Date` or epoch ms). A past time runs now. |
| `priority` | `number` | `0` | Higher runs first. A whole number from -2147483648 to 2147483647. |
| `first` | `boolean` | `false` | Put the job at the front of its priority level. |

```ts
await queue.add(data, { delay: '10m' })
await queue.add(data, { runAt: new Date(Date.now() + 60_000) })
await queue.add(data, { priority: 10 })
await queue.add(data, { first: true })
```

Set `delay` or `runAt`, not both. Times use the store's clock. See [Durations](01-queue.md#durations).

### Retries and time limits

| Name | Type | Default | Meaning |
|---|---|---|---|
| `maxAttempts` | `number` | `3` | Most attempts, the first one included. At least 1. |
| `backoff` | `BackoffSpec` | exponential from 1 s, factor 2, full jitter, 1 h cap | The wait before each retry. See [Retry and backoff](03-retry-and-backoff.md). |
| `timeout` | `Duration` | the worker's, else the queue's, else none | Abort `ctx.signal` with `JobTimeoutError` this long after the handler starts. |
| `timeoutGrace` | `Duration` | the worker's, else the queue's, else `'5s'` | How long a timed-out handler may keep running before the attempt fails anyway. `0` fails at once. |

```ts
await queue.add(data, { maxAttempts: 5 })
await queue.add(data, { backoff: { type: 'exponential', delay: '2s', maxDelay: '10m' } })
await queue.add(data, { timeout: '30s' })
await queue.add(data, { timeout: '30s', timeoutGrace: '2s' })
```

The `maxAttempts`, `backoff` and `timeout` values are stored on the job, so every worker uses the same ones.

### Retention

| Name | Type | Default | Meaning |
|---|---|---|---|
| `keep` | `{ completed?: JobKeep; failed?: JobKeep; cancelled?: JobKeep }` | the queue's `retention` | How long this job is kept once finished, per outcome. |

```ts
await queue.add(data, { keep: { completed: 0, failed: '30d' } })
```

A `JobKeep` is `true` (forever), `false` or `0` (keep none), a `Duration` such as `'1d'`, or `{ age }`. A single job has no count. A bare number is refused on a job, because on a queue `retention` the same number means a count: write `'1000ms'` or `{ age: 1000 }` for time. A job with its own `keep.failed` is never dead-lettered. Keep none on a job added with `uniqueWhile: 'retained'` is an `InvalidOptionError`. See [retention](01-queue.md#retention).

## Job defaults

`JobDefaults` is what the queue option `defaultJobOptions` takes. Each value applies to every add that does not set it.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `maxAttempts` | `number` | `3` | Most attempts per job. |
| `backoff` | `BackoffSpec` | exponential from 1 s, factor 2, full jitter, 1 h cap | The wait before each retry. |
| `priority` | `number` | `0` | Priority of each job. Higher runs first. |

```ts
new Queue('emails', { defaultJobOptions: { maxAttempts: 5 } })
new Queue('emails', { defaultJobOptions: { backoff: '30s' } })
new Queue('emails', { defaultJobOptions: { priority: 1 } })
```

Any other key in `defaultJobOptions` is an `InvalidOptionError`. `onDuplicate` and `uniqueWhile` are queue options instead; `id`, `name`, `delay`, `runAt`, `first`, `singletonKey` and `idempotencyKey` are per add only.

## Order of steps

Every add runs the same steps: resolve options and defaults (id and keys too), the queue `filter`, serialize the data, check `maxPayloadBytes`, then one store call. A failed step stores nothing.
