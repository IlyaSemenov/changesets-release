import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { styleText } from "node:util"

import { extractChangelogEntry } from "./changelog"
import {
  applyChangesets,
  assertChangesetsInstalled,
  type ChangesetSelection,
  isInPrereleaseMode,
  listBumpedPackages,
  type PlannedRelease,
  planRelease,
  publishPackages,
  type PublishPlanEntry,
  readPublishPlan,
  selectChangesets,
  withPrivatePackages,
  withSelectedChangesets,
  writeChangesets,
} from "./changesets"
import { awaitChecks, confirmFailedChecks, type PendingChecks, previewChecks } from "./ci"
import {
  type Context,
  delay,
  formatList,
  logDetail,
  logDone,
  logStep,
  logWarning,
  ReleaseError,
} from "./context"
import {
  type DependencyRangeChange,
  diffDependencyRanges,
  formatDependencyRangeChange,
  formatUnreleasedRangeWarning,
  listReleasedDependencies,
  runtimeDependencyFields,
  type UnreleasedRangeChanges,
} from "./dependencies"
import { readCommand, runCommand } from "./exec"
import {
  createTag,
  fetchRemote,
  getCommitFiles,
  getCommitSubject,
  getCurrentBranch,
  getLocalTagCommit,
  getRemoteTagCommits,
  getRemoteUrl,
  getUpstream,
  getWorkTreeRoot,
  hasCommitterIdentity,
  isAncestor,
  isShallowRepository,
  listChangedPaths,
  listCommitsBySubjectPrefix,
  listCommitTreePaths,
  listTrackedManifestPaths,
  listTreeDifferences,
  pushCommit,
  pushTags,
  readFileAtRevision,
  resolveCommit,
  stageWorkTree,
  type Upstream,
} from "./git"
import {
  createGitHubRelease,
  getGitHubReleaseState,
  type GitHubReleaseState,
  resolveGitHubRepo,
} from "./github"
import { findCommitMainPackage, findWorkTreeMainPackage, getLatestMark } from "./latest"
import {
  assertCanPublish,
  assertNpmjsRegistry,
  getNpmUser,
  isNpmjsRegistry,
  isVersionPublished,
} from "./npm"
import {
  formatReleaseSubject,
  formatReleaseVersions,
  getManifestDir,
  isManifestPath,
  listCommitVersionChanges,
  listWorkTreeVersionChanges,
  type Manifest,
  type PackageRelease,
  parseManifest,
  parseReleaseSubject,
  readPackageManifest,
  readTaggedManifest,
  releaseSubjectPrefix,
  sortByName,
} from "./packages"
import {
  getLockfileUpdateCommand,
  getWorkTreeFiles,
  type Project,
  readProject,
  readReleaseConventions,
  type ReleaseConventions,
  type RepoFileReader,
} from "./project"
import { compareVersions, isPrerelease } from "./semver"
import {
  assertTrustedPublishable,
  assertTrustedPublishingEnvironment,
  listNewPackages,
} from "./trusted-publishing"
import {
  assertPublishWorkflowActive,
  dispatchPublication,
  findActivePublishRun,
  getPublishWorkflowPublisher,
  getPublishWorkflowUrl,
  hasPublishWorkflow,
  publishWorkflowFile,
  publishWorkflowPath,
  watchPublishRun,
} from "./workflow"

/** Where a release publishes its packages: from this machine, or from the publishing workflow on GitHub Actions. */
export type PublishMode = "local" | "github"

/** Options of a release run. */
export interface ReleaseOptions {
  /** Where to publish; by default, `github` when the repository has the publishing workflow, and `local` otherwise. */
  publish?: PublishMode
  /** Shows what would happen without changing files, Git, npm, or GitHub. */
  dryRun?: boolean
  /** Finishes the release of the newest release commit, if it is incomplete, instead of starting a new one. */
  resume?: boolean
  /** Releases only these packages and the packages that Changesets also bumps, with their changesets, and leaves the changesets of the others for a later release. */
  only?: string[]
}

/** Package releases planned from the pending changesets of a release, with the changesets that a release of some of the packages leaves pending entirely or partly. */
interface PendingRelease extends ChangesetSelection {
  plan: PlannedRelease[]
  /** Packages outside `--only` that Changesets releases along with the selected ones, whose pending changesets the release also applies. */
  implied: string[]
  /** Whether the project is in Changesets prerelease mode. */
  prerelease: boolean
}

/** Who publishes the packages of a release, and from where. */
type Publisher =
  /** This machine, with the npm login of the user. */
  | { mode: "local"; npmUser: string }
  /** The publishing workflow, which this run dispatches; npm generates provenance only for a public repository. */
  | { mode: "github"; provenance: boolean }
  /** This run inside the publishing workflow, with npm trusted publishing. */
  | { mode: "workflow" }

/**
 * Public packages that a run publishes from this machine, and the npm user who publishes them.
 *
 * With the publishing workflow, these are the first versions of packages that are not on npm yet: npm can only trust a publisher of an existing package.
 */
interface LocalPublications {
  npmUser: string
  packages: PackageRelease[]
}

/** A checked repository ready for a release. */
interface Workspace {
  project: Project
  branch: string
  upstream: Upstream
  /** GitHub repository as `OWNER/REPO`. */
  repo: string
  publisher: Publisher
  /** Command that finishes an interrupted release with the same publisher. */
  resumeCommand: string
}

/** A release commit and the package versions it sets. */
interface FoundRelease {
  commit: string
  subject: string
  packages: PackageRelease[]
}

/** Progress of a package version of a release across npm, Git, and GitHub. */
interface PackageState extends PackageRelease {
  /** Whether npm has the version; always true for private packages, which are not published. */
  published: boolean
  /** Commit of the local tag, or null when there is none or the package is not tagged. */
  localTag: string | null
  /** Commit of the remote tag, or null when there is none or the package is not tagged. */
  remoteTag: string | null
  /** GitHub Release of the tag, or null when the package is not tagged. */
  githubRelease: GitHubReleaseState | null
}

/** Progress of a release across Git, npm, and GitHub. */
interface ReleaseState extends FoundRelease {
  /** Whether the remote branch contains the release commit. */
  pushed: boolean
  packages: PackageState[]
}

/** A change in a runtime dependency of a package. */
interface PackageRangeChange {
  name: string
  change: DependencyRangeChange
}

/** What a release will do, shown before the confirmation. */
interface ReleaseSummary extends PendingRelease {
  subject: string
  releases: PackageRelease[]
  /** Name of the main package, which may be outside the release, or null when GitHub decides which release is `Latest`. */
  mainPackage: string | null
  /** Release notes by package name. */
  notes: Map<string, string>
  /** Dependencies from the same release of packages without a changeset, by package name. */
  releasedDependencies: Map<string, PackageRelease[]>
  /** Changes in the runtime dependencies of the public packages since their previous releases. */
  rangeChanges: PackageRangeChange[]
  /** Public packages outside the release whose runtime dependencies differ from their current published versions. */
  unreleasedRangeChanges: UnreleasedRangeChanges[]
  publishPlan: PublishPlanEntry[]
  /** Publications from this machine, or null when the release publishes nothing from it. */
  localPublications: LocalPublications | null
  diffStat: string
  /** Commit whose CI checks the release reads after the confirmation, or null when it does not read them. */
  ciCommit: string | null
}

const changelogFile = "CHANGELOG.md"

/** Specifiers that npm leaves unchanged on publication and that only pnpm replaces. */
const workspaceSpecifierPrefixes = ["workspace:", "catalog:"]

/**
 * Releases the packages of the current repository.
 *
 * By default, versions the packages from pending changesets, asks for confirmation, runs the checks, and publishes the release, or dispatches the publishing workflow to publish it.
 * With `resume`, finishes the release of the newest release commit instead, if it is incomplete.
 */
export async function release(ctx: Context, options: ReleaseOptions = {}) {
  if (options.resume && options.only) {
    throw new ReleaseError(
      "`--only` does not apply to `--resume`, which finishes the existing release.",
    )
  }
  const workspace = await prepareWorkspace(ctx, options)
  if (options.resume) {
    await resumeRelease(ctx, workspace, options)
  } else {
    await startRelease(ctx, workspace, options)
  }
}

/**
 * Checks the repository, tools, and logins, logs in to npm and GitHub when needed, and reads what a release needs.
 *
 * Publishing from GitHub Actions needs no npm login, but needs the publishing workflow.
 * A dry run previews the release of HEAD: it reads the project from HEAD and warns about a dirty work tree or another branch instead of failing.
 */
async function prepareWorkspace(ctx: Context, options: ReleaseOptions): Promise<Workspace> {
  logStep(ctx, "Checking the repository")
  await assertAtRepositoryRoot(ctx)
  // A dry run previews the release of HEAD, so it reads the project as committed.
  const files = options.dryRun ? getCommitFiles(ctx, "HEAD") : getWorkTreeFiles(ctx.cwd)
  const project = await readProject(files)
  await assertChangesetsInstalled(ctx)

  const changedPaths = await listChangedPaths(ctx)
  if (changedPaths.length > 0) {
    reportProblem(
      ctx,
      options,
      `The working tree has uncommitted changes. Commit or discard them first:\n${formatList(changedPaths)}`,
    )
  }
  const { baseBranch } = project
  const branch = await getCurrentBranch(ctx)
  if (branch !== baseBranch) {
    reportProblem(
      ctx,
      options,
      `Releases are made from ${baseBranch} (baseBranch in .changeset/config.json), but ${branch ? `${branch} is checked out` : "HEAD is detached"}.`,
    )
  }
  const upstream = await getUpstream(ctx, baseBranch)
  if (!upstream) {
    throw new ReleaseError(
      `${baseBranch} does not track a remote branch. Push it with \`git push -u origin ${baseBranch}\`.`,
    )
  }

  const hasWorkflow = await hasPublishWorkflow(files.read)
  const defaultMode: PublishMode = hasWorkflow ? "github" : "local"
  const mode = options.publish ?? defaultMode
  if (mode === "github") {
    if (!hasWorkflow) {
      throw new ReleaseError(
        `Publishing from GitHub Actions needs the publishing workflow ${publishWorkflowPath} that runs \`changesets-release ci\`. Add it as described in https://github.com/IlyaSemenov/changesets-release#add-the-publishing-workflow.`,
      )
    }
    // The workflow publishes only release commits of the base branch on the remote.
    if (upstream.mergeRef !== `refs/heads/${baseBranch}`) {
      throw new ReleaseError(
        `Publishing from GitHub Actions needs ${baseBranch} to track the remote branch of the same name, but it tracks ${upstream.name}.`,
      )
    }
  }

  if (project.packageManager !== "npm") {
    await readCommand(ctx, project.packageManager, ["--version"])
  }
  // `npm whoami` asks the configured registry, so another registry fails before a needless login.
  await assertNpmjsRegistry(ctx, getRegistryTools(project), [])
  // A dry run changes nothing, including the npm and GitHub logins.
  const npmUser = mode === "local" ? await getNpmUser(ctx, { login: !options.dryRun }) : null
  const repo = await resolveGitHubRepo(ctx, await getRemoteUrl(ctx, upstream.remote), {
    login: !options.dryRun,
  })
  if (mode === "github") {
    await assertPublishWorkflowActive(ctx, repo.name)
  }
  await fetchRemote(ctx, upstream.remote)
  logDone(
    ctx,
    `${baseBranch} tracks ${upstream.remote}, ${npmUser === null ? `publishing with ${publishWorkflowFile}` : `npm user ${npmUser}`}, GitHub ${repo.name}`,
  )
  return {
    project,
    branch: branch ?? "HEAD",
    upstream,
    repo: repo.name,
    publisher:
      npmUser === null ? { mode: "github", provenance: !repo.private } : { mode: "local", npmUser },
    resumeCommand: `changesets-release --resume${mode === defaultMode ? "" : ` --publish=${mode}`}`,
  }
}

/** Fails unless the current directory is the root of a Git work tree. */
async function assertAtRepositoryRoot(ctx: Context) {
  const root = await getWorkTreeRoot(ctx)
  if (!root) {
    throw new ReleaseError("The current directory is not in a Git repository.")
  }
  if ((await realpath(root)) !== (await realpath(ctx.cwd))) {
    throw new ReleaseError(`Run changesets-release from the repository root: ${root}`)
  }
}

/** Fails with a problem that prevents a release, or prints it as a warning in a dry run. */
function reportProblem(ctx: Context, options: ReleaseOptions, message: string) {
  if (!options.dryRun) {
    throw new ReleaseError(message)
  }
  logWarning(ctx, message)
}

async function startRelease(ctx: Context, workspace: Workspace, options: ReleaseOptions) {
  const found = await findRelease(ctx, "HEAD")
  if (found) {
    const previous = await inspectRelease(ctx, workspace, found)
    if (getPendingSteps(previous).length > 0 && !(await isSuperseded(ctx, workspace, previous))) {
      await confirmAbandonment(ctx, workspace, previous, options)
    }
  }

  // On another branch, which only a dry run allows, the branch warning already applies, and advice to sync with the base branch would mislead.
  const syncProblem =
    workspace.branch === workspace.project.baseBranch && (await describeSyncProblem(ctx, workspace))
  if (syncProblem) {
    reportProblem(ctx, options, syncProblem)
  }

  // GitHub runs CI only on pushed commits.
  const head = (await resolveCommit(ctx, "HEAD"))!
  if (options.dryRun) {
    if (workspace.branch === workspace.project.baseBranch && !syncProblem) {
      await previewChecks(ctx, workspace.repo, head)
    }
    await previewRelease(ctx, workspace, head, options.only)
    return
  }
  const pending = await planPendingRelease(ctx, ctx.cwd, options.only)
  // Asks about already failed checks before versioning; the others are awaited after the confirmation and release:check.
  const pendingChecks = await confirmFailedChecks(ctx, workspace.repo, head)

  const { commit, subject, releases, localPublications } = await createReleaseCommit(
    ctx,
    workspace,
    pending,
    pendingChecks,
  )
  const state: ReleaseState = {
    commit,
    subject,
    pushed: false,
    packages: releases.map(release => ({
      ...release,
      published: release.private,
      localTag: null,
      remoteTag: null,
      githubRelease: release.tag ? "missing" : null,
    })),
  }
  if (workspace.publisher.mode === "github") {
    await publishOnGitHub(ctx, workspace, state, localPublications)
  } else {
    await finishRelease(ctx, workspace, state, { resumed: false })
  }
}

/**
 * Plans the release of the pending changesets in a work tree, and fails when they release nothing.
 *
 * With `only`, plans the release of the changesets of these packages: defers the other changesets, and applies a changeset that also bumps other packages only to the selected packages.
 * Adds to the selection each package that Changesets releases along with the selected ones and that has a pending changeset that requests a version bump for it, and plans again until the plan adds no such package: the new version of the package includes the changes that its pending changesets describe.
 */
async function planPendingRelease(
  ctx: Context,
  cwd: string,
  only: string[] | undefined,
): Promise<PendingRelease> {
  // Checked before versioning, which removes the prerelease state when the project exits prerelease mode.
  const prerelease = await isInPrereleaseMode(cwd)
  // Prerelease mode keeps applied changesets pending, and its state tracks which ones it has applied.
  if (only && prerelease) {
    throw new ReleaseError("`--only` cannot be used in Changesets prerelease mode.")
  }
  const status = await planRelease(ctx, cwd)
  let selection: ChangesetSelection = { deferred: [], split: [] }
  let plan = status.releases
  const implied: string[] = []
  // Each pass either stops or adds at least one package that is not selected yet.
  while (only) {
    selection = selectChangesets(status.changesets, [...only, ...implied])
    const planned =
      selection.deferred.length > 0 || selection.split.length > 0
        ? await withSelectedChangesets(cwd, selection, () => planRelease(ctx, cwd))
        : status
    plan = planned.releases
    const pending = new Set(
      [...selection.deferred, ...selection.split.map(({ kept }) => kept)].flatMap(
        listBumpedPackages,
      ),
    )
    const added = plan.filter(entry => pending.has(entry.name)).map(entry => entry.name)
    if (added.length === 0) {
      break
    }
    implied.push(...added)
  }
  // Changesets does not bump a package that its configuration ignores or a private package it does not version, even with a changeset.
  const unplanned = (only ?? []).filter(name => !plan.some(entry => entry.name === name))
  if (unplanned.length > 0) {
    throw new ReleaseError(
      `Changesets plans no release of ${unplanned.join(", ")} despite pending changesets; check \`ignore\` and \`privatePackages\` in .changeset/config.json.`,
    )
  }
  if (plan.length === 0) {
    throw new ReleaseError(
      "No pending changesets release any package. Add one with `npx changeset` and commit it.",
    )
  }
  return { plan, ...selection, implied: implied.toSorted(), prerelease }
}

/** Describes how HEAD differs from the remote base branch, or returns null when they are at the same commit. */
async function describeSyncProblem(ctx: Context, workspace: Workspace) {
  const { branch, upstream } = workspace
  const head = (await resolveCommit(ctx, "HEAD"))!
  const remoteHead = await resolveCommit(ctx, upstream.trackingRef)
  if (head === remoteHead) {
    return null
  }
  if (!remoteHead) {
    return `${upstream.name} does not exist. Push to it with \`git push ${upstream.remote} HEAD:${upstream.mergeRef}\`.`
  }
  if (await isAncestor(ctx, head, remoteHead)) {
    return `${branch} is behind ${upstream.name}. Pull the remote changes first.`
  }
  if (await isAncestor(ctx, remoteHead, head)) {
    return `${branch} has commits that are not pushed to ${upstream.name}. Push them first.`
  }
  return `${branch} and ${upstream.name} have diverged. Reconcile them first.`
}

/**
 * Lets the user abandon an incomplete release that looks reverted, and fails for any other incomplete release.
 *
 * Nothing proves that an abandoned release was not published: npm may hide an accepted upload for a while, so only the user can decide.
 */
async function confirmAbandonment(
  ctx: Context,
  workspace: Workspace,
  state: ReleaseState,
  options: ReleaseOptions,
) {
  if (!(await isApparentlyAbandoned(ctx, state))) {
    throw new ReleaseError(
      `The release "${state.subject}" is incomplete:\n${formatState(state)}\nRun \`${workspace.resumeCommand}\` to finish it.`,
    )
  }
  ctx.log(
    [
      "",
      `The release "${state.subject}" is incomplete, and HEAD no longer has its versions, as after a revert:`,
      formatState(state),
      "npm does not show its versions, but npm may hide a version it has just accepted while it scans it.",
    ].join("\n"),
  )
  if (options.dryRun) {
    ctx.log("A release would ask whether to abandon it.")
  } else if (!(await ctx.confirm(`Abandon the release "${state.subject}"?`))) {
    throw new ReleaseError("Release cancelled.")
  }
}

/** Checks whether a release shows no sign of publication or tags and HEAD has none of its versions; npm may still hide an accepted version. */
async function isApparentlyAbandoned(ctx: Context, state: ReleaseState) {
  if (state.packages.some(entry => !entry.private && entry.published)) {
    return false
  }
  if (state.packages.some(entry => entry.localTag || entry.remoteTag)) {
    return false
  }
  for (const entry of state.packages) {
    const manifest = parseManifest(
      await readFileAtRevision(ctx, "HEAD", join(entry.dir, "package.json")),
    )
    if (manifest?.version === entry.version) {
      return false
    }
  }
  return true
}

/** Checks whether a pushed and published release only lacks tags or GitHub Releases of versions that HEAD has moved past, as after manual version bumps. */
async function isSuperseded(ctx: Context, workspace: Workspace, state: ReleaseState) {
  if (!state.pushed || state.packages.some(entry => !entry.published)) {
    return false
  }
  // Nested manifests of a single-package repository, such as test fixtures, are not released packages.
  const paths = workspace.project.monorepo
    ? (await listCommitTreePaths(ctx, "HEAD")).filter(isManifestPath)
    : ["package.json"]
  const manifests = new Map<string, Manifest>()
  for (const path of paths) {
    const manifest = parseManifest(await readFileAtRevision(ctx, "HEAD", path))
    if (manifest) {
      manifests.set(getManifestDir(path), manifest)
    }
  }
  return state.packages.every(entry => {
    const manifest = findCurrentManifest(manifests, entry)
    return manifest !== undefined && compareVersions(manifest.version, entry.version) > 0
  })
}

/**
 * Finds the manifest of a package by its directory at the release, or by its name after the package has moved.
 *
 * Returns undefined when the package has left its directory and several manifests have its name, such as test fixtures, because the current package is then unknown.
 */
function findCurrentManifest(manifests: Map<string, Manifest>, entry: PackageRelease) {
  const manifest = manifests.get(entry.dir)
  if (manifest?.name === entry.name) {
    return manifest
  }
  const matches = [...manifests.values()].filter(({ name }) => name === entry.name)
  return matches.length === 1 ? matches[0] : undefined
}

/** Fails when a versioned package already has its tag, or a public one its version on npm. */
async function assertUnreleased(ctx: Context, workspace: Workspace, releases: PackageRelease[]) {
  const { project, upstream } = workspace
  // Private packages are not published, and their names may belong to other packages on npm.
  const publicPackages = releases.filter(entry => !entry.private)
  await assertPackageRegistries(ctx, project, publicPackages)
  const tagged = getTagged(releases)
  const remoteTags = await getRemoteTagCommits(
    ctx,
    upstream.remote,
    tagged.map(entry => entry.tag!),
  )
  for (const entry of tagged) {
    if (remoteTags.has(entry.tag!) || (await getLocalTagCommit(ctx, entry.tag!))) {
      throw new ReleaseError(
        `Tag ${entry.tag} already exists, but ${entry.name} is at ${entry.oldVersion}.`,
      )
    }
  }
  const published = await Promise.all(
    publicPackages.map(entry => isVersionPublished(ctx, entry.name, entry.version)),
  )
  const entry = publicPackages.find((_, index) => published[index])
  if (entry) {
    throw new ReleaseError(`${entry.name}@${entry.version} is already published on npm.`)
  }
}

/**
 * Versions the packages in the working tree, asks for confirmation, runs `release:check`, and commits the result.
 *
 * With `pendingChecks`, waits for the CI checks after the confirmation; checks can appear while the release is prepared.
 * Restores the working tree when anything fails before the commit.
 */
async function createReleaseCommit(
  ctx: Context,
  workspace: Workspace,
  pending: PendingRelease,
  pendingChecks: PendingChecks | null,
) {
  const { project } = workspace
  const subject = formatReleaseSubject(
    pending.plan.map(entry => ({ name: entry.name, version: entry.newVersion })),
  )
  let releases: PackageRelease[]
  let localPublications: LocalPublications | null
  try {
    logStep(ctx, "Versioning")
    const versioned = await versionPackages(ctx, workspace, pending, ctx.cwd)
    releases = versioned.releases
    if (project.lockfile) {
      await runCommand(ctx, ...getLockfileUpdateCommand(project.packageManager))
    }
    const publishPlan = await assertPublishable(ctx, workspace, getTagged(releases), ctx.cwd)
    localPublications = await assertPublisherAccess(
      ctx,
      workspace,
      releases,
      getWorkTreeFiles(ctx.cwd).read,
      { login: true },
    )

    const confirmedTree = await stageWorkTree(ctx)
    const diffStat = await readCommand(ctx, "git", ["diff", "--cached", "--stat"])
    printSummary(ctx, workspace, {
      subject,
      ...pending,
      ...versioned,
      publishPlan,
      localPublications,
      diffStat,
      ciCommit: pendingChecks?.commit ?? null,
    })
    if (!(await ctx.confirm(`Release ${formatVersions(releases)}?`))) {
      throw new ReleaseError("Release cancelled.")
    }

    const checksStartedAt = Date.now()
    if (project.hasReleaseCheck) {
      await runReleaseCheck(ctx, workspace)
    }
    const answeredAboutCi =
      pendingChecks !== null && (await awaitChecks(ctx, workspace.repo, pendingChecks))
    if (!answeredAboutCi) {
      await awaitUserBeforePublishing(ctx, localPublications, checksStartedAt)
    }
    await assertUnchangedSinceConfirmation(ctx, workspace, confirmedTree)

    logStep(ctx, "Committing")
    await runCommand(ctx, "git", ["commit", "--quiet", "--message", subject])
  } catch (error) {
    await restoreWorkTree(ctx)
    throw error
  }

  const commit = (await resolveCommit(ctx, "HEAD"))!
  // A Git hook may also have changed the configuration in the commit, which decides its tags.
  const committed = await listCommitVersionChanges(
    ctx,
    await readReleaseConventions(path => readFileAtRevision(ctx, commit, path)),
    commit,
  )
  if (
    (await getCommitSubject(ctx, commit)) !== subject ||
    describeReleases(committed) !== describeReleases(releases)
  ) {
    throw new ReleaseError(
      `The release commit does not match the confirmed release, probably because of a Git hook. It is not pushed; inspect it and undo it with \`git reset --hard HEAD~1\`.`,
    )
  }
  const changedPaths = await listChangedPaths(ctx)
  if (changedPaths.length > 0) {
    throw new ReleaseError(
      `A Git hook changed files after the release commit:\n${formatList(changedPaths)}\nDiscard the changes and run \`${workspace.resumeCommand}\`.`,
    )
  }
  return { commit, subject, releases: committed, localPublications }
}

/**
 * Applies the pending changesets of a release in a work tree and reads the versioned packages and their release notes.
 *
 * Leaves the deferred changesets and the kept parts of the split ones pending.
 * Fails when a versioned package is already released; only versioning tells which packages are private and tagged.
 */
async function versionPackages(
  ctx: Context,
  workspace: Workspace,
  { plan, deferred, split }: PendingRelease,
  cwd: string,
) {
  await withSelectedChangesets(cwd, { deferred, split }, () => applyChangesets(ctx, cwd))
  await writeChangesets(
    cwd,
    split.map(({ kept }) => kept),
  )
  const releases = await listWorkTreeVersionChanges(ctx, workspace.project, cwd)
  const planned = formatVersions(
    plan.map(entry => ({ name: entry.name, version: entry.newVersion })),
  )
  if (formatVersions(releases) !== planned) {
    throw new ReleaseError(
      `\`changeset version\` set ${formatVersions(releases) || "no versions"}, but ${planned} was planned.`,
    )
  }
  await assertUnreleased(ctx, workspace, releases)
  const notes = new Map<string, string>()
  const releasedDependencies = new Map<string, PackageRelease[]>()
  for (const entry of releases) {
    const changelog = await readFile(join(cwd, entry.dir, changelogFile), "utf8").catch(() => "")
    notes.set(entry.name, getReleaseNotes(changelog, entry))
    if (!plan.find(planned => planned.name === entry.name)!.hasChangeset) {
      const manifest = (await readPackageManifest(cwd, entry.dir))!
      releasedDependencies.set(entry.name, listReleasedDependencies(manifest, releases))
    }
  }
  const rangeChanges = await listRangeChanges(ctx, workspace.project, releases, cwd)
  const unreleasedRangeChanges = await listUnreleasedRangeChanges(
    ctx,
    workspace.project,
    releases,
    cwd,
  )
  const mainPackage = await findWorkTreeMainPackage(
    ctx,
    { repo: workspace.repo, remote: workspace.upstream.remote },
    workspace.project,
    releases,
    cwd,
  )
  return {
    releases,
    mainPackage,
    notes,
    releasedDependencies,
    rangeChanges,
    unreleasedRangeChanges,
  }
}

/**
 * Lists the changes in the runtime dependencies of the public packages of a versioned work tree since their previous releases.
 *
 * Compares with the tag of the previous version, to include ranges edited by hand before the release, or with HEAD when there is no such tag.
 * The previous version comes from the manifest at HEAD, since `changeset status` reports the highest version of a `fixed` group as `oldVersion`.
 */
async function listRangeChanges(
  ctx: Context,
  conventions: ReleaseConventions,
  releases: PackageRelease[],
  cwd: string,
) {
  const changes: PackageRangeChange[] = []
  for (const entry of releases.filter(entry => !entry.private)) {
    const head = parseManifest(
      await readFileAtRevision(ctx, "HEAD", join(entry.dir, "package.json")),
    )
    const versioned = await readPackageManifest(cwd, entry.dir)
    if (head && versioned) {
      const before = (await readTaggedManifest(ctx, conventions, head, entry.dir)) ?? head
      for (const change of diffDependencyRanges(before, versioned)) {
        changes.push({ name: entry.name, change })
      }
    }
  }
  return changes
}

/**
 * Lists the public packages outside a release whose runtime dependencies in a versioned work tree differ from the tag of their current version.
 *
 * `changeset publish` creates the tag after a successful publication, so the tag shows what users install.
 * Requiring it also leaves out tracked manifests that are not released, such as vendored packages and test fixtures.
 * A single-package repository always releases its only package, and its `v1.0.0` tags do not name a package.
 */
async function listUnreleasedRangeChanges(
  ctx: Context,
  conventions: ReleaseConventions,
  releases: PackageRelease[],
  cwd: string,
) {
  if (!conventions.monorepo) {
    return []
  }
  const released = new Set(releases.map(entry => entry.name))
  const unreleased: UnreleasedRangeChanges[] = []
  for (const path of await listTrackedManifestPaths(ctx, cwd)) {
    const dir = getManifestDir(path)
    const manifest = await readPackageManifest(cwd, dir)
    if (!manifest || manifest.private === true || released.has(manifest.name)) {
      continue
    }
    const tagged = await readTaggedManifest(ctx, conventions, manifest, dir)
    const changes = tagged ? diffDependencyRanges(tagged, manifest) : []
    if (changes.length > 0) {
      unreleased.push({ name: manifest.name, version: manifest.version, changes })
    }
  }
  return sortByName(unreleased)
}

/**
 * Fails unless the publishers of a release can publish its public packages, and returns the publications from this machine, or null when there are none.
 *
 * Publishing from this machine needs the npm user, logged in with `login` when npm is not, and the publishing workflow needs npm trusted publishing.
 * The publishing workflow cannot publish the first version of a package that is not on npm yet, so this machine publishes it before dispatching the workflow.
 * Checked once per run, before the confirmation or before a resumed release pushes.
 * `read` reads files of the released tree, by their paths from the repository root.
 */
async function assertPublisherAccess(
  ctx: Context,
  workspace: Workspace,
  packages: PackageRelease[],
  read: RepoFileReader,
  { login }: { login: boolean },
): Promise<LocalPublications | null> {
  const { publisher } = workspace
  const publicPackages = packages.filter(entry => !entry.private)
  switch (publisher.mode) {
    case "local":
      return assertLocalPublications(ctx, publisher.npmUser, publicPackages, read)
    case "github": {
      const newPackages = await listNewPackages(ctx, publicPackages)
      await assertTrustedPublishable(
        getPublishWorkflowPublisher(workspace.repo),
        publicPackages.filter(entry => !newPackages.includes(entry)),
        read,
        { provenance: publisher.provenance },
      )
      if (newPackages.length === 0) {
        return null
      }
      const npmUser = await getNpmUser(ctx, { login })
      return assertLocalPublications(ctx, npmUser, newPackages, read)
    }
    case "workflow": {
      const newPackages = await listNewPackages(ctx, publicPackages)
      if (newPackages.length > 0) {
        const one = newPackages.length === 1
        throw new ReleaseError(
          `${newPackages.map(entry => entry.name).join(", ")} ${one ? "is" : "are"} not on npm yet, and npm can only trust a publisher of an existing package. Publish ${one ? "its first version" : "their first versions"} from your machine with \`changesets-release --resume\`.`,
        )
      }
      await assertTrustedPublishingEnvironment(
        ctx,
        getPublishWorkflowPublisher(workspace.repo),
        workspace.project.packageManager,
      )
      return null
    }
  }
}

/**
 * Fails unless an npm user can publish public packages from this machine, and returns them as its publications, or null when there are none.
 *
 * `read` reads files of the released tree, by their paths from the repository root.
 */
async function assertLocalPublications(
  ctx: Context,
  npmUser: string,
  packages: PackageRelease[],
  read: RepoFileReader,
): Promise<LocalPublications | null> {
  if (packages.length === 0) {
    return null
  }
  for (const entry of packages) {
    const path = join(entry.dir, "package.json")
    assertNoProvenanceRequest(parseManifest(await read(path)), path)
  }
  await Promise.all(packages.map(entry => assertCanPublish(ctx, npmUser, entry.name)))
  return { npmUser, packages }
}

/**
 * Fails when a package requests provenance in `publishConfig`, which prevents publishing it from this machine.
 *
 * npm generates provenance only in CI, and `NPM_CONFIG_PROVENANCE=false` cannot override `publishConfig`.
 */
function assertNoProvenanceRequest(manifest: Manifest | null, path: string) {
  if (manifest?.publishConfig?.provenance === true) {
    throw new ReleaseError(
      `${path}: npm generates provenance only in CI; remove \`"provenance": true\` from publishConfig to publish the package from your machine.`,
    )
  }
}

/**
 * Fails unless `changeset publish` in a work tree would publish and tag exactly the given packages, in a way that matches the release.
 *
 * Public packages are expected as publications and tagged private packages as tags only; without `tags`, for `changeset publish --no-git-tag`, tags are not expected.
 * `local` tells whether the packages are published from this machine.
 * Returns the publish plan, which includes the npm dist-tags.
 */
async function assertPublishable(
  ctx: Context,
  workspace: Workspace,
  packages: PackageRelease[],
  cwd: string,
  { local = workspace.publisher.mode === "local", tags = true } = {},
) {
  const { project } = workspace
  const publicPackages = packages.filter(entry => !entry.private)
  for (const entry of publicPackages) {
    const manifest = await readPackageManifest(cwd, entry.dir)
    const where = `${join(entry.dir, "package.json")}`
    if (manifest?.name !== entry.name || manifest.version !== entry.version) {
      throw new ReleaseError(`${where} does not define ${entry.name}@${entry.version}.`)
    }
    const publishConfig = manifest.publishConfig ?? {}
    if (publishConfig.directory !== undefined) {
      throw new ReleaseError(`${where}: publishConfig.directory is not supported.`)
    }
    if (local) {
      assertNoProvenanceRequest(manifest, where)
    }
    for (const [key, value] of Object.entries(publishConfig)) {
      if (
        (key === "registry" || key.endsWith(":registry")) &&
        typeof value === "string" &&
        !isNpmjsRegistry(value)
      ) {
        throw new ReleaseError(
          `${where}: publishConfig points to ${value}; only the public npm registry is supported.`,
        )
      }
    }
    if (project.packageManager !== "pnpm") {
      for (const field of runtimeDependencyFields) {
        for (const [dependency, specifier] of Object.entries(manifest[field] ?? {})) {
          if (workspaceSpecifierPrefixes.some(prefix => specifier.startsWith(prefix))) {
            throw new ReleaseError(
              `${where}: replace ${dependency}@${specifier} in ${field} with a version range; npm publishes it unchanged.`,
            )
          }
        }
      }
    }
  }
  await assertPackageRegistries(ctx, project, publicPackages)

  const publishPlan = await readPublishPlan(ctx, cwd)
  const actual = new Set(
    publishPlan
      .filter(entry => tags || entry.kind === "publish")
      .map(entry => `${entry.kind} ${entry.name}@${entry.version}`),
  )
  const expected = new Set(
    packages
      .filter(entry => tags || !entry.private)
      .map(entry => `${entry.private ? "tag-only" : "publish"} ${entry.name}@${entry.version}`),
  )
  const unexpected = [...actual].filter(entry => !expected.has(entry))
  const missing = [...expected].filter(entry => !actual.has(entry))
  if (unexpected.length > 0 || missing.length > 0) {
    throw new ReleaseError(
      [
        "`changeset publish` would not publish exactly this release:",
        ...unexpected.map(entry => `  - unexpected: ${entry}`),
        ...missing.map(entry => `  - missing: ${entry}`),
        ...(unexpected.length > 0
          ? ["Unpublished versions of other packages must be released first or made private."]
          : []),
      ].join("\n"),
    )
  }
  return publishPlan
}

/** Runs `release:check` and fails when it changes the work tree. */
async function runReleaseCheck(ctx: Context, workspace: Workspace) {
  logStep(ctx, "Running release:check")
  const before = await stageWorkTree(ctx)
  await runCommand(ctx, workspace.project.packageManager, ["run", "release:check"])
  const after = await stageWorkTree(ctx)
  if (after !== before) {
    throw new ReleaseError(
      `release:check changed files:\n${formatList(await listTreeDifferences(ctx, before, after))}\nMake it leave tracked files intact and ignore generated files in .gitignore.`,
    )
  }
}

/**
 * Waits for the user before a local publication when the checks took long enough for them to have left.
 *
 * Publishing may ask for npm 2FA, which the user can miss, and by then the release commit is on the remote; until the wait ends, Ctrl+C still cancels cleanly in a new release.
 */
async function awaitUserBeforePublishing(
  ctx: Context,
  publications: LocalPublications | null,
  checksStartedAt: number,
) {
  if (!publications || Date.now() - checksStartedAt < ctx.presenceTimeout) {
    return
  }
  // The output of the checks has pushed the summary away, so the message names the release again.
  const message = `Press Enter to publish ${formatVersions(publications.packages)} as ${publications.npmUser}, Ctrl+C to cancel.`
  if (!(await ctx.waitForUser(message))) {
    throw new ReleaseError("Release cancelled.")
  }
}

/** Fails when the work tree or the branches changed while the checks ran or the release waited for the user, before these changes reach the release commit. */
async function assertUnchangedSinceConfirmation(
  ctx: Context,
  workspace: Workspace,
  confirmedTree: string,
) {
  const tree = await stageWorkTree(ctx)
  if (tree !== confirmedTree) {
    throw new ReleaseError(
      `The working tree changed after the confirmation:\n${formatList(await listTreeDifferences(ctx, confirmedTree, tree))}\nRelease again without changing files during the release.`,
    )
  }
  await fetchRemote(ctx, workspace.upstream.remote)
  const syncProblem = await describeSyncProblem(ctx, workspace)
  if (syncProblem) {
    throw new ReleaseError(syncProblem)
  }
}

/** Fails unless HEAD is the release commit and the work tree has no changes, so that `changeset publish` publishes the commit. */
async function assertWorkTreeAtCommit(ctx: Context, commit: string) {
  const short = commit.slice(0, 7)
  if ((await resolveCommit(ctx, "HEAD")) !== commit) {
    throw new ReleaseError(
      `HEAD moved past the release commit ${short}. Save later commits on another branch, reset the branch to ${short}, and resume.`,
    )
  }
  const changedPaths = await listChangedPaths(ctx)
  if (changedPaths.length > 0) {
    throw new ReleaseError(
      `The work tree changed after the release commit ${short}:\n${formatList(changedPaths)}\nDiscard the changes and resume.`,
    )
  }
}

/** Discards changes made by an unfinished release; the working tree was clean when the release started. */
async function restoreWorkTree(ctx: Context) {
  // Runs even after Ctrl+C, which aborts the context signal.
  const cleanup = { ...ctx, signal: undefined }
  try {
    await readCommand(cleanup, "git", ["reset", "--quiet", "--hard", "HEAD"])
    await readCommand(cleanup, "git", ["clean", "--quiet", "--force", "-d"])
    logDetail(ctx, "Restored the working tree.")
  } catch (error) {
    ctx.log(`Could not restore the working tree: ${(error as Error).message}`)
  }
}

/** Shows the release that pending changesets would produce, versioning a temporary worktree instead of the project. */
async function previewRelease(
  ctx: Context,
  workspace: Workspace,
  head: string,
  only: string[] | undefined,
) {
  logStep(ctx, "Versioning in a temporary worktree")
  const tempDir = await mkdtemp(join(tmpdir(), "changesets-release-"))
  const tree = join(tempDir, "tree")
  let summary: ReleaseSummary
  try {
    await readCommand(ctx, "git", ["worktree", "add", "--quiet", "--detach", tree, "HEAD"])
    try {
      // Changesets resolves the changelog generator from the project dependencies.
      await symlink(join(ctx.cwd, "node_modules"), join(tree, "node_modules"))
      // Planned from HEAD like the preview, without uncommitted changesets.
      const pending = await planPendingRelease(ctx, tree, only)
      const versioned = await versionPackages(ctx, workspace, pending, tree)
      const publishPlan = await assertPublishable(
        ctx,
        workspace,
        getTagged(versioned.releases),
        tree,
      )
      const localPublications = await assertPublisherAccess(
        ctx,
        workspace,
        versioned.releases,
        getWorkTreeFiles(tree).read,
        { login: false },
      )
      // The node_modules symlink is not ignored by a `node_modules/` pattern, which matches only directories.
      await readCommand(ctx, "git", ["add", "--all"], { cwd: tree })
      await readCommand(ctx, "git", ["reset", "--quiet", "--", "node_modules"], { cwd: tree })
      const diffStat = await readCommand(ctx, "git", ["diff", "--cached", "--stat"], { cwd: tree })
      summary = {
        subject: formatReleaseSubject(versioned.releases),
        ...pending,
        ...versioned,
        publishPlan,
        localPublications,
        diffStat,
        ciCommit: head,
      }
    } finally {
      // Runs even after Ctrl+C, which aborts the context signal.
      await readCommand({ ...ctx, signal: undefined }, "git", [
        "worktree",
        "remove",
        "--force",
        tree,
      ])
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
  printSummary(ctx, workspace, summary)
  const { project } = workspace
  const skipped = [
    project.lockfile && `${project.lockfile} update`,
    project.hasReleaseCheck && "release:check",
  ].filter(item => typeof item === "string")
  ctx.log(
    `\nDry run: nothing was changed.${skipped.length > 0 ? ` Not run: ${skipped.join(", ")}.` : ""}`,
  )
}

async function resumeRelease(ctx: Context, workspace: Workspace, options: ReleaseOptions) {
  const found = await findRelease(ctx, "HEAD")
  if (!found) {
    throw new ReleaseError("Nothing to resume: no release commit found.")
  }
  const state = await inspectRelease(ctx, workspace, found)
  ctx.log(formatState(state))
  if (getPendingSteps(state).length === 0) {
    logDone(ctx, `"${state.subject}" is completely released.`)
    return
  }
  if (workspace.publisher.mode === "github") {
    await resumeOnGitHub(ctx, workspace, state, options)
    return
  }
  if (
    state.packages.some(entry => !entry.published) &&
    (await resolveCommit(ctx, "HEAD")) !== state.commit
  ) {
    const moved = `npm does not show every version of "${state.subject}", and HEAD has moved past its release commit ${state.commit.slice(0, 7)}`
    const { upstream } = workspace
    throw new ReleaseError(
      state.pushed
        ? `${moved}. If they were just published, wait a few minutes and resume; otherwise publish them from the release commit manually.`
        : // Pushes only the release commit, which leaves the later commits local.
          `${moved}, which is not on ${upstream.name}. Push it with \`git push ${upstream.remote} ${state.commit}:${upstream.mergeRef}\` and run \`${workspace.resumeCommand}\`.`,
    )
  }
  // Checked before the confirmation to fail early, and again right before publishing.
  await assertNoActivePublishRun(ctx, workspace)
  if (options.dryRun) {
    ctx.log("\nDry run: nothing was changed.")
    return
  }
  if (!(await ctx.confirm(`Finish the release "${state.subject}"?`))) {
    throw new ReleaseError("Release cancelled.")
  }
  await finishRelease(ctx, workspace, state, { resumed: true })
}

/**
 * Finishes an incomplete release with the publishing workflow: follows a run that is already in progress, or pushes the release commit when needed, publishes the first versions of packages that are not on npm yet from this machine, and dispatches a new run.
 *
 * Never dispatches while a run is in progress, since it may be publishing this release.
 */
async function resumeOnGitHub(
  ctx: Context,
  workspace: Workspace,
  state: ReleaseState,
  options: ReleaseOptions,
) {
  const active = await findActivePublishRun(ctx, workspace.repo)
  if (active) {
    ctx.log(`\nThe publishing workflow is already running: ${active.url}`)
    if (!options.dryRun) {
      await watchPublishRun(ctx, workspace.repo, active)
    }
    return
  }
  const unpublished = state.packages.filter(entry => !entry.published)
  // The workflow publishes the release commit, so its files decide.
  const localPublications = await assertPublisherAccess(
    ctx,
    workspace,
    unpublished,
    path => readFileAtRevision(ctx, state.commit, path),
    { login: !options.dryRun },
  )
  // This machine publishes from its work tree.
  if (localPublications) {
    await assertWorkTreeAtCommit(ctx, state.commit)
  }
  // An unpushed release commit becomes the tip once pushed.
  if (state.pushed) {
    await assertBranchAtRelease(ctx, workspace, state)
  }
  if (options.dryRun) {
    const steps = [
      ...(state.pushed ? [] : [`push the release commit to ${workspace.upstream.name}`]),
      ...(localPublications
        ? [`publish ${formatVersions(localPublications.packages)} as ${localPublications.npmUser}`]
        : []),
      `dispatch ${publishWorkflowFile}`,
    ]
    ctx.log(`\nDry run: nothing was changed. A release would ${steps.join(", then ")}.`)
    return
  }
  // The question names the publications from this machine, which the state above does not tell apart.
  const question = localPublications
    ? `Finish the release "${state.subject}": publish ${formatVersions(localPublications.packages)} to npm as ${localPublications.npmUser}, then dispatch ${publishWorkflowFile}?`
    : `Finish the release "${state.subject}" with GitHub Actions?`
  if (!(await ctx.confirm(question))) {
    throw new ReleaseError("Release cancelled.")
  }
  if (localPublications) {
    const checksStartedAt = Date.now()
    if (workspace.project.hasReleaseCheck) {
      try {
        await runReleaseCheck(ctx, workspace)
      } catch (error) {
        await restoreWorkTree(ctx)
        throw error
      }
    }
    await awaitUserBeforePublishing(ctx, localPublications, checksStartedAt)
  }
  await publishOnGitHub(ctx, workspace, state, localPublications)
}

/**
 * Pushes the release commit when needed, publishes the first versions of packages from this machine, if any, and dispatches the publishing workflow, which publishes the other packages, pushes the tags, and creates the GitHub Releases; then follows its run.
 *
 * Once dispatched, the release no longer depends on this run: following the workflow is only a convenience.
 */
async function publishOnGitHub(
  ctx: Context,
  workspace: Workspace,
  state: ReleaseState,
  localPublications: LocalPublications | null,
) {
  const { upstream, repo } = workspace
  // No run of the workflow can finish the release before the dispatch.
  const run = await withResumeAdvice(workspace, state, { dispatched: false }, async () => {
    if (!state.pushed) {
      logStep(ctx, `Pushing the release commit to ${upstream.remote}`)
      await pushCommit(ctx, upstream, state.commit)
    }
    await assertBranchAtRelease(ctx, workspace, state)
    if (localPublications) {
      const { packages } = localPublications
      await publishFirstVersions(ctx, workspace, state, packages)
      // Publishing and waiting for npm take a while, during which the base branch can move past the release commit.
      await assertBranchAtRelease(ctx, workspace, {
        ...state,
        packages: state.packages.map(entry =>
          packages.some(({ name }) => name === entry.name) ? { ...entry, published: true } : entry,
        ),
      })
    }
    return dispatchPublication(
      ctx,
      repo,
      upstream.mergeRef,
      state.commit,
      formatReleaseVersions(state.packages),
    )
  })
  if (!run) {
    logWarning(
      ctx,
      `Dispatched ${publishWorkflowFile}, but could not find its run. Check the workflow runs at ${getPublishWorkflowUrl(repo)}`,
    )
    return
  }
  await withResumeAdvice(workspace, state, { dispatched: true }, () =>
    watchPublishRun(ctx, repo, run),
  )
}

/**
 * Publishes from this machine, without tags, the first versions of packages of a pushed release, before the publishing workflow publishes the others, and waits until npm shows them.
 *
 * Marks the other unpublished packages of the release private while `changeset publish` runs, since it publishes every unpublished version.
 * The workflow skips the versions that npm shows, and creates the tags of every package.
 */
async function publishFirstVersions(
  ctx: Context,
  workspace: Workspace,
  state: ReleaseState,
  packages: PackageRelease[],
) {
  // Checked right before publishing, since Git hooks of the push can change the work tree.
  await assertWorkTreeAtCommit(ctx, state.commit)
  await assertNoActivePublishRun(ctx, workspace)
  const others = state.packages.filter(
    entry =>
      !entry.published && !entry.private && !packages.some(({ name }) => name === entry.name),
  )
  await withPrivatePackages(
    ctx.cwd,
    others.map(entry => entry.dir),
    async () => {
      await assertPublishable(ctx, workspace, packages, ctx.cwd, { local: true, tags: false })
      // Checked last before publishing: npm may have started to show a package since the confirmation, which the workflow then publishes with trusted publishing.
      const newPackages = await listNewPackages(ctx, packages)
      const shown = packages.filter(entry => !newPackages.includes(entry))
      if (shown.length > 0) {
        throw new ReleaseError(
          `npm now shows ${shown.map(entry => entry.name).join(", ")}, so the release does not publish ${shown.length === 1 ? "it" : "them"} from your machine. Check the remaining steps with \`changesets-release --resume --dry-run\`.`,
        )
      }
      logStep(ctx, `Publishing ${formatVersions(packages)} to npm`)
      const result = await publishPackages(ctx, { disableProvenance: true, gitTag: false })
      if (!result.succeeded) {
        throw new ReleaseError(
          "`changeset publish` failed. Some versions may have reached npm anyway; resuming checks npm first.",
        )
      }
    },
  )
  await awaitNpmVersions(ctx, packages)
}

/** Maximum number of registry checks for a just-published version; npm may hide a new version for several minutes while it scans it. */
const npmVersionPolls = 30

/** Waits until npm shows package versions that this run has published, and fails when it does not show them in time. */
async function awaitNpmVersions(ctx: Context, packages: PackageRelease[]) {
  let missing = packages
  for (let poll = 1; ; poll++) {
    const shown = await Promise.all(
      missing.map(entry => isVersionPublished(ctx, entry.name, entry.version)),
    )
    missing = missing.filter((_, index) => !shown[index])
    if (missing.length === 0) {
      return
    }
    if (poll >= npmVersionPolls) {
      throw new ReleaseError(
        `npm does not show ${formatVersions(missing)} after \`changeset publish\`. If it was just published, wait a few minutes before resuming.`,
      )
    }
    if (poll === 1) {
      logDetail(ctx, `Waiting for npm to show ${formatVersions(missing)}`)
    }
    await delay(ctx, ctx.pollInterval)
  }
}

/**
 * Finishes a pushed release inside the publishing workflow on GitHub Actions: publishes the packages to npm with trusted publishing, pushes the tags, and creates the GitHub Releases.
 *
 * Runs without questions in the checkout of the commit that the workflow runs at, the tip of the base branch when it was dispatched.
 * Never checks out `commit`, which the dispatch names: the install step runs code of the checkout while the job can publish, so the checkout must be trusted.
 * Fails unless `commit` is the newest release commit of the base branch on the remote, and publishes only when the workflow runs at it, since npm provenance names the commit the workflow runs at.
 * Like `--resume`, skips the steps that are done, so the workflow can run again after a failure.
 */
export async function publishFromWorkflow(ctx: Context, commit: string) {
  const { env } = ctx
  const repo = env.GITHUB_REPOSITORY
  const runCommit = env.GITHUB_SHA
  if (env.GITHUB_ACTIONS !== "true" || !repo || !runCommit) {
    throw new ReleaseError(
      `\`changesets-release ci\` runs only in the publishing workflow on GitHub Actions; release with \`changesets-release\` instead.`,
    )
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new ReleaseError(`Pass the full hash of the release commit instead of "${commit}".`)
  }
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) {
    throw new ReleaseError(
      "Pass the workflow token to the GitHub CLI: set `GH_TOKEN: ${{ github.token }}` in `env`.",
    )
  }
  const short = commit.slice(0, 7)
  logStep(ctx, `Checking the release commit ${short}`)
  await assertAtRepositoryRoot(ctx)
  const project = await readProject(getWorkTreeFiles(ctx.cwd))
  await assertChangesetsInstalled(ctx)
  const { baseBranch } = project
  if (env.GITHUB_REF !== `refs/heads/${baseBranch}`) {
    throw new ReleaseError(
      `Run the publishing workflow on ${baseBranch} (baseBranch in .changeset/config.json), not on ${env.GITHUB_REF}.`,
    )
  }
  if (await isShallowRepository(ctx)) {
    throw new ReleaseError(
      "The checkout lacks the history of the release. Check out with `fetch-depth: 0`.",
    )
  }
  const head = await resolveCommit(ctx, "HEAD")
  if (head !== runCommit) {
    throw new ReleaseError(
      `The workflow has checked out ${head?.slice(0, 7) ?? "nothing"}, not ${runCommit.slice(0, 7)} that it runs at. Check out without \`ref\`.`,
    )
  }
  const changedPaths = await listChangedPaths(ctx)
  if (changedPaths.length > 0) {
    throw new ReleaseError(
      `The work tree has changed after the checkout:\n${formatList(changedPaths)}\nInstall dependencies with a frozen lockfile, such as with \`npm ci\`.`,
    )
  }

  const upstream: Upstream = {
    remote: "origin",
    mergeRef: `refs/heads/${baseBranch}`,
    trackingRef: `refs/remotes/origin/${baseBranch}`,
    name: `origin/${baseBranch}`,
  }
  await fetchRemote(ctx, upstream.remote)
  // Commits of forks are reachable by hash in the repository of their parent, so only reachability from the base branch proves where a commit belongs.
  if (
    !(await isAncestor(ctx, commit, upstream.trackingRef)) ||
    !(await isAncestor(ctx, commit, head))
  ) {
    throw new ReleaseError(`${short} is not on ${upstream.name} at ${head.slice(0, 7)}.`)
  }
  // An older release commit would publish older versions, possibly to the `latest` dist-tag.
  const found = await findRelease(ctx, upstream.trackingRef)
  if (found?.commit !== commit) {
    throw new ReleaseError(
      `${short} is not the newest release commit on ${upstream.name}${found ? `; ${found.commit.slice(0, 7)} "${found.subject}" is` : ""}.`,
    )
  }
  const workspace: Workspace = {
    project,
    branch: baseBranch,
    upstream,
    repo,
    publisher: { mode: "workflow" },
    resumeCommand: "changesets-release --resume",
  }
  await assertNpmjsRegistry(ctx, getRegistryTools(project), [])
  logDone(ctx, `${short} is the newest release commit on ${upstream.name}`)

  const state = await inspectRelease(ctx, workspace, found)
  ctx.log(formatState(state))
  if (getPendingSteps(state).length === 0) {
    logDone(ctx, `"${state.subject}" is completely released.`)
    return
  }
  if (state.packages.some(entry => !entry.published)) {
    if (head !== commit) {
      throw new ReleaseError(
        `The workflow runs at ${head.slice(0, 7)}, which ${baseBranch} had when it was dispatched, not at the release commit ${short}; npm provenance would name ${head.slice(0, 7)} as the source of the packages. ${formatMovedBranchAdvice(baseBranch)}`,
      )
    }
    await assertPublisherAccess(ctx, workspace, state.packages, getWorkTreeFiles(ctx.cwd).read, {
      login: false,
    })
  }
  // Changesets and the release create annotated tags, which need a tagger.
  const jobCtx = (await hasCommitterIdentity(ctx))
    ? ctx
    : { ...ctx, env: { ...env, GIT_COMMITTER_NAME: botName, GIT_COMMITTER_EMAIL: botEmail } }
  await finishRelease(jobCtx, workspace, state, { resumed: false })
}

/** Advises how to publish a release after the base branch has moved past its release commit. */
function formatMovedBranchAdvice(baseBranch: string) {
  return `Re-run the workflow run that was dispatched when ${baseBranch} was at the release commit; otherwise, publish the remaining versions from the release commit manually and resume.`
}

/**
 * Fails when the publishing workflow, dispatched now, could not publish the remaining versions of a release.
 *
 * The workflow runs at the tip of the base branch, which npm provenance names as the source, so the tip must be the release commit.
 */
async function assertBranchAtRelease(ctx: Context, workspace: Workspace, state: ReleaseState) {
  if (state.packages.every(entry => entry.published)) {
    return
  }
  const { upstream } = workspace
  await fetchRemote(ctx, upstream.remote)
  if ((await resolveCommit(ctx, upstream.trackingRef)) !== state.commit) {
    throw new ReleaseError(
      `${upstream.name} has moved past the release commit ${state.commit.slice(0, 7)}, and the publishing workflow publishes the tip of ${upstream.name}. ${formatMovedBranchAdvice(workspace.project.baseBranch)}`,
    )
  }
}

/** Fails when a run of the publishing workflow is in progress, which may be publishing the release that this run would publish locally. */
async function assertNoActivePublishRun(ctx: Context, workspace: Workspace) {
  if (!(await hasPublishWorkflow(getWorkTreeFiles(ctx.cwd).read))) {
    return
  }
  const run = await findActivePublishRun(ctx, workspace.repo)
  if (run) {
    throw new ReleaseError(
      `The publishing workflow is running: ${run.url}\nWait for it to finish, then resume if the release is still incomplete.`,
    )
  }
}

/** Git identity of the GitHub Actions bot, the tagger of tags created in the publishing workflow. */
const botName = "github-actions[bot]"
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com"

/**
 * Finds the newest release commit reachable from a revision.
 *
 * A release commit has a subject that lists exactly the package versions it changes, in any order, whoever created it.
 * Other commits, such as manual version bumps and reverts, are skipped.
 */
async function findRelease(ctx: Context, rev: string): Promise<FoundRelease | null> {
  for (const { hash, subject } of await listCommitsBySubjectPrefix(
    ctx,
    releaseSubjectPrefix,
    rev,
  )) {
    // Subjects of other tools, such as `Release 1.2.3`, are skipped without reading their commits.
    const listed = parseReleaseSubject(subject)
    if (!listed) {
      continue
    }
    // The conventions of the release commit, not current ones, define its packages and tags.
    const conventions = await readReleaseConventions(path => readFileAtRevision(ctx, hash, path))
    const packages = await listCommitVersionChanges(ctx, conventions, hash)
    if (packages.length > 0 && formatReleaseSubject(packages) === formatReleaseSubject(listed)) {
      return { commit: hash, subject, packages }
    }
  }
  return null
}

/**
 * Reads the progress of a release from Git, npm, and GitHub.
 *
 * Fails on conflicting tag targets or draft GitHub Releases.
 */
async function inspectRelease(
  ctx: Context,
  workspace: Workspace,
  found: FoundRelease,
): Promise<ReleaseState> {
  await assertPackageRegistries(
    ctx,
    workspace.project,
    found.packages.filter(entry => !entry.private),
  )
  const tags = getTagged(found.packages).map(entry => entry.tag!)
  const [pushed, remoteTags, packages] = await Promise.all([
    isAncestor(ctx, found.commit, workspace.upstream.trackingRef),
    getRemoteTagCommits(ctx, workspace.upstream.remote, tags),
    Promise.all(
      found.packages.map(async entry => ({
        ...entry,
        published: entry.private || (await isVersionPublished(ctx, entry.name, entry.version)),
        localTag: entry.tag ? await getLocalTagCommit(ctx, entry.tag) : null,
        githubRelease: entry.tag
          ? await getGitHubReleaseState(ctx, workspace.repo, entry.tag)
          : null,
      })),
    ),
  ])
  const state: ReleaseState = {
    ...found,
    pushed,
    packages: packages.map(entry => ({
      ...entry,
      remoteTag: entry.tag ? (remoteTags.get(entry.tag) ?? null) : null,
    })),
  }

  const short = state.commit.slice(0, 7)
  for (const entry of state.packages) {
    for (const [where, commit] of [
      ["Local", entry.localTag],
      ["Remote", entry.remoteTag],
    ] as const) {
      if (commit && commit !== state.commit) {
        throw new ReleaseError(
          `${where} tag ${entry.tag} points to ${commit.slice(0, 7)}, not to the release commit ${short}. Resolve the tag manually.`,
        )
      }
    }
    if (entry.githubRelease === "draft") {
      throw new ReleaseError(
        `The GitHub Release ${entry.tag} is a draft. Publish or delete it, then run changesets-release again.`,
      )
    }
  }
  return state
}

/**
 * Runs the remaining release steps: push the release commit, publish to npm, create and push the tags, and create the GitHub Releases.
 *
 * Publishes from this machine or, inside the publishing workflow, with npm trusted publishing.
 * When `resumed`, runs `release:check` before publishing, since build output of the original run may be missing, and checks the publisher.
 */
async function finishRelease(
  ctx: Context,
  workspace: Workspace,
  state: ReleaseState,
  { resumed }: { resumed: boolean },
) {
  const { project, upstream, repo } = workspace
  const tagged = getTagged(state.packages)
  const unpublished = state.packages.filter(entry => !entry.published)
  // Changesets also tags private packages without a tag when it publishes.
  const expectedPublication = [
    ...unpublished,
    ...tagged.filter(entry => entry.private && !entry.localTag && !entry.remoteTag),
  ]
  try {
    // Checked before pushing, so that a release commit that cannot be published stays local.
    if (unpublished.length > 0) {
      const checksStartedAt = Date.now()
      if (resumed && project.hasReleaseCheck) {
        try {
          await runReleaseCheck(ctx, workspace)
        } catch (error) {
          await restoreWorkTree(ctx)
          throw error
        }
      }
      await assertPublishable(ctx, workspace, expectedPublication, ctx.cwd)
      if (resumed) {
        const localPublications = await assertPublisherAccess(
          ctx,
          workspace,
          unpublished,
          getWorkTreeFiles(ctx.cwd).read,
          { login: true },
        )
        await awaitUserBeforePublishing(ctx, localPublications, checksStartedAt)
      }
    }

    // Pushing before the irreversible publication makes sure the published commit is on the remote.
    if (!state.pushed) {
      logStep(ctx, `Pushing the release commit to ${upstream.remote}`)
      await pushCommit(ctx, upstream, state.commit)
    }

    if (unpublished.length > 0) {
      // Checked again right before publishing, since Git hooks of the push can change the work tree.
      await assertWorkTreeAtCommit(ctx, state.commit)
      if (workspace.publisher.mode === "local") {
        await assertNoActivePublishRun(ctx, workspace)
      }
      await assertPublishable(ctx, workspace, expectedPublication, ctx.cwd)
      logStep(ctx, `Publishing ${formatVersions(unpublished)} to npm`)
      const result = await publishPackages(ctx, {
        disableProvenance: workspace.publisher.mode === "local",
      })
      if (!result.succeeded) {
        throw new ReleaseError(
          "`changeset publish` failed. Some versions may have reached npm anyway; resuming checks npm first.",
        )
      }
      for (const entry of unpublished) {
        if (
          !result.tags.includes(entry.tag!) &&
          !(await isVersionPublished(ctx, entry.name, entry.version))
        ) {
          throw new ReleaseError(
            `npm does not show ${entry.name}@${entry.version} after \`changeset publish\`. If it was just published, wait a few minutes before resuming.`,
          )
        }
      }
    }

    // `changeset publish` creates tags after publishing, so they are read again.
    for (const entry of tagged) {
      const localTag = await getLocalTagCommit(ctx, entry.tag!)
      if (!localTag) {
        logStep(ctx, `Creating tag ${entry.tag}`)
        await createTag(ctx, entry.tag!, state.commit)
      } else if (localTag !== state.commit) {
        throw new ReleaseError(
          `Local tag ${entry.tag} does not point to the release commit. Resolve the tag manually.`,
        )
      }
    }

    const unpushedTags = tagged.filter(entry => !entry.remoteTag).map(entry => entry.tag!)
    if (unpushedTags.length > 0) {
      logStep(
        ctx,
        `Pushing ${unpushedTags.length === 1 ? "tag" : "tags"} ${unpushedTags.join(", ")} to ${upstream.remote}`,
      )
      await pushTags(ctx, upstream.remote, unpushedTags)
    }

    const missingReleases = tagged.filter(entry => entry.githubRelease === "missing")
    if (missingReleases.length > 0) {
      const mainPackage = await findCommitMainPackage(ctx, { repo, remote: upstream.remote }, state)
      for (const entry of missingReleases) {
        logStep(ctx, `Creating GitHub Release ${entry.tag}`)
        const changelog = await readFileAtRevision(
          ctx,
          state.commit,
          join(entry.dir, changelogFile),
        )
        await createGitHubRelease(ctx, repo, {
          tag: entry.tag!,
          notes: getReleaseNotes(changelog ?? "", entry),
          prerelease: isPrerelease(entry.version),
          latest: getLatestMark(entry, mainPackage),
        })
      }
    }
  } catch (error) {
    throw addResumeAdvice(workspace, state, error)
  }
  logDone(ctx, `Released ${formatVersions(state.packages)}.`)
}

/** Runs a step after the release commit, adding to its failure how to finish the release. */
async function withResumeAdvice<T>(
  workspace: Workspace,
  state: ReleaseState,
  options: { dispatched: boolean },
  step: () => Promise<T>,
) {
  try {
    return await step()
  } catch (error) {
    throw addResumeAdvice(workspace, state, error, options)
  }
}

/**
 * Adds to a release failure after the release commit how to finish the release; returns other errors unchanged.
 *
 * In GitHub mode, re-running the workflow is advised only when `dispatched` tells that this run has dispatched it.
 */
function addResumeAdvice(
  workspace: Workspace,
  state: ReleaseState,
  error: unknown,
  { dispatched = true }: { dispatched?: boolean } = {},
) {
  if (!(error instanceof ReleaseError)) {
    return error
  }
  const resume = `run \`${workspace.resumeCommand}\``
  const advice =
    workspace.publisher.mode === "local"
      ? `${resume} to finish it`
      : workspace.publisher.mode === "github"
        ? `${resume}${dispatched ? " or re-run the publishing workflow" : ""} to finish it`
        : "re-run the publishing workflow to finish it"
  return new ReleaseError(
    `${error.message}\n\nThe release "${state.subject}" is incomplete. Fix the problem and ${advice}.`,
  )
}

function getPendingSteps(state: ReleaseState) {
  const tagged = getTagged(state.packages)
  return [
    ...(state.pushed ? [] : ["push the release commit"]),
    ...state.packages
      .filter(entry => !entry.published)
      .map(entry => `publish ${entry.name}@${entry.version}`),
    ...tagged.filter(entry => !entry.remoteTag).map(entry => `push tag ${entry.tag}`),
    ...tagged
      .filter(entry => entry.githubRelease === "missing")
      .map(entry => `create GitHub Release ${entry.tag}`),
  ]
}

/** Returns the packages of a release that get a Git tag: public packages, and private ones when Changesets tags them. */
function getTagged<T extends PackageRelease>(packages: T[]) {
  return packages.filter(entry => entry.tag !== null)
}

/**
 * Fails unless npm, and pnpm in a pnpm project, use the public npm registry for the given packages.
 *
 * Checked before asking npm about versions, since a scoped registry setting can redirect both the check and the publication.
 */
function assertPackageRegistries(
  ctx: Context,
  project: Project,
  packages: Array<{ name: string }>,
) {
  const scopes = [
    ...new Set(
      packages.flatMap(entry => (entry.name.startsWith("@") ? [entry.name.split("/")[0]!] : [])),
    ),
  ]
  return assertNpmjsRegistry(ctx, getRegistryTools(project), scopes)
}

/** Returns the npm-compatible tools whose registry settings a publication depends on. */
function getRegistryTools(project: Project): Array<"npm" | "pnpm"> {
  return project.packageManager === "pnpm" ? ["npm", "pnpm"] : ["npm"]
}

function getReleaseNotes(changelog: string, entry: { name: string; version: string; dir: string }) {
  const notes = extractChangelogEntry(changelog, entry.version)
  if (!notes) {
    throw new ReleaseError(
      `${join(entry.dir, changelogFile)} has no notes for ${entry.name}@${entry.version}.`,
    )
  }
  return notes
}

function printSummary(ctx: Context, workspace: Workspace, summary: ReleaseSummary) {
  const { project, upstream, repo, publisher } = workspace
  const { releases, publishPlan } = summary
  const tagged = getTagged(releases)
  const publications = sortByName(publishPlan.filter(entry => entry.kind === "publish"))
  ctx.log("")
  ctx.log(styleText("bold", summary.subject))
  ctx.log(
    releases
      .map(entry => {
        const planned = summary.plan.find(item => item.name === entry.name)!
        return `  ${entry.name} ${entry.oldVersion} → ${entry.version} (${formatBump(planned, summary.releasedDependencies.get(entry.name))})`
      })
      .join("\n"),
  )
  if (summary.implied.length > 0) {
    ctx.log(
      `\nAlso applies the pending changesets of ${summary.implied.join(", ")}, which the release includes along with the selected packages.`,
    )
  }
  const kept = [...summary.deferred, ...summary.split.map(({ kept }) => kept)]
  const deferredPackages = [...new Set(kept.flatMap(listBumpedPackages))].toSorted()
  if (deferredPackages.length > 0) {
    ctx.log(`\nPending changesets of ${deferredPackages.join(", ")} stay for a later release.`)
  }
  for (const { applied, kept } of summary.split) {
    ctx.log(
      `.changeset/${applied.id}.md applies to ${listBumpedPackages(applied).join(", ")} and stays for ${listBumpedPackages(kept).join(", ")}.`,
    )
  }
  if (summary.rangeChanges.length > 0) {
    ctx.log(`\n${styleText("bold", "Dependency ranges:")}`)
    ctx.log(
      summary.rangeChanges
        .map(({ name, change }) => `  ${name}: ${formatDependencyRangeChange(change)}`)
        .join("\n"),
    )
  }
  ctx.log(`\n${styleText("bold", "Release notes:")}`)
  ctx.log(
    releases
      .map(entry => {
        const notes = summary.notes.get(entry.name)!
        return project.monorepo
          ? `  ${styleText("bold", `${entry.name}@${entry.version}`)}\n${indent(notes, 4)}`
          : indent(notes, 2)
      })
      .join("\n\n"),
  )
  ctx.log(`\n${styleText("bold", "Changes:")}\n${indent(summary.diffStat, 2)}`)
  const { localPublications } = summary
  const isLocal = (entry: PublishPlanEntry) =>
    localPublications?.packages.some(({ name }) => name === entry.name) ?? false
  const formatPublications = (entries: PublishPlanEntry[]) =>
    entries.map(entry => `${entry.name}@${entry.version} (${entry.tag})`).join(", ")
  const localSteps = localPublications
    ? [
        `Publish to npm as ${localPublications.npmUser}: ${formatPublications(publications.filter(isLocal))}`,
      ]
    : []
  const trustedPublications = publications.filter(entry => !isLocal(entry))
  const publicationSteps = [
    ...(publisher.mode !== "local" && trustedPublications.length > 0
      ? [
          `Publish to npm ${formatTrustedPublishing(publisher)}: ${formatPublications(trustedPublications)}`,
        ]
      : []),
    ...(tagged.length > 0
      ? [
          `Create and push ${tagged.length === 1 ? "tag" : "tags"} ${tagged.map(entry => entry.tag).join(", ")}`,
          `Create ${tagged.length === 1 ? "GitHub Release" : "GitHub Releases"} in ${repo}: ${tagged.map(entry => `${entry.tag}${formatGitHubReleaseMark(entry, summary.mainPackage)}`).join(", ")}`,
        ]
      : []),
  ]
  const steps = [
    ...(project.hasReleaseCheck ? ["Run release:check"] : []),
    ...(summary.ciCommit ? [`Check CI on ${summary.ciCommit.slice(0, 7)}`] : []),
    `Commit "${summary.subject}"`,
    `Push it to ${upstream.name}`,
  ]
  ctx.log(`\n${styleText("bold", "Steps:")}`)
  if (publisher.mode === "github") {
    ctx.log(
      formatList([
        ...steps,
        ...localSteps,
        `Dispatch ${publishWorkflowFile} on GitHub Actions to:`,
      ]),
    )
    ctx.log(indent(formatList(publicationSteps), 2))
  } else {
    ctx.log(formatList([...steps, ...localSteps, ...publicationSteps]))
  }
  // After the steps, right before the confirmation, so that the output above does not push it away.
  if (summary.unreleasedRangeChanges.length > 0) {
    ctx.log("")
    for (const entry of summary.unreleasedRangeChanges) {
      logWarning(ctx, formatUnreleasedRangeWarning(entry))
    }
  }
}

/** Describes how a release publishes to npm with trusted publishing, completing "Publish to npm …" in the steps of a release. */
function formatTrustedPublishing(publisher: Exclude<Publisher, { mode: "local" }>) {
  if (publisher.mode === "workflow") {
    return "with trusted publishing"
  }
  return publisher.provenance
    ? "with provenance"
    : "with trusted publishing, without provenance from a private repository"
}

/** Formats the annotation of a GitHub Release in the steps of a release: a prerelease, or the release that takes the `Latest` mark. */
function formatGitHubReleaseMark(entry: PackageRelease, mainPackage: string | null) {
  if (isPrerelease(entry.version)) {
    return " (prerelease)"
  }
  return getLatestMark(entry, mainPackage) ? " (latest)" : ""
}

/** Formats the bump type and the annotation for a package without a changeset, including its released dependencies. */
function formatBump(entry: PlannedRelease, dependencies: PackageRelease[] = []) {
  if (entry.hasChangeset) {
    return entry.type
  }
  const reason = dependencies.length > 0 ? `: depends on ${formatVersions(dependencies)}` : ""
  return `${entry.type}, no changeset${reason}`
}

function formatState(state: ReleaseState) {
  const mark = (done: boolean) => (done ? styleText("green", "✔") : styleText("red", "✘"))
  return [
    `  ${mark(true)} Release commit ${state.commit.slice(0, 7)} "${state.subject}"`,
    `  ${mark(state.pushed)} Release commit pushed`,
    ...state.packages
      .filter(entry => !entry.private)
      .map(entry => `  ${mark(entry.published)} ${entry.name}@${entry.version} published to npm`),
    ...getTagged(state.packages).flatMap(entry => [
      `  ${mark(entry.remoteTag !== null)} Tag ${entry.tag} pushed`,
      `  ${mark(entry.githubRelease === "published")} GitHub Release ${entry.tag} created`,
    ]),
  ].join("\n")
}

/** Serializes release packages for comparison. */
function describeReleases(releases: PackageRelease[]) {
  return JSON.stringify(
    releases.map(({ name, version, dir, private: isPrivate, tag }) => [
      name,
      version,
      dir,
      isPrivate,
      tag,
    ]),
  )
}

/** Formats package versions as `a@1.0.0, b@2.0.0` in their given order. */
function formatVersions(packages: Array<{ name: string; version: string }>) {
  return packages.map(entry => `${entry.name}@${entry.version}`).join(", ")
}

function indent(text: string, width: number) {
  const prefix = " ".repeat(width)
  return text
    .split("\n")
    .map(line => (line ? `${prefix}${line}` : line))
    .join("\n")
}
