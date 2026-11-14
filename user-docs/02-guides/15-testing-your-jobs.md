# Testing your jobs

Test a handler by running it through a real queue on a `MemoryStore`: add a job, wait for it to finish, then check the stored job. No fake clock and no mocks are needed, because short retries finish in milliseconds.
This page is one test file with two tests: a job that succeeds on its second attempt, and one that fails at once.

## Example

`emails.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest'
import { MemoryStore, Queue, type JobHandler } from '@sureq/core'

type Email = { to: string }

// The code under test. In your app it lives in its own module.
const sent: string[] = []
const sendEmail: JobHandler<Email, { ok: true }> = async (job, ctx) => {
  if (!job.data.to.includes('@')) ctx.fail(new Error('bad address'), { retry: false })
  if (ctx.attempt === 1 && job.data.to.startsWith('flaky')) throw new Error('smtp busy')
  sent.push(job.data.to)
  return { ok: true }
}

// One fresh store and queue per test, closed after it.
let store: MemoryStore
let queue: Queue<Email, { ok: true }>

beforeEach(() => {
  store = new MemoryStore()
  queue = new Queue('emails', { store, logger: false, defaultJobOptions: { backoff: 10 } })
  queue.process(sendEmail, { acknowledgeVolatileStore: true })
})

// Resolve when the job finishes for good, whatever the outcome.
function settled(id: string) {
  return new Promise<string>((resolve) => {
    queue.on('completed', ({ job }) => {
      if (job.id === id) resolve('completed')
    })
    queue.on('failed', ({ job }) => {
      if (job.id === id) resolve('failed')
    })
  })
}

afterEach(async () => {
  await queue.close()
  await store.close()
  sent.length = 0
})

test('sends after one retry', async () => {
  const done = settled('a')
  await queue.add({ to: 'flaky@example.com' }, { id: 'a', maxAttempts: 3 })
  expect(await done).toBe('completed')
  const job = await queue.getJob('a')
  expect(job?.attempt).toBe(2)
  expect(job?.result).toEqual({ ok: true })
  expect(sent).toEqual(['flaky@example.com'])
})

test('fails a bad address at once', async () => {
  const done = settled('b')
  await queue.add({ to: 'nobody' }, { id: 'b', maxAttempts: 3 })
  expect(await done).toBe('failed')
  const job = await queue.getJob('b')
  expect(job?.attempt).toBe(1)
  expect(job?.error?.message).toBe('bad address')
  expect(job?.deadLetter?.reason).toBe('unrecoverable')
})
```

Output of `npx vitest run --reporter=verbose`, trimmed (times vary):

```text
 ✓ emails.test.ts > sends after one retry 115ms
 ✓ emails.test.ts > fails a bad address at once 2ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

- Each test gets a new `MemoryStore` and queue, so no job leaks from one test into the next. `afterEach` closes both.
- `backoff: 10` makes a retry wait 10 ms, so the retry test runs in about a tenth of a second with real timers.
- `settled(id)` listens for the job's final event before the add, so it cannot miss it. Then the test reads the stored job and checks its state, attempts, result and error.
- `logger: false` keeps the test output clean. `acknowledgeVolatileStore: true` silences the warning that a `MemoryStore` is not durable.
- Keep real timers.

## Running it with Jest

The same file runs under Jest with [ts-jest](https://kulshekhar.github.io/ts-jest/). Change only the first line:

```ts
import { afterEach, beforeEach, expect, test } from '@jest/globals'
```

Install `jest`, `ts-jest`, `typescript` and `@jest/globals` as dev dependencies, then add these two files:

`jest.config.js`:

```js
module.exports = { preset: 'ts-jest', testEnvironment: 'node' }
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "node16",
    "moduleResolution": "node16",
    "target": "es2022",
    "strict": true,
    "isolatedModules": true,
    "skipLibCheck": true
  }
}
```

Output of `npx jest`, with Jest 30 and ts-jest:

```text
Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
```

## Common questions

**Can I test the handler without a queue?** Only partly. It needs a `job` and a `ctx`, and the retry, `ctx.fail` and dead-letter behaviour come from the worker. Running it through a queue tests what production does.

**How do I test a job delayed by an hour?** Give the `MemoryStore` a fake clock, `new MemoryStore({ clock: () => now })`, and move `now` forward. See [Testing with a fake clock](../03-reference/10-memory-store.md#testing-with-a-fake-clock).

**Can several queues share the store in a test?** Yes. Pass the same `store` to each, as on the worker pods in production. A `Producer` can share it too. See [Producer-only pods](12-producer-only-pods.md).

**Do I test my own store adapter the same way?** No. Use the conformance kit, which runs the contract tests against it. See [Conformance kit](../04-stores/03-conformance-kit.md).

## Reference

- [MemoryStore](../03-reference/10-memory-store.md)
- [MemoryStore options](../03-reference/10-memory-store.md#options)
- [Handlers](../03-reference/04-worker-options.md#handlers)
- [Events: running](../03-reference/06-events.md#running)
- [Job fields](../03-reference/07-job-and-context.md#fields)
