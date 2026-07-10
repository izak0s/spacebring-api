# Contributing

## Setup

```sh
npm ci
npm test
```

Node ≥ 20. No global tooling needed — everything runs through npm scripts.

## Architecture

Three layers, two of them generated:

1. **Types** — `src/generated/schema.ts`, produced by [openapi-typescript](https://github.com/openapi-ts/openapi-typescript) from `spec/openapi.json`.
2. **Transport** — [openapi-fetch](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch), exposed as `sb.raw`.
3. **Facade** — `src/generated/resources/*.ts`, produced by our own generator (`codegen/generate-facade.ts`): nested namespaces, positional path params, `iterate()` pagination, envelope unwrapping, named entity and query-parameter types.

Hand-written code is only `src/client.ts`, `src/core.ts`, `src/error.ts`, and the generator itself. **Never hand-edit anything under `src/generated/`** — change the generator and regenerate.

## Regenerating from the spec

Everything under `src/generated/` is produced from `spec/openapi.json`:

```sh
curl -o spec/openapi.json https://www.spacebring.com/docs/assets/openapi.json
npm run generate      # types (openapi-typescript) + facade (codegen/generate-facade.ts)
npm run typecheck
npm run test:update   # refreshes the API-surface snapshot; review its diff for surface changes
```

The generator derives namespaces from path segments and method names from path shape + operationId verbs (`codegen/generate-facade.ts` orchestrates; the rules live in `codegen/facade/analyze.ts` and `codegen/facade/naming.ts`, entity/query types in `codegen/facade/entities.ts`, emission in `codegen/facade/emit.ts`). It never drops an operation: anything that matches no naming rule is emitted under its full operationId and reported as a warning — a new warning after a regen means Spacebring broke a convention and the rule set needs a look. `tests/surface.test.ts` fails whenever the facade and spec disagree on coverage; its snapshots record every public method by name (`tests/__snapshots__/surface.test.ts.snap`) and every signature and exported type (`tests/__snapshots__/typed-surface.txt`), so both surface and signature changes always show up in review.

The `npm run generate` output is committed; CI regenerates and runs `git diff --exit-code`, so a stale or hand-edited generated file fails the build.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run generate` | Regenerate types + facade from `spec/openapi.json` |
| `npm run typecheck` | `tsc --noEmit` over src, codegen, tests, and examples |
| `npm run lint` | Biome (lint + format check) over hand-written code; `npm run lint:fix` applies |
| `npm test` | Vitest suite (mocked `fetch`, generator units, API-surface snapshot) |
| `npm run test:update` | Same, refreshing the surface snapshot after an intentional change |
| `npm run build` | tsup → `dist/` (ESM + CJS + d.ts) |
| `npm run example` | Runs `examples/basic.ts` against your live network (read-only calls; needs `SPACEBRING_CLIENT_ID` / `SPACEBRING_CLIENT_SECRET`) |

## Release flow

- `.github/workflows/regen.yml` — daily cron (16:00 UTC): downloads the latest spec (sanity-checked: refuses a spec that lost >10% of operations), regenerates, validates, and opens a PR on the `auto/spec-update` branch when anything changed (using `RELEASE_TOKEN` so CI runs on the PR). The PR body flags whether the public API surface changed and includes a markdown summary of method, operation, and schema changes (`codegen/diff-spec.ts` diffs the old and new spec + surface snapshot). Schema-only PRs (no snapshot diff) auto-merge once required CI passes; surface-visible changes wait for review. Dependabot patch/minor PRs auto-merge the same way (`dependabot-automerge.yml`).
- `.github/workflows/auto-release.yml` — when that PR merges, bumps the version and pushes a `v*` tag: **minor** normally, **major** when the surface snapshot lost any public method (removed/renamed = breaking). Needs a `RELEASE_TOKEN` repo secret (PAT with contents write) so the tag push can trigger workflows.
- `.github/workflows/publish.yml` — on `v*` tags: runs full CI as a gate, verifies the tag matches `package.json`, publishes to npm via OIDC trusted publishing, and creates a GitHub release whose notes lead with the API diff since the previous tag (same `diff-spec.ts` summary).

Manual releases: `npm version <patch|minor|major> && git push --follow-tags`.
