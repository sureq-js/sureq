# MemoryStore

`MemoryStore` is the built-in store. It keeps every job in this process's memory, so jobs are lost when the process exits. Use it for tests, local work and single-process apps.

```ts
import { MemoryStore, Queue } from '@sureq/core'

const store = new MemoryStore()
const emails = new Queue('emails', { store })
const digests = new Queue('digests', { store })
```

- A `Queue` with no `store` option makes its own `MemoryStore` and closes it in `close()`. Make one yourself to share it between queues in one process.
- A store you pass in stays open when the queue closes. Call `store.close()` when you are done with it.
- `close()` stops the store serving calls and drops its subscriptions. The data stays in the object: open it again and the jobs are still there.
- It cannot be shared between processes. For several pods, use a store adapter that implements the [store contract](../04-stores/01-store-contract.md).

## Options

`new MemoryStore(opts?)`.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `clock` | `() => number` | `Date.now` | The time source, in epoch ms. Store time is read from it. Inject a fake clock in tests. |
| `finalsTtl` | `Duration` | `600000` (10 minutes) | How long the store remembers the last finishing write of a deleted job, so a worker that repeats its `complete`, `fail` or `release` after a lost answer gets the first answer back. |

```ts
new MemoryStore({ clock: () => fakeNow })
new MemoryStore({ finalsTtl: '30m' })
```

## Behaviour

- Store time never goes backwards. When the clock steps back, store time stands still until the clock catches up, so delays, leases and schedules run late for the length of the step.
- Each call runs as one step, so every operation is atomic.
- `getAttempts` returns 100 records per page when no `limit` is given.

## Capabilities

| Capability | Value |
|---|---|
| `transactions` | `true`: `addBulk` with `atomic: true` works. |
| `skipLocked` | `true` |
| `notify` | `true`: workers wake as soon as a job is added. |
| `durable` | `false`: jobs are lost on restart. The first `process()` logs one warning; the worker option `acknowledgeVolatileStore: true` silences it. |
| `shared` | `false`: one process only. |
| `limits` | `maxIdBytes: 255`, `maxClaimLimit: 1000` |

Every other flag is `false`. The flags are explained in [Store contract](../04-stores/01-store-contract.md#capabilities).

```ts
console.log(store.capabilities.durable, store.contractVersion) // false 1
```

## Testing with a fake clock

A fake clock moves delays, retries and schedules forward without waiting.

```ts
let now = Date.UTC(2026, 0, 1)
const store = new MemoryStore({ clock: () => now })
const queue = new Queue('emails', { store })
await queue.add({ to: 'ada@example.com' }, { delay: '1h' })
now += 60 * 60 * 1000 // the job is due now
```
