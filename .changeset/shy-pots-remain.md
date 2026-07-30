---
'@0xbigboss/incur': patch
---

Isolate skills metadata from the developer's home in the test suite.

`hashPath()` falls back to `~/.local/share` when `XDG_DATA_HOME` is unset, and
isolation in `SyncSkills.test.ts` was opt-in — most tests set it, several did
not. Every test that forgot wrote a real metadata file into the developer's
home, named after the CLI it constructed.

One fixture builds a CLI named `devctl`, records an `includeCwd` pointing at a
temp dir, then deletes that dir — leaving a real
`~/.local/share/incur/devctl.json` referencing a path that no longer exists.
Any machine that ran the suite then broke the actual `devctl` CLI, which reads
that file at startup.

Isolation is now default-on via `beforeEach`, with a guard test that omits
`XDG_DATA_HOME` and asserts the write stays contained. Test-only change; no
runtime behaviour differs for consumers.
