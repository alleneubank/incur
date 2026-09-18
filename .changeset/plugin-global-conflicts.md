---
'@alleneubank/incur': patch
---

Plugin-mounted commands are checked for option and alias collisions with the CLI's global options, like commands mounted any other way. A collision fails at startup with `Command '<path>' option '<key>' conflicts with a global option`, where before the command ran and the global silently won.
