---
'@alleneubank/incur': patch
---

Exit quietly with code 0 when stdout closes before the CLI finishes writing (`cli … | head -1`), instead of crashing with an unhandled `EPIPE` error event.
