---
'@alleneubank/incur': patch
---

`--filter-output` paths through the same array merge per element: `users[0].name,users[0].age` keeps both fields (the second path used to replace the first), and `users[1].age,users[0].name` keeps the two users separate.
