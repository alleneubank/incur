---
'@alleneubank/incur': patch
---

A positional argument the command does not declare is a parse error (`Unexpected positional argument 2; this command takes 1: <channel>`) instead of being dropped; the value is not echoed. A boolean flag followed by `true` or `false` takes that value, so `--dry false` is false.
