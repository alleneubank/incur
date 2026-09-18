---
'@alleneubank/incur': patch
---

`--filter-output` no longer warns `Unknown field` for keys an output schema allows without declaring them: loose objects, records, catchalls, and unconstrained values such as `z.unknown()`. Objects closed with `additionalProperties: false` (plain `z.object`) still warn.
