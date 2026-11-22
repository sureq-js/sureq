# Changelog

Each package is versioned and released on its own, so each keeps its own changelog:

| Package | Changelog |
| --- | --- |
| [`@sureq/core`](packages/core) | [packages/core/CHANGELOG.md](packages/core/CHANGELOG.md) |
| [`@sureq/store-test`](packages/store-test) | [packages/store-test/CHANGELOG.md](packages/store-test/CHANGELOG.md) |

A package's `peerDependencies` say which `@sureq/core` versions it works with. A `@sureq/core` release does not
republish the other packages: their peer range already accepts any compatible core version.
