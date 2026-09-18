# incur — Agent Guidelines

> **Update after learnings or mistakes** — when a correction, new convention, or hard-won lesson emerges during development, append it to the relevant section of this file immediately. AGENTS.md is the source of truth for project conventions and should grow as the project does.

## TypeScript Conventions

- **Exact optional properties** — `exactOptionalPropertyTypes` is enabled in tsconfig. Optional properties must include `| undefined` in their type if they can be assigned `undefined` (e.g. `foo?: string | undefined`, not `foo?: string`).
- **No `readonly`** — skip `readonly` on type properties.
- **`type` over `interface`** — always use `type` for type definitions.
- **`.js` extensions** — all imports include `.js` for ESM compatibility.
- **Classes for errors only** — all other APIs use factory functions.
- **No enums** — use `as const` objects for fixed sets.
- **`const` generic modifier** — use to preserve literal types for full inference.
- **camelCase generics** — `<const args extends z.ZodObject<any>>` not `<T>`.
- **Options default `= {}`** — use `options: Options = {}` not `options?: Options`.
- **Minimal variable names** — prefer short, obvious names. Use `options` not `serveOptions`, `fn` not `callbackFunction`, etc. Context makes meaning clear.
- **No redundant type annotations** — if the return type of a function already covers it, don't annotate intermediate variables. Let the return type do the work (e.g. `const cli = { ... }` not `const cli: ReturnType = { ... }`).
- **Return directly** — don't declare a variable just to return it. Use `return { ... }` unless the variable is needed (e.g. self-reference for chaining).
- **Skip braces for single-statement blocks** — omit `{}` for single-statement `if`, `for`, etc.
- **Destructure when accessing multiple properties** — prefer `const { a, b } = options` over repeated `options.a`, `options.b`.
- **IIFE for multi-branch assignment** — use an IIFE instead of nested ternaries when assigning a value from multiple conditions. Add a comment to every branch explaining the case.

## Type Inference Conventions

- **`z.output<>` over `z.infer<>`** — use `z.output<schema>` for types after transforms/defaults are applied (what `schema.parse()` returns at runtime). Use `z.input<schema>` only when representing pre-validation types.
- **`const` generics on definitions** — any function that accepts Zod schemas and passes them to callbacks must use `const` generic parameters to preserve literal types (e.g. `<const args extends z.ZodObject<any>>`).
- **Flow schemas through generics** — when a factory function accepts Zod schemas, use generics to flow `z.output<>` through to callbacks (`run`, `next`), return types, and constraint types (`alias`). Never fall back to `any` in callback signatures.
- **Type tests in `.test-d.ts`** — use vitest's `expectTypeOf` in colocated `.test-d.ts` files to assert generic inference works. Type tests are first-class — write them alongside implementation, not as an afterthought.
- **No `any` leakage** — Zod schemas may use `z.ZodObject<any>` as a generic bound, but inferred types flowing to user-facing callbacks must be narrowed via `z.output<typeof schema>`. The user should never see `any` in their IDE.
- **Type inference after every feature** — after implementing any feature, check if new types can be narrowed. If a new property, callback, or return type touches a Zod schema, add generics to flow the inferred type through. Add or update `.test-d.ts` type tests alongside.

## Documentation Conventions

- **JSDoc on all exports** — every exported function, type, and constant gets a JSDoc comment. Type properties get JSDoc too. Namespace types (e.g. `declare namespace create { type Options }`) get JSDoc too. Doc-driven development: write the JSDoc before or alongside the implementation, not after.
- **Parse structured frontmatter structurally** — when `SKILL.md` frontmatter is emitted as YAML, read it back with the YAML parser instead of regex-scraping individual fields.

## Testing Conventions

- **Snapshot tests for deterministic output** — prefer `toMatchInlineSnapshot()` for deterministic string outputs (TOON, JSON, etc.). If output is mostly deterministic with a few dynamic properties (e.g. `duration`), extract and assert those separately, then snapshot the rest.

## Binary Build Conventions

- **Compile through a wrapper** — Bun treats a CLI default export with `fetch` as a server, so standalone builds import the entry through a side-effect-only wrapper.
- **Keep release sets coherent** — remove stale managed artifacts before publishing a completed build while preserving unrelated output files.
- **Mark generated installers** — replace or clean `install.sh` and `install.ps1` only when their Incur marker is present; reject collisions with unmanaged files.
- **Pin generated installers** — a mutable latest-release URL may select an installer, but the generated script must download binary assets from its embedded exact release tag.
- **Release from one Linux action** — run `release@v1` as a step on `ubuntu-latest` with `contents: write`; it cross-compiles unsigned assets for every target.
- **Infer release action inputs** — default to `./src/bin.ts`, derive the CLI name and stable version, and treat `entry`, `name`, and `release_tag` as overrides.
- **Append to existing releases** — default to the latest published release, require its tag to match the package version, and never create or modify releases or tags.
- **Trust action release inputs** — install, build, and upload share one job's write permission; `persist-credentials: false` does not create a permission boundary.
- **Limit smoke tests to the runner** — test only matching-architecture Linux glibc and musl assets; native macOS and Windows tests and signing stay out of scope.
- **Install musl runtime libraries** — Bun musl executables require `libstdc++` and `libgcc`; install both before Alpine smoke tests.
- **Test spaced version overrides** — command-local `--version <value>` must not be consumed as the root boolean `--version` flag.

## Git Conventions

- **Conventional commits** — use `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:` prefixes. Scope is optional (e.g. `feat(parser): add array coercion`).
- **Changesets for package changes** — user-facing fixes and features require a `.changeset/*.md` entry in the same PR. Use `patch` for fixes, `minor` for additive features, and `major` for breaking changes. Skip only for tests, docs, or internal-only changes that do not affect the published package.
- **Fork vs upstream commits** — see Fork Maintenance. Upstream-bound work has no marker. Fork-only work uses `[fork] <type>(<scope>): <imperative summary>`.

## Fork Maintenance

This repository is a personal fork of `wevm/incur`, published as `@alleneubank/incur`. The gist at https://gist.github.com/alleneubank/bf7d25542a49b136671db0e4bb65226d is the operator's general fork-shipping law; this section is the incur-specific standing law.

**One default branch.** `main` is the dogfood tip. Unmarked feats and `[fork]` commits live there together. Do not keep a parallel `fork` branch. Cut releases from `main`. Truly upstreamable work is a small branch against `upstream/main` (cherry-pick only unmarked feat/fix commits). Never open an upstream PR from `main` as-is. `git diff upstream/main..main` includes `[fork]` commits and is not the PR set.

**Remote names are roles.** Inspect `git remote -v` before acting:

- `source_remote` = `upstream` → `https://github.com/wevm/incur.git`
- `fork_remote` = `origin` → `git@github.com:alleneubank/incur.git`

Never infer the role from the remote name alone.

**Commit tagging.** The test: *would this commit go in an upstream PR?* yes → no tag; no → `[fork]`.

- Upstream-bound: conventional subject only (`feat(skills): ...`, `fix(parser): ...`).
- Fork-only: `[fork] <type>(<scope>): <imperative summary>` — packaging (`@alleneubank/incur`), fork changelog/version bookkeeping, this section of AGENTS.md, release/trusted-publishing plumbing.

Split mixed work at the **upstreamability boundary**. A generic extension point and its tests belong in an unmarked commit. Scope names, dogfood policy, and npm/GitHub publish wiring belong in a `[fork]` commit.

**Amend, don't accrete.** Iterating on an unmerged feature rewrites the existing commit. `fix` is for a genuine defect in already-merged upstream code, not for iterating on unreviewed fork work. Rewrite mixed single-author history while it is cheap: backup tag first, prove the intended tree is unchanged except for deliberate doctrine edits, then `--force-with-lease` only with an explicit publish grant.

**Sync loop** (run unattended after fetch + classify):

1. `git fetch --prune origin` and `git fetch --prune --tags upstream`.
2. From `main`, `previous_base=$(git merge-base main upstream/main)`. Inspect `git log --oneline "$previous_base"..upstream/main` and `git diff --stat "$previous_base"..upstream/main` before replaying.
3. Classify every fork commit: **drop** when upstream supersedes the behavior, **adopt** when upstream's implementation should replace it and only fork policy remains, **adapt** when fork behavior must be rewritten against upstream's current types and APIs. Add focused regression coverage for every adaptation. Never preserve stale compatibility code merely because it compiles.
4. Backup: `git tag -a main-rebase-backup-$(date -u +%Y%m%d-%H%M%S) -m "pre-rebase backup" HEAD`. Then `git rebase --update-refs upstream/main`. Use `git rebase --skip` only for a commit classified as drop. Resolve conflicts from the recorded adopt/adapt decision, not by mechanically choosing either side.
5. Push `--force-with-lease` to `origin` only when the operator authorizes publishing the rewritten ref (single-author fork; never plain `--force`). Pushing `main` is a publish: it deploys the default branch and triggers Changesets publish in CI.
6. Version with `pnpm changeset version` (highest pending bump). Publish via CI trusted publishing (`pnpm run changeset:publish`), not a long-lived npm token. Do not cut a GitHub Packages/npm release from a dirty tree.
7. Offer upstream from `git switch -c feat/<name> upstream/main`, cherry-pick only unmarked feat/fix commits, PR that branch against `wevm/incur`. Never let a `[fork]` commit or a source edit made for build config leak into that branch.

**Package identity.** The published name is `@alleneubank/incur`. Changesets frontmatter must use that name, not `incur` or `@0xbigboss/incur`. Repository URL is `https://github.com/alleneubank/incur`.

**Trusted publishing.** CI publishes with npm OIDC (`id-token: write` on the Main workflow). Do not add classic npm tokens that bypass 2FA. Configure the npm trusted publisher for `@alleneubank/incur` as GitHub Actions on `alleneubank/incur`, workflow `Main`.
