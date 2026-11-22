# changesets-release

## 2.3.0

### Minor Changes

- 0a9b4ea: With `--only`, also apply the pending changesets of the packages that Changesets releases along with the selected ones.
- e92da51: Publish the first versions of new packages from your machine and the other packages from GitHub Actions in one release.
- 241e745: With `--only`, apply a changeset that also bumps other packages to the selected packages, and keep it pending for the others.

## 2.2.0

### Minor Changes

- e0dfabd: Add `--only <package>` to release some packages of a monorepo and leave the changesets of the others pending, and suggest it when a new package must be published from your machine.

### Patch Changes

- c9295ee: Fix local `--resume` advice when HEAD has moved past a release commit that is missing from the remote branch.

## 2.1.1

### Patch Changes

- ca2b8ac: Fix an incorrect "release is incomplete" error when the CLI cannot read the workflow runs after dispatching the publishing workflow.
- 2d89f96: Fix an incorrect "release is incomplete" error when you press Ctrl+C while the CLI is looking for the dispatched workflow run.
- 86b915d: Fix releases failing on a brief network or GitHub server error while reading from GitHub, such as when looking for the dispatched publishing workflow run.
- 1f10599: Fix a crash with `EPIPE` when creating a GitHub Release fails before `gh` reads the release notes.
- 2df580e: Fix the CLI exiting with an error when it cannot read the status of a publishing workflow run it is following.

## 2.1.0

### Minor Changes

- 3be382a: Name runs of the publishing workflow after the released versions, such as `Publish my-package@1.5.0`, when the workflow declares the `versions` input of the README template.

## 2.0.1

### Patch Changes

- a818cdb: Stop offering to configure npm trusted publishing right after the first publication of a package, since npm drops the configuration if it does not publish within 2 days.

## 2.0.0

### Major Changes

- 38856df: Rename the package and its command from `changesets-local` to `changesets-release`.

### Minor Changes

- d85ed26: Publish releases from GitHub Actions with npm trusted publishing and provenance, chosen with `--publish=github` or by adding the publishing workflow.

## 1.6.0

### Minor Changes

- 72f1939: Show the release and ask for confirmation before running `release:check` and waiting for CI, and ask to press Enter before publishing when these checks took at least 10 seconds.

## 1.5.1

### Patch Changes

- 610f1a8: Fix new releases being blocked by an older published release with missing tags when all its packages have higher current versions.

## 1.5.0

### Minor Changes

- 198f592: Keep the `Latest` mark of GitHub Releases in a monorepo on the package named after the repository.

## 1.4.0

### Minor Changes

- ee1112b: Mark packages released without a changeset in the release confirmation and name their dependencies from the same release.
- 887a2c9: Warn in the release confirmation when a public package outside the release has dependency ranges that differ from those in its published version.
- 2d115d1: Show changes in `dependencies`, `optionalDependencies`, and `peerDependencies` since the previous release in the release confirmation.

### Patch Changes

- f53610d: Fix the wrong old version shown in the release confirmation for a package with a lower version than the others in its `fixed` or `linked` group.
- 279c749: Fix the same `changeset version` warning being printed several times during a release.

## 1.3.0

### Minor Changes

- c49b04f: Log in to GitHub with `gh auth login` when a release starts without a GitHub CLI login, instead of failing.
- d0ea984: Log in to npm with `npm login` when a release starts without an npm login, instead of failing.

## 1.2.1

### Patch Changes

- 426fe13: Fix releases waiting indefinitely for CI jobs awaiting environment approval.
- 1d92b92: Fix skipped CI checks when releasing immediately after a push.
- f3b1263: Ask about failed CI only when there are pending changesets to release.
- f09a0da: Show which CI checks are still running while a release waits for them.
- 4ec36e4: Retry reading CI checks after a network failure instead of failing the release.
- 4ec36e4: Warn and continue the release instead of failing when the GitHub token cannot read CI checks.

## 1.2.0

### Minor Changes

- b12a6d3: Wait for CI on the released commit before the confirmation, and ask before releasing a commit whose CI has failed.

### Patch Changes

- 40366db: Stop `--dry-run` on another branch from advising to push its commits to the base branch.
- c7cbf7a: Speed up runs in repositories with large lockfiles.
- bbc09ce: Check npm publish permissions once per run.

## 1.1.0

### Minor Changes

- 0fddc40: Make `--dry-run` preview the release of the last commit and warn instead of stopping when the working tree has uncommitted changes, the branch is not in sync with its remote branch, or another branch is checked out.

### Patch Changes

- 3d4b2fd: Tell apart a branch that is behind, ahead of, or diverged from its remote branch, and show the remote branch by its short name, such as `origin/main`.
- dd4e0db: Stop before pushing the release commit when the npm account cannot publish a package or its scope does not exist.
- 7480d67: Fix a false "already published" error for a versioned private package whose name another npm package uses.
- d40af11: Find the release commit faster in repositories with many `Release …` commits of other tools, and recognize a release commit that lists its packages in another order.
- f666384: Describe `--resume` in `--help` as finishing an interrupted release.
- ecbb2f7: Exit at once on a second Ctrl+C, when a subprocess does not stop after the first one.
- e69c57d: List packages in release commit subjects and summaries alphabetically without the `@` of a scope, such as `Release kern-orm@0.1.0, @kern-orm/postgres-js@0.1.0`.
- e405562: Hide the advice of `changeset version` to review and commit the changes while keeping its warnings, and remove an extra blank line from the monorepo release summary.

## 1.0.0

### Major Changes

- 77714c2: Initial release.
