---
'@alleneubank/incur': patch
---

Resolve agent skill directories from `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` on every `skills add`/sync call instead of once at import, so a home directory set after import (as in-process tests do) is honored instead of writing to the real one.
