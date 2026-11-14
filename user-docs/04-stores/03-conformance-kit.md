# Conformance kit

`@sureq/store-test` is the test suite for SureQ stores. It checks a store against the [store contract](01-store-contract.md): claims, leases, fencing tokens, sweeping, release, cancel, pause, the store clock, the duplicate rules, schedules, the worker registry and more. A store that passes it is safe to put under a SureQ queue.

> **Experimental until 1.1.** The suite grows with the store contract. State the suite version you passed in your adapter's README.

```text
npm install --save-dev @sureq/store-test @sureq/core
```

## Run it

Call `runStoreConformance` from a test file. It registers the tests with your test runner: `node:test`, Vitest with `globals: true`, and Jest are found by themselves; for any other runner pass `runner`.

This example runs the whole suite against the built-in `MemoryStore` with `node:test`. Save it as `conformance.test.ts` and run `node --test conformance.test.ts`; it finishes in under a minute.

```ts
import { MemoryStore } from '@sureq/core'
import { runStoreConformance } from '@sureq/store-test'

runStoreConformance({
  name: 'memory-store',
  report: './conformance-report.json',
  createStore: async (ctx) => {
    const clock = ctx.clock
    const store = new MemoryStore(clock ? { clock: () => clock.now() } : {})
    return { store, cleanup: async () => {} }
  },
})
```

For your own store, return your store from `createStore` instead, opened or not: the suite opens it. `cleanup` should drop whatever the group created.

- `createStore` is called once per group, and again when a test needs an extra store object (another simulated pod, or a fresh store).
- Each test uses its own namespace, `conf-<id>`, and removes its jobs when it ends. `ctx.scopeId` is unique per call: use it as a key prefix or a database schema name.
- Long tests, such as the real-time groups, take longer than a runner's default timeout. Raise it; for Vitest, `testTimeout: 600_000`. The suite enforces its own limit per test and reports a timeout as a failure.

## Options

`ConformanceOptions`:

| Name | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | required | The store's name, written to the report. |
| `createStore` | `(ctx: HarnessContext) => Promise<StoreHandle>` | required | Makes a store for a group. See [createStore](#createstore). |
| `runner` | `RunnerHooks` | found by itself | `{ describe, it, before, after }` of your test runner. |
| `concurrency` | `number` | `20` | Simulated pods in race tests. Below 10 the run is not conformant. |
| `iterations` | `number` | `200` | Repeats of every race test. One failed iteration fails the test; nothing is retried. |
| `timeScale` | `number` | `1` | Multiplies every real wait. Use `3` for a slow database. |
| `skip` | `string[]` | `[]` | Groups to skip. Only `capabilities:notify`, `capabilities:transactions`, `capabilities:durable`, `capabilities:shared` and `capabilities:skipLocked` keep the run conformant. |
| `groups` | `string[]` | `[]` | Extra opt-in groups to run. `stress` is one: many claimers on one queue at a large size. It never counts toward conformance. A name that is not a group throws `InvalidOptionError` with the closest group name. |
| `realTime` | `boolean` | `false` | Run every group on the store's real clock, for a store whose clock cannot be faked. The one test that checks the store follows an injected clock is then skipped; the run can still be conformant. |
| `core` | `(store: Store, scope: Scope) => unknown` | none | Builds a core queue over the store in `scope`, for tests that need core's own loops. Without it, those tests are left out and `merge:core` is listed in `skippedGroups`; the run can still be conformant. |
| `report` | `string` | none | Path of the JSON report to write. |

```ts
runStoreConformance({ name: 'sureq-store-mydb', createStore, concurrency: 50 })
runStoreConformance({ name: 'sureq-store-mydb', createStore, iterations: 1000 })
runStoreConformance({ name: 'sureq-store-mydb', createStore, timeScale: 3 })
runStoreConformance({ name: 'sureq-store-mydb', createStore, skip: ['capabilities:notify'] })
runStoreConformance({ name: 'sureq-store-mydb', createStore, groups: ['stress'] })
runStoreConformance({ name: 'sureq-store-mydb', createStore, realTime: true })
runStoreConformance({ name: 'sureq-store-mydb', createStore, core: (store, scope) => new Queue(scope.queue, { store, namespace: scope.namespace }) })
runStoreConformance({ name: 'sureq-store-mydb', createStore, report: './conformance-report.json' })
runStoreConformance({ name: 'sureq-store-mydb', createStore, runner: { describe, it, before, after } })
```

### createStore

`createStore(ctx)` gets a `HarnessContext` and returns a `StoreHandle`.

| `HarnessContext` field | Type | Meaning |
|---|---|---|
| `clock` | `TestClock \| null` | The clock the store must read. `null` means the store uses its real clock. |
| `scopeId` | `string` | A unique id for this call. |

| `StoreHandle` field | Type | Meaning |
|---|---|---|
| `store` | `Store` | The store under test. |
| `cleanup` | `() => Promise<void>` | Drops what this store created. Called when the group ends. |
| `reopen` | `() => Promise<Store>`, optional | A new store object over the same data, as after a restart. Required when the store declares `durable`. |

`TestClock` is `{ now(): number; advance(ms: number): void }`.

## Time

When `ctx.clock` is not `null`, the store must read the time from `ctx.clock.now()`. The suite moves that clock forward to expire leases at once (fake mode). When it is `null`, the store uses its real clock and the suite really waits; leases are then `1000 × timeScale` ms.

The `clock` and `lease` groups always run in real time, even in a fake run: a fake clock cannot prove that the backend reads its own clock. Tests that move this process's `Date.now` by an hour check that the store never uses the caller's clock.

## Reading a failure

A test title starts with its group, such as `claim:`, `fencing:` or `sweep:`. The group names the contract rule that was broken. A race test's message starts with `iteration N:`; re-run with a larger `iterations` to reproduce it. Tests that need a capability your store does not declare are skipped and counted.

Run one group at a time with your runner's title filter:

```text
node --test --test-name-pattern="claim:" conformance.test.ts
npx vitest run -t "claim:"
```

## Report

With `report` set, the suite writes a `ConformanceReport` as JSON after the last test. This one is from the example above, with `capabilities` shortened.

```json
{
  "suite": "1",
  "contractVersion": 1,
  "store": "memory-store",
  "capabilities": { "transactions": true, "skipLocked": true, "notify": true, "durable": false, "shared": false },
  "passed": 284,
  "failed": 0,
  "skipped": 8,
  "skippedGroups": ["merge:core", "capabilities:durable", "capabilities:shared"],
  "conformant": true,
  "mode": "fake",
  "modes": { "clock": "real", "lease": "real", "rest": "fake" },
  "concurrency": 20
}
```

| Field | Type | Meaning |
|---|---|---|
| `suite` | `string` | The suite version, `SUITE_VERSION`. |
| `contractVersion` | `number` | The contract version of the `@sureq/core` the suite ran against (its `STORE_CONTRACT_VERSION`), not the store's. |
| `store` | `string` | The `name` option. |
| `capabilities` | `StoreCapabilities \| null` | The store's declared capabilities. |
| `passed`, `failed`, `skipped` | `number` | Test counts. |
| `skippedGroups` | `string[]` | Groups that did not run. |
| `conformant` | `boolean` | See below. |
| `mode` | `'fake' \| 'real'` | The clock mode of the run. |
| `modes` | `{ clock, lease, rest }` | The mode each part actually ran in. |
| `concurrency` | `number` | Simulated pods in race tests. |

`conformant` is `true` only when nothing failed, no group other than a `capabilities:` gate (or `merge:core`) was skipped, `concurrency` is at least 10, and the `clock` and `lease` groups ran in real time.

## Exports

| Export | Meaning |
|---|---|
| `runStoreConformance(options)` | Registers the suite with the test runner. Returns nothing. |
| `SUITE_VERSION` | The suite version, `'1'`. |
| `ConformanceOptions`, `ConformanceReport`, `HarnessContext`, `StoreHandle`, `RunnerHooks`, `TestClock` | The types above. |

See [Writing your own store](02-writing-your-own.md) for the build order that maps each group to the methods it checks.
