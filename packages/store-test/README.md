# @sureq/store-test

[![npm](https://img.shields.io/npm/v/@sureq/store-test.svg)](https://www.npmjs.com/package/@sureq/store-test)
[![CI](https://github.com/sureq-js/sureq/actions/workflows/ci.yml/badge.svg)](https://github.com/sureq-js/sureq/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@sureq/store-test.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@sureq/store-test.svg)](https://www.npmjs.com/package/@sureq/store-test)
[![security policy](https://img.shields.io/badge/security-policy-blue.svg)](https://github.com/sureq-js/sureq/blob/main/SECURITY.md)
[![Known Vulnerabilities](https://snyk.io/test/npm/@sureq/store-test/badge.svg)](https://snyk.io/test/npm/@sureq/store-test)
[![docs](https://img.shields.io/badge/docs-sureq--js.github.io-blue.svg)](https://sureq-js.github.io/sureq/)

Conformance suite for SureQ stores. It checks a store against the store contract: claims, leases, fencing
tokens, sweeping, release, cancel, pause, the store clock, and the duplicate rules (unique ids, singleton keys,
`seq` for idempotency keys, revision-checked writes for merges). A store that passes it is safe to put under a
SureQ queue.

```
npm install --save-dev @sureq/store-test @sureq/core
```

## Documentation

The options, the time modes, how to read a failure and the report format are in the
[conformance kit](https://github.com/sureq-js/sureq/blob/main/user-docs/04-stores/03-conformance-kit.md) page; the store contract and the guide to writing a
store are in [Stores](https://github.com/sureq-js/sureq/blob/main/user-docs/04-stores/01-store-contract.md).

## Use

Call `runStoreConformance` from a test file. It registers the tests with your test runner (node:test, Vitest
with `globals: true`, or Jest are detected; otherwise pass `runner`).

```ts
import type { Store } from '@sureq/core';
import { runStoreConformance } from '@sureq/store-test';

// Stand-in for your adapter; yours comes from your own package.
declare function createMyStore(opts: { prefix: string; clock?: () => number }): Store;

runStoreConformance({
  name: 'my-store',
  createStore: async (ctx) => {
    const store = createMyStore({ prefix: ctx.scopeId, ...(ctx.clock && { clock: () => ctx.clock!.now() }) });
    await store.open();
    return { store, cleanup: () => store.close() };
  },
  report: './conformance-report.json',
});
```

The report's `conformant` is `true` only when nothing failed and no required group was skipped. Raise your
runner's test timeout for the long tests (for Vitest, `testTimeout: 600_000`).

## Writing an adapter

The step-by-step guide is [Writing your own store](https://github.com/sureq-js/sureq/blob/main/user-docs/04-stores/02-writing-your-own.md): the six
primitives, the build order, an atomicity checklist for every method, the common mistakes and the test that catches
each, and publishing. The finished example is [`examples/store-template`](https://github.com/sureq-js/sureq/blob/main/examples/store-template/README.md),
a commented store that passes the whole suite.
