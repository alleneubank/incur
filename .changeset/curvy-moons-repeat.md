---
'@0xbigboss/incur': minor
---

Rebase the fork onto upstream `wevm/incur` at `abd9af3` (upstream 0.4.26).

Picks up 18 upstream patch releases (upstream 0.4.9 through 0.4.26) beneath the
fork's own commits. Two fork patches were dropped as superseded — upstream fixed
both independently:

- The MCP `@modelcontextprotocol/server` prerelease drift. Upstream now pins the
  exact version `2.0.0-alpha.4`, which is what this fork resolves to.
- Non-object MCP output schemas, and the JSON-Schema-vs-Standard-Schema mismatch
  in `tools/list`. Upstream's `fromJsonSchema()` wrapper covers both.

Two upstream features arrive as new runtime dependencies for the generated
plugin system: `@bufbuild/protobuf` and `@connectrpc/connect` /
`@connectrpc/connect-node`.

The fork's own deltas are unchanged: agent-safe execution controls, the OpenAPI
swagger2/runtime-metadata work, `sync.skills` inline options, the `--no-<flag>`
parser fix, `@0xbigboss` packaging, and `$HOME` isolation for skills metadata in
the test suite.
