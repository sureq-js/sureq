# Producer-only pods

A `Producer` adds and manages jobs but never runs them. Use it in processes that only add jobs, such as an API server or a serverless function, while worker pods run the jobs from the same store.
This page adds a job from a producer and lets a worker on the same store run it.

## Example

```ts
import { MemoryStore, Queue } from '@sureq/core'
import { Producer } from '@sureq/core/producer'

type Email = { to: string }

// One process plays both pods here. In production each side
// gets its own client for the same shared store.
const store = new MemoryStore()

// API pod: adds jobs, runs nothing.
const producer = new Producer<Email>('emails', { store, namespace: 'shop' })
producer.on('error', ({ error }) => console.error('producer error', error))
await producer.ready()

// Worker pod: same store, same queue name, same namespace.
const queue = new Queue<Email>('emails', { store, namespace: 'shop' })
const worker = queue.process(async (job) => console.log('sent', job.data.to))
worker.on('error', ({ error }) => console.error('worker error', error))

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))
const { job } = await producer.add({ to: 'ada@example.com' })
await drained

console.log((await producer.getJob(job.id))?.state)
console.log('workers seen by the producer', (await producer.getWorkers()).length)

await producer.close()
await queue.close()
await store.close()
```

Output:

```text
sent ada@example.com
completed
workers seen by the producer 1
```

- Import `Producer` from `@sureq/core/producer`. That entry loads none of the worker, sweeper or scheduler code, so it starts fast and stays small.
- A producer needs a `store`. Give it the store your worker pods use, and the same queue name and `namespace`.
- It runs no timers. After each call nothing is left running, so a frozen serverless function costs nothing between calls.
- It can still read, cancel, redrive, clean and pause, and create schedules. Schedules fire on the worker pods.
- `close()` only marks the producer closed. The store you passed in stays open, so close it yourself.

## Common questions

**Can I use a `MemoryStore` across pods?** No. A `MemoryStore` lives in one process. Real pods need a store adapter that keeps jobs in a shared database. See [Store contract](../04-stores/01-store-contract.md).

**What does a namespace keep apart?** Everything a queue stores: its jobs, schedules, pause flag and worker list. Two queues with the same name in different namespaces of one store never see each other's jobs. The default is `'default'`. See [Queue options: store and identity](../03-reference/01-queue.md#store-and-identity).

**Can I share the add code between a producer and a queue?** Yes. Both implement `QueueClient`, so type a function against it and pass either one. See [QueueClient](../03-reference/01-queue.md#queueclient).

**Why does `new Producer` throw for `alerts` or `leaseDuration`?** A producer accepts only the add side of the queue options. Set those options on the worker pods instead. See [Producer options](../03-reference/09-producer.md#producer-options).

## Reference

- [Producer](../03-reference/09-producer.md)
- [Producer options](../03-reference/09-producer.md#producer-options)
- [Producer methods](../03-reference/09-producer.md#methods)
- [What a producer does not do](../03-reference/09-producer.md#what-a-producer-does-not-do)
- [Producer events](../03-reference/09-producer.md#events)
