// State of the fake npm registry and GitHub repository, shared by the fake tools and the test fixtures through a JSON file.
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** State of the fake npm registry and GitHub repository. */
export interface FakeState {
  npm: {
    /** Logged-in npm user, or null when logged out. */
    user: string | null
    /** Error code that `npm whoami` reports without a user: ENEEDAUTH without credentials, or E401 for a rejected token. */
    loggedOutError: "ENEEDAUTH" | "E401"
    /** Makes `npm whoami` fail as when the registry is unreachable. */
    whoamiFailure: boolean
    /** User that `npm login` logs in, or null to make the login fail. */
    loginUser: string | null
    /** Published versions by package name. */
    versions: Record<string, string[]>
    /** npm dist-tags by package name; a package without them has `latest` at its last version. */
    distTags: Record<string, Record<string, string>>
    /** Published `name@version` entries that the registry does not show yet, as while npm scans a new version. */
    hidden: string[]
    /** Users of npm tokens configured for npm and pnpm in the publishing workflow, which `whoami` reports there, or null without one. */
    workflowUsers: { npm: string | null; pnpm: string | null }
    /** Version that `npm --version` reports. */
    cliVersion: string
    /** Packages whose trusted publisher is the publishing workflow; only they can be published from GitHub Actions. */
    trustedPublishers: string[]
    /** Every publication that reached the registry. */
    publishes: Array<{
      tool: string
      name: string
      version: string
      tag: string
      /** Whether the publication authenticated with trusted publishing instead of the npm login. */
      trusted: boolean
      /** Whether npm generated provenance: by default with trusted publishing, unless disabled. */
      provenance: boolean
    }>
    /** Makes publications of packages fail before the upload or after the version is stored, by package name. */
    publishFailures: Record<string, "before-upload" | "after-upload">
    /** Users who can publish a package, by package name; a published package without an entry has the logged-in user. */
    maintainers: Record<string, string[]>
    /** Members of an npm scope such as `@fixture`, or null for a scope that does not exist; a scope without an entry has the logged-in user. */
    scopes: Record<string, string[] | null>
  }
  gh: {
    /** Whether `gh` is logged in. */
    authenticated: boolean
    /** Makes `gh auth login` fail. */
    loginFailure: boolean
    /** Makes `gh repo view` fail as when GitHub is unreachable. */
    repoViewFailure: boolean
    repo: string
    /** Whether the repository is private. */
    private: boolean
    releases: Array<{
      tag: string
      title: string
      notes: string
      prerelease: boolean
      /** The `--latest` option of the creation; absent without the option, when GitHub decides. */
      latest?: boolean
      draft?: boolean
    }>
    /** Makes release creation fail. */
    createFailure: boolean
    /**
     * CI check runs by commit.
     * A run is omitted for `missingReads` reads, then reports `in_progress` for `pendingReads` reads; with `waiting`, it is always awaiting approval.
     */
    checkRuns: Record<
      string,
      Array<{
        name: string
        conclusion: string
        missingReads?: number
        pendingReads?: number
        waiting?: boolean
      }>
    >
    /** Commit statuses by commit; a status reports `pending` for `pendingReads` reads. */
    statuses: Record<string, Array<{ context: string; state: string; pendingReads?: number }>>
    /** Makes `count` requests for CI checks fail with `error` after the first `after` requests. */
    checkRequestFailures: {
      after: number
      count: number
      error: "network" | "no-access" | "rate-limit"
    } | null
    /** Number of requests for CI checks so far. */
    checkRequests: number
    /** States of GitHub Actions workflows by file name, such as `active`; a missing workflow is unknown to GitHub. */
    workflows: Record<string, string>
    /** Runs of GitHub Actions workflows, oldest first; a run is in progress for `pendingReads` reads of it, then completes with `conclusion`. */
    runs: Array<{
      id: number
      workflow: string
      ref: string
      /** The workflow run's commit: the tip of `ref` when it was dispatched. */
      sha: string
      inputs: Record<string, string>
      pendingReads: number
      conclusion: string
    }>
    /** Progress and result of the runs that `gh workflow run` creates. */
    runOutcome: { pendingReads: number; conclusion: string }
  }
}

/** Returns the initial fake state. */
export function createFakeState(): FakeState {
  return {
    npm: {
      user: "tester",
      loggedOutError: "ENEEDAUTH",
      whoamiFailure: false,
      loginUser: "tester",
      versions: {},
      distTags: {},
      hidden: [],
      workflowUsers: { npm: null, pnpm: null },
      cliVersion: "11.16.0",
      trustedPublishers: [],
      publishes: [],
      publishFailures: {},
      maintainers: {},
      scopes: {},
    },
    gh: {
      authenticated: true,
      loginFailure: false,
      repoViewFailure: false,
      repo: "owner/fixture",
      private: false,
      releases: [],
      createFailure: false,
      checkRuns: {},
      statuses: {},
      checkRequestFailures: null,
      checkRequests: 0,
      workflows: {},
      runs: [],
      runOutcome: { pendingReads: 0, conclusion: "success" },
    },
  }
}

/** Reads the fake state. */
export function readFakeState(stateDir: string) {
  return JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as FakeState
}

/**
 * Changes the fake state under an exclusive lock.
 *
 * Changesets publishes independent packages in parallel, so concurrent fake publications must not overwrite each other.
 */
export function updateFakeState(stateDir: string, update: (state: FakeState) => void) {
  const lock = join(stateDir, "lock")
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  try {
    const state = readFakeState(stateDir)
    update(state)
    // Readers without the lock see either the old or the new file.
    writeFileSync(join(stateDir, "state.next.json"), JSON.stringify(state, null, 2))
    renameSync(join(stateDir, "state.next.json"), join(stateDir, "state.json"))
  } finally {
    rmdirSync(lock)
  }
}
