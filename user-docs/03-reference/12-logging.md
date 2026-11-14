# Logging

SureQ writes a few log lines of its own. By default they go to the console at level `warn` and above. Pass the queue option `logger` to send them elsewhere, or `false` to turn them off.

```ts
import { Queue, consoleLogger } from '@sureq/core'

const queue = new Queue('emails', { logger: consoleLogger({ level: 'info' }) })
```

- A logger that throws or returns a rejected promise is ignored. Logging never breaks processing.
- A logger missing one of the four methods throws `InvalidOptionError` at `new Queue`.
- Job data and results never reach a log line.

## Logger

`Logger` is any object with four methods. Each takes a message and optional flat fields.

| Method | Type |
|---|---|
| `debug(msg, fields?)` | `(msg: string, fields?: LogFields) => void` |
| `info(msg, fields?)` | `(msg: string, fields?: LogFields) => void` |
| `warn(msg, fields?)` | `(msg: string, fields?: LogFields) => void` |
| `error(msg, fields?)` | `(msg: string, fields?: LogFields) => void` |

- `LogLevel` is `'debug' | 'info' | 'warn' | 'error'`.
- `LogFields` is `Record<string, string | number | boolean | null | undefined>`.

```ts
const logger: Logger = {
  debug: () => {},
  info: (msg, fields) => console.log(msg, fields),
  warn: (msg, fields) => console.warn(msg, fields),
  error: (msg, fields) => console.error(msg, fields),
}
new Queue('emails', { logger })
```

## consoleLogger

`consoleLogger(opts?)` returns a `Logger` that writes to `console.debug`, `console.info`, `console.warn` and `console.error`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `level` | `LogLevel \| 'silent'` | `'warn'` | Lowest level written. `'silent'` writes nothing. |

```ts
consoleLogger({ level: 'debug' })
```

Leaving out the queue's `logger` is the same as `consoleLogger()`.

## pinoLogger

`pinoLogger(pino)` adapts a [pino](https://getpino.io) logger, or anything with the same call shape. pino puts the fields first and the message second; the adapter swaps them. pino is not a dependency of SureQ.

```ts
import pino from 'pino'

new Queue('emails', { logger: pinoLogger(pino({ level: 'info' })) })
```

`PinoLike` is the shape it accepts: `debug`, `info`, `warn` and `error`, each `(obj: object, msg?: string) => void`.

## What SureQ logs

SureQ does not log each job. Use [events](06-events.md) such as `completed`, `failed` and `retrying` for that. It logs errors and one-off advice.

Errors from the store, from SureQ itself and from a backoff strategy or `retryIf` are logged at `error` as `sureq <source> error: <message>`, with the fields `code`, `source`, `queue` and, when known, `operation`, `jobId` and `workerId`. Each is also an `error` event. The same message is logged at most once every 10 s; the events are never limited. A listener that throws is reported only as an `error` event, and a throwing `error` listener is logged as `sureq error`.

The advice lines:

| Level | When |
|---|---|
| `warn` | The first `process()` on a store that is not durable: `store is not durable; jobs are lost on restart`. |
| `warn` | A bounded `retention.failed` is set while dead letters are on. |
| `warn` | An alert started firing. |
| `warn` | More than `metrics.maxNameLabels` job names were seen. |
| `warn` | `sweepBatch` is above the store's claim limit. |
| `warn` | Workers of releases that are not next to this one share the queue. |
| `warn` | The store moved to a format this pod cannot read. |
| `warn` | A handler ignored its abort signal, or a batch outcome was discarded. |
| `warn` | A schedule kept its stored, higher `version`. |
| `info` | An alert resolved, or the store format became readable again. |
| `info` | A queue or producer uses the default namespace `'default'`. |
| `debug` | The queue `filter` rejected an add, or handlers whose job was lost or cancelled were still running at close. |

With the default logger only `warn` and `error` lines show. Do not match on the message text: it may change. Use events for anything your code depends on.
