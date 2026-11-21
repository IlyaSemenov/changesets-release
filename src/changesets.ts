import { mkdtemp, readFile, rename, rm, rmdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { type Context, formatList, logDetail, ReleaseError } from "./context"
import {
  captureCommand,
  describeFailure,
  formatCommand,
  readCommand,
  runCommandWithStatus,
} from "./exec"
import { readJsonFile } from "./json"
import { sortByName } from "./packages"
import { getWorkTreeFiles } from "./project"

/** Supported major version of `@changesets/cli`. */
const supportedMajor = 3

/** A pending package release, as planned by `changeset status`. */
export interface PlannedRelease {
  name: string
  /** SemVer bump type. */
  type: "major" | "minor" | "patch"
  newVersion: string
  /** Whether a pending changeset names the package. */
  hasChangeset: boolean
}

/** An entry of `changeset publish-plan`: a package version that `changeset publish` would publish or only tag. */
export interface PublishPlanEntry {
  kind: "publish" | "tag-only"
  name: string
  version: string
  /** npm dist-tag of a publication. */
  tag?: string
}

/** A pending changeset, as read by `changeset status`. */
export interface PendingChangeset {
  /** Path of the changeset file in the `.changeset` directory, without the `.md` extension. */
  id: string
  /** Names of the packages for which the changeset requests a major, minor, or patch bump. */
  packages: string[]
}

/** Release plan JSON written by `changeset status --output`. */
interface ReleasePlan {
  changesets: Array<{ id: string; releases: Array<{ name: string; type: string }> }>
  releases: Array<{
    name: string
    type: string
    newVersion: string
    changesets: string[]
  }>
}

/** Event written to the `CHANGESETS_OUTPUT` file by `changeset publish`. */
interface OutputEvent {
  type?: unknown
  tag?: unknown
}

/** Path of the Changesets CLI installed in a project, relative to the working directory of the command. */
const changesetBin = "node_modules/.bin/changeset"

/** Fails with instructions when the project does not have a supported Changesets CLI installed. */
export async function assertChangesetsInstalled(ctx: Context) {
  const packageJson = await readJsonFile<{ version: string }>(
    join(ctx.cwd, "node_modules", "@changesets", "cli", "package.json"),
  )
  if (!packageJson) {
    throw new ReleaseError(
      `@changesets/cli is not installed. Add @changesets/cli@${supportedMajor} to devDependencies and install dependencies.`,
    )
  }
  const { version } = packageJson
  if (Number(version.split(".")[0]) !== supportedMajor) {
    throw new ReleaseError(
      `@changesets/cli ${version} is installed; changesets-release requires version ${supportedMajor}.`,
    )
  }
}

/**
 * Plans the package releases of the pending changesets of a work tree, as reported by `changeset status`.
 *
 * Returns the package releases sorted by name, empty without releasable changesets, and the pending changesets that it reports.
 */
export async function planRelease(
  ctx: Context,
  cwd = ctx.cwd,
): Promise<{ releases: PlannedRelease[]; changesets: PendingChangeset[] }> {
  const plan = await withTempFile("status.json", async output => {
    await readCommand(ctx, changesetBin, ["status", "--output", output], { cwd })
    return (await readJsonFile<ReleasePlan>(output))!
  })
  return {
    releases: sortByName(
      plan.releases.flatMap(({ name, type, newVersion, changesets }) =>
        isBumpType(type) ? [{ name, type, newVersion, hasChangeset: changesets.length > 0 }] : [],
      ),
    ),
    changesets: plan.changesets.map(({ id, releases }) => ({
      id,
      packages: releases.filter(({ type }) => isBumpType(type)).map(({ name }) => name),
    })),
  }
}

/**
 * Returns the pending changesets that a release of the given packages leaves pending: those that bump none of them.
 *
 * Fails if no pending changeset requests a bump for a given package, or if a selected changeset also requests a bump for a package outside the selection: versioning applies a changeset as a whole.
 */
export function getDeferredChangesets(changesets: PendingChangeset[], packages: string[]) {
  const selected = changesets.filter(entry => entry.packages.some(name => packages.includes(name)))
  const missing = packages.filter(name => !selected.some(entry => entry.packages.includes(name)))
  if (missing.length > 0) {
    throw new ReleaseError(`No pending changeset bumps ${missing.join(", ")}.`)
  }
  for (const entry of selected) {
    const others = entry.packages.filter(name => !packages.includes(name))
    if (others.length > 0) {
      throw new ReleaseError(
        `.changeset/${entry.id}.md also bumps ${others.join(", ")}. Add \`${others.map(name => `--only ${name}`).join(" ")}\` or split the changeset.`,
      )
    }
  }
  return changesets.filter(entry => !selected.includes(entry))
}

/** Checks whether a work tree is in Changesets prerelease mode, which also covers a pending exit from it. */
export function isInPrereleaseMode(cwd: string) {
  return getWorkTreeFiles(cwd).exists(join(".changeset", "pre.json"))
}

/**
 * Runs a callback with changeset files hidden from Changesets in a work tree, and restores the files afterwards, also on failure.
 *
 * Hides a file by moving it into a new dot directory beside it, which Changesets does not read; moving keeps its mode and a symbolic link.
 * Fails after trying to restore every file when some of them cannot be restored, naming them.
 */
export async function withoutChangesets<T>(
  cwd: string,
  changesets: PendingChangeset[],
  callback: () => Promise<T>,
) {
  const hidden: Array<{ path: string; hiddenPath: string }> = []
  try {
    // One by one, so that a failure leaves only the files moved so far to restore.
    for (const { id } of changesets) {
      const path = join(cwd, ".changeset", `${id}.md`)
      const dir = await mkdtemp(join(dirname(path), ".changesets-release-"))
      const hiddenPath = join(dir, basename(path))
      try {
        await rename(path, hiddenPath)
      } catch (error) {
        await rmdir(dir).catch(() => {})
        throw error
      }
      hidden.push({ path, hiddenPath })
    }
    return await callback()
  } finally {
    const unrestored: string[] = []
    for (const { path, hiddenPath } of hidden) {
      try {
        await rename(hiddenPath, path)
      } catch (error) {
        unrestored.push(`${path}: ${(error as Error).message}`)
        continue
      }
      // An empty directory left behind changes nothing in Git.
      await rmdir(dirname(hiddenPath)).catch(() => {})
    }
    if (unrestored.length > 0) {
      throw new ReleaseError(`Could not restore changesets:\n${formatList(unrestored)}`)
    }
  }
}

/** Returns what `changeset publish` would publish and tag from a work tree, as reported by `changeset publish-plan`. */
export async function readPublishPlan(ctx: Context, cwd = ctx.cwd): Promise<PublishPlanEntry[]> {
  const plan = await withTempFile("publish-plan.json", async output => {
    await readCommand(ctx, changesetBin, ["publish-plan", "--output", output], { cwd })
    return (await readJsonFile<{ plan: PublishPlanEntry[][] }>(output))!
  })
  return plan.plan.flat().map(({ kind, name, version, tag }) => ({ kind, name, version, tag }))
}

/**
 * Applies pending changesets: bumps versions and updates changelogs.
 *
 * Prints the output of Changesets, such as configuration warnings, without repeated lines and the lines that do not apply to a release by changesets-release.
 */
export async function applyChangesets(ctx: Context, cwd = ctx.cwd) {
  const args = ["version"]
  logDetail(ctx, `$ ${formatCommand(changesetBin, args)}`)
  const result = await captureCommand(ctx, changesetBin, args, { cwd })
  if (result.code !== 0) {
    throw new ReleaseError(describeFailure(changesetBin, args, result))
  }
  const output = filterVersionOutput(`${result.stdout}\n${result.stderr}`)
  if (output) {
    ctx.log(output)
  }
}

/** Lines of `changeset version` output that changesets-release leaves out: the Changesets banner, and the advice to review and commit the changes, which changesets-release does itself. */
const versionNoise = [/^\S*\s*changeset v\d/, /Review them and commit at your leisure/]

/**
 * Removes the Changesets banner, commit advice, and repeated lines from `changeset version` output, preserving the order of other output.
 *
 * Changesets repeats a warning about a dependency range each time it reads the dependency graph.
 */
export function filterVersionOutput(output: string) {
  const seen = new Set<string>()
  return output
    .split("\n")
    .filter(line => {
      if (versionNoise.some(pattern => pattern.test(line))) {
        return false
      }
      // Blank lines separate paragraphs, so they are not repetitions.
      if (line.trim() === "") {
        return true
      }
      const repeated = seen.has(line)
      seen.add(line)
      return !repeated
    })
    .join("\n")
    .trim()
}

/**
 * Publishes unpublished package versions from the work tree with `changeset publish`, which also tags them.
 *
 * Resolves to the command status and the tags that Changesets reports creating: after successful publications, and for tagged private packages.
 * With `disableProvenance`, overrides npm settings that request provenance, which npm can only generate in CI; otherwise npm decides, and trusted publishing generates provenance for a public repository.
 */
export async function publishPackages(
  ctx: Context,
  { disableProvenance }: { disableProvenance: boolean },
) {
  return withTempFile("output.ndjson", async output => {
    const result = await runCommandWithStatus(ctx, changesetBin, ["publish"], {
      env: {
        CHANGESETS_OUTPUT: output,
        ...(disableProvenance ? { NPM_CONFIG_PROVENANCE: "false" } : {}),
      },
    })
    const events = await readOutputEvents(output)
    return {
      succeeded: result.code === 0,
      tags: events.flatMap(event =>
        event.type === "git-tag" && typeof event.tag === "string" ? [event.tag] : [],
      ),
    }
  })
}

async function readOutputEvents(path: string): Promise<OutputEvent[]> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    // Changesets creates the file only when it writes an event.
    return []
  }
  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as OutputEvent)
}

function isBumpType(type: string): type is PlannedRelease["type"] {
  return type === "major" || type === "minor" || type === "patch"
}

async function withTempFile<T>(name: string, callback: (path: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "changesets-release-"))
  try {
    return await callback(join(dir, name))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
