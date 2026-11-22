# Install SureQ

## Requirements

- Node.js 22 or newer.
- No other runtime dependencies.

## Install the package

```sh
npm install @sureq/core
```

## ESM and CommonJS

The docs use ES modules (`import`). CommonJS works too:

```js
const { Queue, MemoryStore } = require('@sureq/core')
```

## TypeScript

SureQ ships its own type definitions, so there is nothing extra to install.
Use a module setting that reads the package `exports` map, such as:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

`moduleResolution` can also be `"Bundler"` if you use a bundler.
Producer-only code imports from the `@sureq/core/producer` entry, which needs one of these settings. See [Producer-only pods](../02-guides/12-producer-only-pods.md).

## Where jobs are stored

A `Queue` with no `store` option creates its own in-memory store. That is all you need to try SureQ, write tests, or run jobs inside one process.

To share one store between several queues in the same process, create a `MemoryStore` and pass it in:

```ts
import { MemoryStore, Queue } from '@sureq/core'

const store = new MemoryStore()
const emails = new Queue('emails', { store })
const reports = new Queue('reports', { store })
```

A queue closes only a store it created. A store you pass in stays open after `queue.close()`, so close it yourself with `await store.close()` when you are done.

The in-memory store is not durable. Jobs are lost when the process exits, and other processes cannot see them. When the first worker starts on it, SureQ logs one warning. For a queue named `emails`, the default logger prints:

```text
store is not durable; jobs are lost on restart { queue: 'emails' }
```

You need a durable store when:

- jobs must survive a restart or a deploy, or
- several processes or pods share one queue.

A durable store is a store adapter that implements the store contract. A `Producer` always needs a `store` option, because it never creates one. The store contract is experimental until 1.1. See [Stores](../04-stores/01-store-contract.md).

## AI coding agents

SureQ has an agent skill: rules and reference notes a coding agent reads before it writes SureQ code, so it uses the defaults, avoids the common mistakes and finds the right reference page. Install it into your project with the [skills CLI](https://www.npmjs.com/package/skills), which supports Claude Code and other agents:

```sh
npx skills add sureq-js/sureq --skill sureq
```

The skill is in [`skills/sureq`](https://github.com/sureq-js/sureq/tree/main/skills/sureq) in the repository. Agents can also read these docs as plain Markdown: [llms.txt](https://sureq-js.github.io/sureq/llms.txt) lists every page, and [llms-full.txt](https://sureq-js.github.io/sureq/llms-full.txt) has them all in one file.

## Next

[Build your first queue](02-first-queue.md).
