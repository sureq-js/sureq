<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo/sureq-horizontal-reversed.svg">
    <img src="brand/logo/sureq-horizontal.svg" alt="SureQ" height="64">
  </picture>
</p>

# SureQ

**Documentation: [sureq-js.github.io/sureq](https://sureq-js.github.io/sureq/)**

A TypeScript job queue for Node.js with pluggable storage: an in-memory store is built in, and durable stores for many pods on one queue plug in as separate adapter packages through the store contract. This repository is an npm-workspaces monorepo.

## Documentation

Start with the [SureQ documentation](user-docs/README.md): getting started, guides, the API reference, stores and operations. The published site is built from [`docs-site/`](docs-site/) (Protocol template + React Router).

| Package | Description |
| --- | --- |
| [`@sureq/core`](packages/core) | The queue, workers and the contract every store implements |
| [`@sureq/store-test`](packages/store-test) | Conformance suite for stores |

Writing your own store: follow the [adapter-author guide](user-docs/04-stores/02-writing-your-own.md) and copy the
[commented template](examples/store-template/README.md), which passes the full conformance suite.
