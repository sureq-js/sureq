# Retry and backoff

When an attempt fails, SureQ either retries the job after a wait, or fails it for good. This page lists what decides that and how long the wait is.

In the examples, `queue` is a `Queue<{ to: string }>`, `data` is `{ to: 'ada@example.com' }`, `handler` is a `JobHandler` and `ctx` is the handler's `JobContext`.

## The decision

After a failed attempt, these rules are checked from top to bottom. The first that matches wins.

| # | When | Result | `failed` reason |
|---|---|---|---|
| 1 | The error is an `UnrecoverableError`, or the handler called `ctx.fail(err, { retry: false })` | fail now | `'unrecoverable'` |
| 2 | No attempts are left (`attempt >= maxAttempts`) | fail now | `'attempts-exhausted'` |
| 3 | The handler called `ctx.fail(err, { retry: true })` | retry, `retryIf` is skipped | |
| 4 | The worker's `retryIf(err, job)` returns `false` | fail now | `'not-retryable'` |
| 5 | Anything else | retry after the backoff wait | |

`FailureReason` is `'attempts-exhausted' | 'unrecoverable' | 'not-retryable'`. It is the `reason` of the `failed` event.

```ts
throw new UnrecoverableError('invalid address')
ctx.fail(new Error('bad input'), { retry: false })
queue.process(handler, { retryIf: (err) => !(err instanceof TypeError) })
```

- `retryIf` that throws, rejects or returns a non-boolean counts as "retry". It is reported on the `error` event as a `RetryIfError`, with source `'internal'`. A failing backoff strategy is reported with source `'strategy'`.
- The worker option `unwrapCause` (default `true`) also finds an `UnrecoverableError` in the error's `cause` chain.
- `isUnrecoverable(err, unwrapCause?)` tells whether an error counts as unrecoverable. `unwrapCause` defaults to `false` here.

```ts
const final = isUnrecoverable(new Error('wrapped', { cause: new UnrecoverableError('no') }), true) // true
```

A retried job goes to `delayed` until the wait is over. It goes through `delayed` even when the wait is `0`. The worker emits `retrying` with `{ job, error, delayMs, runAt }`.

## BackoffSpec

`BackoffSpec` is a `Duration` or an object. Set it per job with `add(data, { backoff })`, or for every job with `defaultJobOptions.backoff`. It is stored on the job when the job is added, so every worker uses the same one.

| You write | You get |
|---|---|
| nothing | exponential from 1 s, factor 2, full jitter, capped at 1 hour |
| a `Duration`, such as `5000` or `'5s'` | fixed: the same wait before every retry, no jitter |
| `{ type: 'fixed', ... }` | fixed, written out |
| `{ type: 'exponential', ... }` | exponential, with your own values |
| `{ type: 'my-strategy', ... }` | your own function, registered on the worker |

```ts
await queue.add(data, { backoff: '5s' })
await queue.add(data, { backoff: { type: 'fixed', delay: '30s' } })
await queue.add(data, { backoff: { type: 'exponential', delay: '2s', factor: 3, jitter: 'none', maxDelay: '10m' } })
await queue.add(data, { backoff: { type: 'retry-after' } })
```

### Object keys

| Name | Type | Default | Meaning |
|---|---|---|---|
| `type` | `'fixed' \| 'exponential' \| string` | required | The strategy. Any other name is a custom strategy: 1 to 64 characters. |
| `delay` | `Duration` | `1000` ms | The wait (`fixed`), or the first wait (`exponential`). At most 100 years. |
| `factor` | `number` | `2` for `exponential`; none otherwise | Growth per attempt. Above 1. Ignored by `fixed`. |
| `maxDelay` | `Duration` | `'1h'` for `exponential`; none otherwise | Cap on each wait, before jitter. Not allowed on `fixed`. |
| `jitter` | `Jitter` | `'full'` for `exponential`; `'none'` otherwise | Random spread of each wait. |

```ts
await queue.add(data, { backoff: { type: 'exponential' } })
await queue.add(data, { backoff: { type: 'fixed', delay: '1m' } })
await queue.add(data, { backoff: { type: 'exponential', factor: 4 } })
await queue.add(data, { backoff: { type: 'exponential', maxDelay: '5m' } })
await queue.add(data, { backoff: { type: 'exponential', jitter: 'equal' } })
```

### Jitter

`Jitter` is `'none' | 'full' | 'equal'`. With `c` as the capped wait and `r` a random number from 0 to 1:

| Value | Wait |
|---|---|
| `'none'` | `c` |
| `'full'` | `r × c` |
| `'equal'` | `c / 2 + r × c / 2` |

```ts
await queue.add(data, { backoff: { type: 'fixed', delay: '10s', jitter: 'full' } })
```

### How the wait is computed

For the attempt that just failed (`attempt` is 1 after the first run):

1. Raw wait. `fixed`: `delay`. `exponential`: `delay × factor^(attempt - 1)`. Custom: what your function returns.
2. Cap. `exponential`: at most `maxDelay`. Custom: at most `maxDelay` when you gave one. `fixed` is never capped.
3. Jitter, as in the table above.
4. Rounded down to whole ms.

With `{ type: 'exponential', delay: '2s', factor: 3, jitter: 'none', maxDelay: '10m' }` the waits are 2 s, 6 s, 18 s, 54 s, and so on up to 10 minutes.

## Custom strategies

Register a function under a name with the worker option `backoffStrategies`, then use that name as `type`.

```ts
queue.process(handler, {
  backoffStrategies: {
    'retry-after': (attempt, error, job, spec) => (error as Error & { retryAfterMs?: number }).retryAfterMs ?? spec.delay,
  },
})
```

`BackoffFn` is `(attempt: number, error: Error, job: Job, spec: StoredBackoff) => number`.

- It returns the wait in ms: a finite number from 0 to 100 years.
- `spec` is the `StoredBackoff`: `{ type, delay, factor?, maxDelay?, jitter }`, with every default filled in and every duration in ms.
- The names `fixed` and `exponential` are taken. Using one in `backoffStrategies` is an `InvalidOptionError`.
- When the name is not registered on the worker, the function throws, or it returns a bad value, the job still retries, on the default backoff. The worker reports a `BackoffStrategyError` on `error` (source `'strategy'`) with `reason` `'unknown'`, `'threw'` or `'invalid-result'`.

## Related

- `maxAttempts`, `backoff` and the job defaults: [Job options](02-job-options.md).
- `retryIf`, `unwrapCause` and `backoffStrategies`: [Worker options](04-worker-options.md#retries).
- `ctx.fail`: [Job and context](07-job-and-context.md#jobcontext).
- Failing one job in a batch with `TaskFailure`: [Batch worker](05-batch-worker.md).
- Moving a job that failed for good back to waiting: [Admin](14-admin.md).
