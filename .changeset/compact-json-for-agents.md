---
'@alleneubank/incur': minor
---

`--json` and `--format json` write compact single-line JSON when stdout is not a TTY (agents, pipes), cutting the tokens spent on indentation. Output to a terminal stays indented. `Formatter.format` accepts `{ pretty: false }` to request compact JSON directly.
