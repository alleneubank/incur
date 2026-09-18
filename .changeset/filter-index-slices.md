---
'@alleneubank/incur': patch
---

`--filter-output` accepts `key[n]` (one element, `[-1]` the last) and `key[]` (every element) alongside `key[start,end]`. A malformed path is a flag error instead of an empty result.
