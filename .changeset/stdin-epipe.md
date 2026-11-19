---
"changesets-release": patch
---

Fix a crash with `EPIPE` when creating a GitHub Release fails before `gh` reads the release notes.
