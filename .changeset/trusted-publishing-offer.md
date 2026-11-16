---
"changesets-release": patch
---

Stop offering to configure npm trusted publishing right after the first publication of a package, since npm drops the configuration if it does not publish within 2 days.
