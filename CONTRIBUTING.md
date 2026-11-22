# Contributing

## Setup

Node.js 22 or later. Install with `npm ci` at the repository root; it installs every workspace.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Build the published packages |
| `npm run typecheck` | Type-check every workspace |
| `npm run lint` | ESLint, plus the runtime-neutrality check on the source |
| `npm test` | Unit and integration tests |
| `npm run test:types` | Type-level tests of the public API |
| `npm run test:dist` | Tests against the built ESM and CommonJS output |
| `npm run test:gates` | Stress, chaos, shutdown and conformance tests at full scale |
| `npm run coverage` | Tests with coverage thresholds |
| `npm run api:check` | Fail when the public API differs from the committed report |
| `npm run check:pkg` | Check the packed packages (exports, types, contents) |
| `npm run check:neutral` | Runtime-neutrality check on the source and the built output |
| `npm run check:licenses` | Fail on a disallowed licence or a runtime dependency in a published package |

Run `npm test`, `npm run lint`, `npm run typecheck` and `npm run check:pkg` before opening a change.

## Git hooks and CI

- **Before each commit:** lint on the staged files, then `npm test`.
- **Before each push:** `scripts/ci-local.sh` runs every CI step on this machine (about 25 minutes), so a red CI run is
  caught first. A push of tags only skips it: a release tag goes on a commit that is already on `main` and was tested.
  `SUREQ_SKIP_PREPUSH=1` skips it in an emergency; CI still runs on GitHub.
- **On a pull request:** CI runs every job, except for a pull request that changes only documentation
  (`user-docs/`, `docs-site/`, `skills/`, `brand/` or `*.md` files), which runs the unit tests alone, since they check
  the docs against the code. The `ci` job reports the result as one check, and it is the check `main` requires. A new
  push to a pull request cancels its run that is still going.

## Skipped tests

Some tests are reported as skipped on purpose:

- **Store capabilities.** A test that needs a store capability `MemoryStore` does not have (for example a durable
  or shared store) is skipped in the memory and store conformance suites. It runs against any store that declares
  the capability.
- **Planning documents.** A few tests cross-check the code against the local planning documents. Those documents
  are never committed, so the tests run only where they exist and are skipped in CI and on a fresh clone.

## Rules

- **Runtime neutrality.** `@sureq/core` uses no Node-only API (`node:` modules, `Buffer`,
  `process`, `setImmediate`, ...) outside the platform layer in `packages/core/src/platform`. Lint enforces it.
- **No runtime dependencies** in the published packages.
- **Public API changes are deliberate.** When you change the public API on purpose, run `npm run api:update` and
  commit the changed report under `etc/` with the change.
- **Code text names behaviour, not plans.** Comments, test titles and messages describe what the code does; they do
  not refer to planning documents, ticket numbers or release numbers.
- **What is committed.** Source, tests, config, scripts and each package's `CHANGELOG.md` are committed; every
  user-visible change gets a line in the changelog of the package it changes. Planning documents are kept outside the
  repository.

## Releases

Each package under `packages/` is versioned and published on its own. A change to `@sureq/core` does not republish
`@sureq/store-test` or a store adapter: their `@sureq/core` peer range (`^1.0.1`) already accepts a newer compatible
core.

1. Bump `version` in that package's `package.json` (and, for core, `SUREQ_VERSION` and the agent skill's
   `metadata.version`, which tests keep equal to it). Move its changelog's notes under `## <version> - <date>`.
2. Raise another package's `@sureq/core` peer range only when it starts to need a newer core, and release that
   package too, with a changelog line saying so.
3. Merge to `main`, then push a tag `<package name>@<version>` on that commit, such as `@sureq/core@1.0.2`. The
   `publish` workflow checks the tag against the package's version and that the commit is on `main`, waits for the
   `npm-publish` environment's approval, and publishes only that package. A version with a hyphen
   (`1.1.0-rc.1`) is published under the `next` dist-tag.

A new package is published by hand once, because npm's trusted publishing can only be set up for a package that
exists. After that first publish, add the trusted publisher on npmjs.com (this repository, workflow `publish.yml`,
environment `npm-publish`), add the package to the root `CHANGELOG.md` index, and release it with tags from then on.

## Commit style

`type(scope): summary`, a short lower-case summary of the behaviour with no trailing period, for example
`fix(worker): lost wake-up on close`. Types in use: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. The scope
is optional.
