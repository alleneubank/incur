---
'@0xbigboss/incur': patch
---

Fix MCP stdio transport import so it is statically analyzable by `bun build --compile`. The previous dynamic specifier caused compiled single-file executables to fail at runtime with "Cannot find module '@modelcontextprotocol/server/stdio'". The import remains lazy and is only evaluated when an MCP server actually starts.
