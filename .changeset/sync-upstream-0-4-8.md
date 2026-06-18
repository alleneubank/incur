---
"@0xbigboss/incur": minor
---

Sync the fork with upstream `wevm/incur` v0.4.8 and re-reconcile the fork's value-add on top of the new base.

Breaking changes:

- The global `--verbose` flag is renamed to `--full-output` (upstream wevm/incur#128).
- MCP server migrated from `@modelcontextprotocol/sdk` to `@modelcontextprotocol/server` (upstream wevm/incur#117).

Fork features retained and rebased onto the new upstream:

- Agent-safe CLI execution controls.
- Hardened string/path schemas and output sanitization.
- Generated plugin system (Connect RPC + GraphQL).
- OpenAPI: Swagger 2.0 support, runtime operation metadata, and a `--json` body escape hatch.
- Skills: `sync.skills` inline option and enriched skill metadata.
- Parser: `--no-<flag>` literal field when the negation target is missing.

Includes all upstream changes through v0.4.8 (OpenAPI dereferencing rewrite, generated header options, naming config, skills list / stale warnings, command aliases, and more).
