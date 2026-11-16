# changesets-release

Release [Changesets](https://github.com/changesets/changesets) packages on demand with one command: version them, confirm the release, and publish it to npm with Git tags and GitHub Releases, without a Version pull request.

```sh
npx changesets-release
```

You keep writing `.changeset/*.md` files and choosing SemVer bumps as usual.
When you want to release, you run one command in your terminal: it prepares the release, shows it, and after your confirmation commits and pushes it.
Then it publishes the packages either from your machine, authenticating to npm interactively with 2FA, or from a GitHub Actions workflow with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) and [provenance](https://docs.npmjs.com/generating-provenance-statements).

changesets-release is a thin layer over your project's own `@changesets/cli` 3:

- `changeset version` bumps versions and writes changelogs.
- `changeset publish` publishes to npm and creates the Git tags.
- Git pushes the release commit and the tags.
- The GitHub CLI creates a GitHub Release for each tag with the notes of the version from its `CHANGELOG.md`.

It works in single-package repositories and in monorepos with independently versioned packages.
It uses your existing Changesets configuration and changelog conventions.
It checks Git, npm, and GitHub before publishing and can finish an interrupted release.

## Requirements

- A GitHub repository with a single package or with npm, pnpm, or Bun workspaces.
- npm, pnpm, or Bun as the package manager.
- `@changesets/cli` 3 installed as a dev dependency at the repository root, and `.changeset/config.json` with `"commit": false`.
- Node.js ^22.11, ^24, or >=26.
- [GitHub CLI](https://cli.github.com) and a GitHub account that can create releases in the repository.
- To publish from your machine, an npm account with publish access to the packages.
  For a new package in an organization scope, create the npm organization first.
- To publish from GitHub Actions, the [publishing workflow](#publish-from-github-actions) and a trusted publisher for each package on npm.

## Install

Add changesets-release to the dev dependencies at the repository root to pin its version for everyone who releases and for the publishing workflow:

```sh
npm install --save-dev changesets-release
```

`npx changesets-release` runs the installed version; without it, npx downloads the latest version.

To release with a command that is easy to remember, add a `release` script to `package.json`:

```json
{
  "scripts": {
    "release": "changesets-release"
  }
}
```

Then run `bun release`, `pnpm release`, or `npm run release`.
npm passes options to the script only after `--`, such as `npm run release -- --dry-run`.

## Release packages

Record user-visible changes with changesets as usual and commit them:

```sh
npx changeset
git add .changeset
git commit -m "Fix login redirect"
git push
```

When you want to release, commit your changes, check out the base branch from `.changeset/config.json`, sync it with its remote branch, and run changesets-release in the repository root:

```sh
npx changesets-release
```

When the GitHub CLI is not logged in, changesets-release runs `gh auth login`; to publish from your machine, it also runs `npm login` when npm is not logged in.
Complete the login in the terminal.

changesets-release versions the packages and shows the release before asking for confirmation:

```text
Release my-package@1.5.0
  my-package 1.4.2 → 1.5.0 (minor)

Release notes:
  ### Minor Changes

  - 3f1c2ab: Add the `timeout` option.

  ### Patch Changes

  - 9d0e4f1: Fix login redirect.

Changes:
   .changeset/brave-lions-dance.md |  5 -----
   .changeset/quiet-owls-sing.md   |  5 -----
   CHANGELOG.md                    | 10 ++++++++++
   package.json                    |  2 +-
   4 files changed, 11 insertions(+), 11 deletions(-)

Steps:
  - Run release:check
  - Check CI on 3f1c2ab
  - Commit "Release my-package@1.5.0"
  - Push it to origin/main
  - Publish to npm as alice: my-package@1.5.0 (latest)
  - Create and push tag v1.5.0
  - Create GitHub Release in alice/my-package: v1.5.0

Release my-package@1.5.0? [y/N]
```

When the `dependencies`, `optionalDependencies`, or `peerDependencies` of a package in the release differ from its previous release, whether you or Changesets changed them, the confirmation lists the differences after the packages:

```text
Dependency ranges:
  plugin: peerDependencies core ^0.2.0 → ^0.3.0
  tool: dependencies core >=0.2.0 <1 → >=0.3.0 <1.0.0-0
```

A package without the Git tag of its previous version shows only the changes that Changesets makes.

After you confirm, it runs the steps in this order, so you can step away while [`release:check`](#check-the-release-before-publishing) runs and [CI finishes](#wait-for-ci).
When it publishes from your machine and they take at least 10 seconds, it rings the terminal bell and waits before publishing, so that you are back for npm authentication:

```text
Press Enter to publish my-package@1.5.0 as alice, Ctrl+C to cancel.
```

When npm asks for a one-time password or browser authentication, complete it in the terminal.
changesets-release never asks for or stores passwords, one-time passwords, or tokens: npm and gh ask for them themselves.

If you decline, or versioning or `release:check` fails, changesets-release restores the working tree and nothing is committed.
Do not edit files while a release runs: the release also stops and restores the working tree when files or the remote branch change after the confirmation.
Ctrl+C before the release commit does the same; after it, the release stops, and you [finish it](#finish-an-interrupted-release) with `--resume`.
Once the [publishing workflow](#publish-from-github-actions) has started, Ctrl+C only stops waiting for it, and the workflow finishes the release.
Press Ctrl+C again to exit at once without any cleanup.

To preview a release without changing anything, run:

```sh
npx changesets-release --dry-run
```

The dry run checks the repository and logins and shows the release notes, dependency ranges, changed files, and steps, but does not update the lockfile or run `release:check`.
It previews the release of the last commit and warns when the working tree has uncommitted changes, another branch is checked out, or the base branch is not in sync with its remote branch.
When you are on the base branch and it is in sync with its remote branch, it also warns when CI on the commit has failed or is still running.

### Monorepos

In a monorepo, one release commit releases every package that the pending changesets version, such as `Release @acme/core@2.1.0, @acme/react@1.4.0`.
Each published package gets a `name@version` tag and its own GitHub Release with the notes from its `CHANGELOG.md`.
Private packages are not published; they are tagged and get GitHub Releases only when `privatePackages.tag` is enabled in the Changesets config.

To keep the `Latest` mark of GitHub Releases on your main package, name it after the GitHub repository, such as `core` in `owner/core`.
Releases of other packages then leave the mark in place.

Changesets also releases packages that have no changeset of their own, for example when a new version of a dependency no longer fits the range they require.
The confirmation marks these packages and names their dependencies from the same release:

```text
  core 0.2.0 → 0.3.0 (minor)
  plugin 0.1.1 → 0.1.2 (patch, no changeset: depends on core@0.3.0)
```

When a public package outside the release has `dependencies`, `optionalDependencies`, or `peerDependencies` that differ from those in its published version, the confirmation warns you, because users keep getting the published ones:

```text
⚠ plugin@0.1.1 is published with core ^0.2.0, but package.json now has >=0.2.0 <1.
  Add a changeset for plugin to publish this change.
```

Only packages with the Git tag of their current version are checked.

The confirmation lists exactly what `changeset publish` will publish.
If it would also publish a version outside the release, such as a new public package without a changeset, the release stops before the confirmation; release that package with a changeset or make it private.

With npm or Bun, runtime dependencies between published packages (`dependencies`, `optionalDependencies`, and `peerDependencies`) must use version ranges such as `^1.2.0`: npm publishes `workspace:` and `catalog:` specifiers unchanged, and changesets-release stops when it finds them.
Only pnpm replaces them on publication.
This does not apply to `devDependencies`.

### Prereleases

Enter [Changesets prerelease mode](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) with `changeset pre enter <tag>` and release as usual.
Changesets chooses the npm dist-tag of each version, usually the prerelease tag; check it in the confirmation.
changesets-release marks the GitHub Releases of prerelease versions as prereleases.

## Publish from GitHub Actions

To publish with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), add the publishing workflow to your repository.
You still release with `npx changesets-release` from your terminal: it prepares, confirms, commits, and pushes the release as usual, and then starts the workflow, which publishes the packages to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers), pushes the tags, and creates the GitHub Releases.

```text
Steps:
  - Run release:check
  - Check CI on 3f1c2ab
  - Commit "Release my-package@1.5.0"
  - Push it to origin/main
  - Dispatch publish.yml on GitHub Actions to:
    - Publish to npm with provenance: my-package@1.5.0 (latest)
    - Create and push tag v1.5.0
    - Create GitHub Release in alice/my-package: v1.5.0
```

changesets-release then shows the link to the workflow run and waits for it to finish.
The release no longer depends on your machine once the workflow has started: you can press Ctrl+C or close the terminal, and the workflow continues.

Provenance links each published version to the workflow run and the commit it was built from, so that users can verify where a package comes from.
It does not tell whether the package is free of vulnerabilities or malicious code.

### Add the publishing workflow

Save this workflow as `.github/workflows/publish.yml`, commit it, and push it to the base branch:

```yaml
name: Publish
run-name: Publish ${{ inputs.versions || inputs.commit }}

on:
  workflow_dispatch:
    inputs:
      commit:
        description: Release commit
        required: true
        type: string
      versions:
        description: Released versions, only for the run name
        required: false
        type: string

# One publication at a time; a new run waits for the running one.
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false

permissions:
  contents: write # Push tags and create GitHub Releases.
  id-token: write # Publish to npm with trusted publishing.

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v7
        with:
          node-version: 24

      - run: npm ci

      - run: npx --no changesets-release ci "$COMMIT"
        env:
          COMMIT: ${{ inputs.commit }}
          GH_TOKEN: ${{ github.token }}
```

In a pnpm or Bun project, set up your package manager as in your test workflow and install dependencies with a frozen lockfile, such as `pnpm install --frozen-lockfile` or `bun install --frozen-lockfile`.
Keep the Node.js setup: Changesets publishes with npm in Bun projects, and trusted publishing needs npm 11.5.1 or later.
Do not add npm tokens to the workflow or to `.npmrc`: npm would publish with them when trusted publishing fails.
The workflow stops when npm, or pnpm in a pnpm project, is logged in to the registry with a token.

Keep the checkout without `ref`: the workflow checks out the commit of the branch that it was dispatched on, and installs and runs its code.
changesets-release dispatches it on the base branch right after pushing the release commit, so that npm provenance names the release commit.
The `commit` input only tells the workflow which release to finish; the workflow stops unless it is the newest release commit on the base branch.

### Configure trusted publishing

Right before the first release of a package from GitHub Actions, make it trust the workflow:

```sh
npm trust github my-package --repo alice/my-package --file publish.yml --env npm --allow-publish
```

npm drops a new trusted publisher that has not published within 2 days, so do not configure it earlier.
If it has expired, find it with `npm trust list my-package`, delete it with `npm trust revoke my-package --id <id>`, and configure it again.

`npm trust` needs npm 11.15.0 or later and asks for a one-time password.
In a monorepo, run it for every published package.
Alternatively, add the trusted publisher in the settings of the package on npmjs.com, with the same repository, workflow filename, and environment.

npm generates provenance for packages from a public repository.
Set `repository` in the `package.json` of each published package to your GitHub repository, such as `"repository": "github:alice/my-package"`; changesets-release checks it before the release, because npm rejects provenance from another repository.
From a private repository, npm publishes without provenance.

Note: anyone who can push a branch can dispatch the workflow on it and run the code of that branch.
To let only the base branch publish, limit the deployment branches of the `npm` environment to the base branch in the settings of your GitHub repository.

### Publish a new package

npm configures trusted publishers only for packages that already exist, so publish the first version of a new package from your machine:

```sh
npx changesets-release --publish=local
```

Then [configure trusted publishing](#configure-trusted-publishing) of the package right before its next release, and release as usual.
In a monorepo, do this whenever a release has a new package: changesets-release stops before the confirmation when a package of the release is not on npm yet.

### Choose where to publish

changesets-release publishes from GitHub Actions when the repository has the publishing workflow: `.github/workflows/publish.yml` that runs `changesets-release ci`.
Otherwise, it publishes from your machine.
Choose explicitly with `--publish=github` or `--publish=local`.

## Check the release before publishing

changesets-release [waits for CI](#wait-for-ci) of the commit you release, so keep linting, type checks, and tests in CI.
For checks that CI does not run, add a `release:check` script to the root `package.json`, such as a test that installs the packed packages at the versions and dependency ranges that Changesets has just written:

```json
{
  "scripts": {
    "release:check": "npm run test:packed"
  }
}
```

Do not repeat in `release:check` the checks of CI that versioning cannot affect, such as linting and unit tests: they check the same code again and only delay the release.
If your repository has no CI, run all your checks in `release:check` instead.

changesets-release runs it with your package manager after you confirm the release, and again before publishing when it finishes an interrupted release from your machine.
The publishing workflow does not run it.
The release stops if it fails.
It must not change tracked files; add files it generates, such as `dist`, to `.gitignore`.

Build packages in their `prepack` or `prepublishOnly` scripts: npm runs them on every publication, including one from a fresh checkout in the publishing workflow or when finishing an interrupted release.

## Wait for CI

After you confirm a new release, changesets-release waits for the GitHub checks of the commit you release, such as GitHub Actions jobs and commit statuses.
It does not wait for checks awaiting approval, such as a deployment to a protected environment.

If a check fails, changesets-release lists the failed checks with their links and asks whether to release anyway; the default answer is no.

## Finish an interrupted release

npm publication cannot be undone, but the steps after it can fail, for example when the network drops or a push is rejected.
When a release fails after the release commit, fix the cause and run:

```sh
npx changesets-release --resume
```

`--resume` finds the newest release commit, checks the remote branch, npm, the remote tags, and the GitHub Releases of its packages, and shows what is done and what is left.
After you confirm, it performs only the remaining steps, without bumping versions again.
Combine it with `--dry-run` to see the state without changing anything.

With the publishing workflow, `--resume` pushes the release commit if needed and starts the workflow again, which skips what is done.
When the workflow is already running, `--resume` waits for that run instead.
You can also re-run a failed workflow run on GitHub.
When the base branch has moved past the release commit before all its versions are on npm, a new run would publish them with provenance of another commit, so `--resume` does not start one.
Re-run the failed workflow run on GitHub instead, which runs at the release commit again.
If you cannot, publish the remaining versions without provenance: check out the release commit, remove `"provenance": true` from `publishConfig` of your packages if present, run `NPM_CONFIG_PROVENANCE=false npx changeset publish`, discard your changes, check out the base branch again, and finish the tags and GitHub Releases with `npx changesets-release --resume`.
If you released with `--publish=local` in a repository with the publishing workflow, resume with `--resume --publish=local`; the error message of the release shows the command.

A release commit is a commit whose subject, such as `Release a@1.0.0, b@2.0.0`, lists exactly the package versions it changes, in any order, whoever made it.

changesets-release never publishes a version that npm already has, overwrites a tag, or force-pushes.
When the state is inconsistent, for example when a remote tag points to a different commit or a GitHub Release is a draft, it explains the problem and stops.

A newly published version can be missing from the npm registry for several minutes while npm scans it.
If a release stops because npm does not show a version it has accepted, wait a few minutes and resume.

If a new release stops because the previous one is incomplete, resume that release first.
If nothing of the incomplete release is on npm or tagged and you have reverted its release commit, changesets-release asks whether to abandon that release instead.
Abandon it only if you are sure that npm did not accept any of its versions.

## Why changesets-release

With the [Changesets GitHub Action](https://github.com/changesets/action), a Version pull request collects the version updates, and merging it publishes from CI.
For a library maintained by one or a few people, that is an extra pull request to review and merge for every release.
changesets-release shows the release and what it will publish in your terminal and releases right after your confirmation, from your machine or from GitHub Actions.

[changesets-release-it-plugin](https://github.com/abeforgit/changesets-release-it-plugin) releases Changesets packages from the terminal with release-it, but it depends on Changesets 2 ([#8](https://github.com/abeforgit/changesets-release-it-plugin/issues/8)) and supports a monorepo only when all its packages share one version or only one package is versioned.

## Migrate from the Changesets GitHub Action

1. Delete the `changesets/action` step, or the whole release workflow, and keep your test workflow.
2. To publish from GitHub Actions, [add the publishing workflow](#add-the-publishing-workflow) and [configure trusted publishing](#configure-trusted-publishing) for the new workflow filename.
   To publish from your machine instead, remove npm publishing secrets such as `NPM_TOKEN`, and remove `"provenance": true` from `publishConfig` of your packages, if present: npm can only generate provenance in CI.
3. Make sure `.changeset/config.json` has `"commit": false`.
4. Close the open Version pull request, if there is one.
5. Release with `npx changesets-release`.

Packages published from your machine have no provenance.
changesets-release disables provenance for these publications, so a `provenance=true` setting in your `.npmrc` does not break them.

### Skip CI for release commits

A release commit that changesets-release creates only versions the commit whose CI it has waited for: it updates versions, dependency ranges, changelogs, changesets, and the lockfile.
changesets-release does not wait for CI of the release commit itself, so to save CI time, skip CI jobs for release commits with a job-level condition:

```yaml
jobs:
  test:
    if: ${{ !startsWith(github.event.head_commit.message, 'Release ') }}
    runs-on: ubuntu-latest
    steps:
      # ...
```

Use a job condition rather than `[skip ci]` in the commit message or a workflow-level filter.
GitHub reports a skipped job as successful, while a workflow that does not run leaves required status checks of branch protection pending.

The condition checks the last pushed commit, which is the release commit when changesets-release pushes it.
It also skips other commits whose message starts with `Release `.

## Limitations

- Yarn projects are not supported.
- Packages that publish from `publishConfig.directory` are not supported.
- Only repositories on github.com and the public npm registry are supported; GitHub Enterprise Server is not.
- npm trusted publishing does not support self-hosted runners.
- The repository must have no other release automation that publishes the same versions.
