# Upgrade notes

1.0 is the first public release of SureQ. No earlier version was published, so there is nothing to migrate.
This page is for teams that ran a 0.x build from source, and for rolling deploys from now on.

## Mixed-version pods

During a rolling deploy, old and new pods share one store for a while. That works between adjacent releases: the same major version, and minor versions at most one apart. The patch number does not matter. So 1.0 and 1.1 can share a store, but 1.0 and 1.2 should not.

Every 60 seconds, a queue with a running worker lists the live workers of its queue. When some of them run a release that is not adjacent to its own, it logs one warning and emits `versionSkew` once for that set of workers. It is a warning only: it never stops anything.

```ts
queue.on('versionSkew', ({ workers }) => {
  for (const w of workers) console.warn('old pod still running', w.workerId, w.sureqVersion)
})
```

- If you see it, finish the deploy so that every pod runs the same major and minor release.
- Pods on 0.3.x beside pods on 1.0.0-rc.1 emit `versionSkew`, because the major versions differ. Do not mix them for longer than the deploy takes.
- A pod refuses a store written in a format it cannot read, with `StoreFormatError`. A running pod whose store moves to a newer format stops claiming and reports `STORE_FORMAT_AHEAD`. See [Troubleshooting](02-troubleshooting.md#a-pod-stopped-claiming-after-a-deploy).

See [Events: store and pods](../03-reference/06-events.md#store-and-pods) for the payload.

## Coming from 0.x

If you built 0.x from source, these are the changes you may notice in 1.0:

- **Node.js only, checked on first use.** Constructing a `Queue` or `Producer` on a runtime without Node's `process` throws `UnsupportedRuntimeError`. Importing the package still works.
- **Every store call has a deadline.** The new queue option `storeCallTimeout` (default `30s`) fails a hung call with a retryable `StoreUnavailableError` and starts reconnecting.
- **Fewer timers keep the process alive.** Only running workers, active jobs, a running scheduler and calls still waiting on SureQ do. See [Troubleshooting](02-troubleshooting.md#the-process-does-not-exit).
- **Test-only members are gone from the types.** `queue.internals`, `MemoryStore`'s `dump()`, `unsafeMutate()` and `faults` option, and the `random` option are no longer in the published types. Test through the public API instead. See [Testing your jobs](../02-guides/15-testing-your-jobs.md).
- **The store format and store contract did not change, but the contract version is now 1.** Both 0.3 and 1.0 write store format 1, and the contract itself is the same. 0.3 numbered it 2; 1.0, the first published release, numbers it 1. A store adapter built for 0.3 must set `contractVersion` to `STORE_CONTRACT_VERSION` (1), or 1.0 refuses it at start-up with `StoreContractVersionError`.

The full list is in the CHANGELOG.

## Before each upgrade

- Read the CHANGELOG entry for the new version.
- The store contract is experimental until 1.1, so it may change in a minor release before then. Upgrade SureQ and your store adapter together. A mismatch fails at start-up with `StoreContractVersionError`. See [Contract version](../04-stores/01-store-contract.md#contract-version).
- Deploy one minor version at a time, so every pair of pods is adjacent.
