# Changelog

All notable changes to `@sureq/store-test`, the conformance suite for SureQ stores. It is versioned on its own; its
`@sureq/core` peer dependency says which core versions it works with. Core's own changes are in
[packages/core/CHANGELOG.md](../core/CHANGELOG.md).

## 1.0.1 - 2026-11-20

No code or behaviour changes.

**Changed**
- The npm package lists keywords, so it shows up in npm search.
- The README shows npm, CI, license, Node, security-policy, Snyk and docs badges.

## 1.0.0 - 2026-11-17

First published release.

**Added**
- `runStoreConformance`: checks a store against the store contract (claims, leases, fencing tokens, sweeping, release, cancel, pause, the store clock and the duplicate rules), registering its tests with node:test, Vitest or Jest.
- Every public declaration has a doc comment, and the public API is recorded in an API Extractor report.
