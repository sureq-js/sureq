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
- **What is committed.** Source, tests, config, scripts and `CHANGELOG.md` are committed; every user-visible change
  gets a CHANGELOG line. Planning documents are kept outside the repository.

## Commit style

`type(scope): summary`, a short lower-case summary of the behaviour with no trailing period, for example
`fix(worker): lost wake-up on close`. Types in use: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. The scope
is optional.
