# Handling errors

Errors reach you in three ways: thrown from a call such as `add`, reported as an `error` event, or stored on a job that failed. Every SureQ error has a stable `code`, so check the `code` or use `instanceof`, never the message.
This page shows one of each: a rejected add, an unknown id, a failed job, and a listener that throws.

## Example

```ts
import { isSureQError, PayloadTooLargeError, Queue } from '@sureq/core'

type Email = { to: string; body: string }

const queue = new Queue<Email>('emails', { maxPayloadBytes: 1024 })

// 1. Errors thrown to the caller.
try {
  await queue.add({ to: 'ada@example.com', body: 'x'.repeat(2000) })
} catch (err) {
  if (err instanceof PayloadTooLargeError) console.log(err.code, err.size, '>', err.limit)
  else throw err
}

try {
  await queue.cancel('no-such-job')
} catch (err) {
  if (isSureQError(err) && err.code === 'JOB_NOT_FOUND') console.log(err.code, err.message)
  else throw err
}

// 2. Errors reported as events: store trouble, SureQ bugs, and your own listeners.
queue.on('error', ({ error, source, context }) => console.log('error event', source, context.event, error.code))

// 3. Job failures: the handler's error, stored on the job.
class BounceError extends Error {
  name = 'BounceError'
  code = 'MAIL_BOUNCE'
}

queue.process(
  async (job) => {
    throw new BounceError(`no mailbox for ${job.data.to}`)
  },
)

queue.on('failed', ({ job, reason, error }) => {
  console.log('failed', job.id, reason, error.name, error.code, error.message)
  throw new Error('bug in my listener')
})

const drained = new Promise<void>((resolve) => queue.once('drained', () => resolve()))
await queue.add({ to: 'nobody@example.com', body: 'hi' }, { id: 'bounce', maxAttempts: 1 })
await drained

const stored = await queue.getJob('bounce')
console.log(stored?.state, stored?.error?.code)
await queue.close()
```

Output:

```text
PAYLOAD_TOO_LARGE 2034 > 1024
JOB_NOT_FOUND Job "no-such-job" was not found
store is not durable; jobs are lost on restart { queue: 'emails' }
failed bounce attempts-exhausted BounceError MAIL_BOUNCE no mailbox for nobody@example.com
error event listener failed LISTENER_ERROR
failed MAIL_BOUNCE
```

- Calls throw for bad input or a bad state: here the data is over `maxPayloadBytes`, and the id is unknown. Each error class has its own fields, such as `size` and `limit`.
- `isSureQError(err)` is true for any SureQ error, even from a second copy of the package. Then `err.code` tells you which one.
- A handler's error is not thrown to you. It fails the attempt, and the job stores it as a `SerializedError` with its `name`, `message`, `code` and stack. Read it from the `failed` event or `job.error`.
- A stored error is plain data, not an `Error` object, so `instanceof` does not work on it. Check `error.code` or `error.name`.
- The `error` event carries problems that are not a job failure. A listener that throws never breaks SureQ; it shows up here with `source: 'listener'`.

## Common questions

**What if I do not listen for `error`?** Each one is logged instead. Listen on every queue and worker anyway, so store trouble reaches your own monitoring.

**Which errors are worth retrying?** A `StoreError` says so in `retryable`. When `outcomeUnknown` is true, read the job back before you repeat a write. See [Errors: store](../03-reference/08-errors.md#store).

**How do I stop a handler error from being retried?** Throw `UnrecoverableError`, or give the worker a `retryIf`. See [Retries and failures](03-retries-and-failures.md).

**Can I turn a stored error back into an `Error`?** Yes, with `deserializeError(job.error)`. It builds a plain `Error`, not the original class. See [Stored errors](../03-reference/08-errors.md#stored-errors).

## Reference

- [Errors](../03-reference/08-errors.md)
- [SureQError](../03-reference/08-errors.md#sureqerror)
- [Error catalogue](../03-reference/08-errors.md#catalogue)
- [Error fields by class](../03-reference/08-errors.md#error-fields-by-class)
- [Events: store and pods](../03-reference/06-events.md#store-and-pods)
- [SerializedError](../03-reference/07-job-and-context.md#related-types)
