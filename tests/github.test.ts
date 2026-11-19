import { describe, expect, it } from "bun:test"

import {
  changeset,
  createFixture,
  createPublishWorkflow,
  expectPackageReleased,
  expectReleased,
  type Fixture,
  type FixtureOptions,
  githubRepo,
  packageName,
} from "./fixture"

const subject = `Release ${packageName}@1.0.1`

/** Counts `npm publish` attempts that reached the fake registry. */
function countPublishAttempts(fixture: Fixture) {
  return fixture.calls("npm").filter(([command]) => command === "publish").length
}

/** Lists the `-f` fields of every `gh workflow run` call, including rejected ones, oldest first. */
function listDispatchFields(fixture: Fixture) {
  return fixture
    .calls("gh")
    .filter(([group, command]) => group === "workflow" && command === "run")
    .map(args => args.filter((_, index) => args[index - 1] === "-f"))
}

/** Creates a fixture that publishes from GitHub Actions. */
function createGitHubFixture(options: FixtureOptions = {}) {
  return createFixture({ github: true, ...options })
}

/** Prepares a release that dispatches the publishing workflow and checks that it publishes nothing itself. */
async function prepare(fixture: Fixture) {
  const attempts = countPublishAttempts(fixture)
  const result = await fixture.run()
  expect(result.error).toBeUndefined()
  expect(countPublishAttempts(fixture)).toBe(attempts)
  return result
}

/**
 * Prepares a release whose workflow keeps running, and stops the wait for it as Ctrl+C does.
 *
 * HEAD gets a passed CI check: without checks, the release would wait for GitHub to create them for as long as the wait for the workflow.
 */
async function prepareRunning(fixture: Fixture) {
  fixture.updateState(state => {
    state.gh.checkRuns[fixture.git("rev-parse", "HEAD")] = [{ name: "test", conclusion: "success" }]
    state.gh.runOutcome = { pendingReads: 100, conclusion: "success" }
  })
  const result = await fixture.run({}, { abortOnLog: "Waiting for the publishing workflow" })
  expect(result.error).toBeUndefined()
  return result
}

describe("preparing a release for GitHub Actions", () => {
  it("pushes the release commit and dispatches the workflow for it without publishing", async () => {
    const fixture = createGitHubFixture()
    const result = await prepare(fixture)
    expect(result.questions).toEqual([`${subject}?`])
    expect(result.output).toContain(
      [
        `  - Push it to origin/main`,
        `  - Dispatch publish.yml on GitHub Actions to:`,
        `    - Publish to npm with provenance: ${packageName}@1.0.1 (latest)`,
        `    - Create and push tag v1.0.1`,
        `    - Create GitHub Release in ${githubRepo}: v1.0.1`,
      ].join("\n"),
    )
    const head = fixture.git("rev-parse", "HEAD")
    expect(fixture.git("log", "-1", "--format=%s")).toBe(subject)
    expect(fixture.remoteGit("rev-parse", "main")).toBe(head)
    expect(fixture.state().gh.runs).toMatchObject([
      {
        workflow: "publish.yml",
        ref: "refs/heads/main",
        inputs: { commit: head, versions: `${packageName}@1.0.1` },
      },
    ])
    expect(result.output).toContain("The publishing workflow succeeded")
    expect(countPublishAttempts(fixture)).toBe(0)
    expect(fixture.git("tag")).toBe("")
    expect(fixture.remoteGit("tag")).toBe("")
    expect(fixture.state().gh.releases).toEqual([])
  })

  it("dispatches a workflow without the versions input", async () => {
    const fixture = createGitHubFixture()
    fixture.write(".github/workflows/publish.yml", createPublishWorkflow(["commit"]))
    fixture.git("commit", "--quiet", "--all", "--message", "Use the old workflow")
    fixture.git("push", "--quiet")
    const result = await prepare(fixture)
    const head = fixture.git("rev-parse", "HEAD")
    expect(listDispatchFields(fixture)).toEqual([
      [`commit=${head}`, `versions=${packageName}@1.0.1`],
      [`commit=${head}`],
    ])
    expect(fixture.state().gh.runs).toMatchObject([{ inputs: { commit: head } }])
    expect(result.output).toContain(
      ".github/workflows/publish.yml does not declare the `versions` input.",
    )
  })

  it("needs no npm login", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.npm.user = null
    })
    await prepare(fixture)
    expect(fixture.calls("npm").filter(([command]) => command === "whoami")).toEqual([])
    expect(fixture.calls("npm").filter(([command]) => command === "login")).toEqual([])
  })

  it("waits for the workflow to finish", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.runOutcome = { pendingReads: 2, conclusion: "success" }
    })
    const result = await prepare(fixture)
    expect(result.output).toContain("Waiting for the publishing workflow")
    expect(result.output).toContain("The publishing workflow succeeded")
  })

  it("finds the dispatched run after a network failure", async () => {
    const fixture = createGitHubFixture()
    // The first request lists the runs before the dispatch, and the second looks for the dispatched run.
    fixture.updateState(state => {
      state.gh.apiFailures.push({
        endpoint: "publish.yml/runs",
        after: 1,
        count: 1,
        error: "network",
      })
    })
    const result = await prepare(fixture)
    expect(result.output).toContain("Retrying a GitHub request: Get ")
    expect(result.output).toContain("The publishing workflow succeeded")
  })

  it("warns without failing when it cannot find the dispatched run", async () => {
    const fixture = createGitHubFixture()
    // The first request lists the runs before the dispatch; the lookups after it fail.
    fixture.updateState(state => {
      state.gh.apiFailures.push({
        endpoint: "publish.yml/runs",
        after: 1,
        count: 100,
        error: "network",
      })
    })
    const result = await prepare(fixture)
    expect(result.output).toMatch(
      /failed with exit code 1\.\n.*connection reset by peer\n⚠ Dispatched publish\.yml, but could not find its run\./,
    )
    expect(result.output).toContain(
      `Check the workflow runs at https://github.com/${githubRepo}/actions/workflows/publish.yml`,
    )
    expect(result.output).not.toContain("is incomplete")
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("stops retrying a failed run lookup on Ctrl+C without failing", async () => {
    const fixture = createGitHubFixture()
    // The first request lists the runs before the dispatch; Ctrl+C comes while the lookup after it waits to retry.
    // HEAD gets a passed CI check, so that the release does not wait for GitHub to create checks.
    fixture.updateState(state => {
      state.gh.checkRuns[fixture.git("rev-parse", "HEAD")] = [
        { name: "test", conclusion: "success" },
      ]
      state.gh.apiFailures.push({
        endpoint: "publish.yml/runs",
        after: 1,
        count: 100,
        error: "network",
      })
    })
    const result = await fixture.run({}, { abortOnLog: "Retrying a GitHub request" })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "Stopped looking for the run.\n⚠ Dispatched publish.yml, but could not find its run.",
    )
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("stops waiting for GitHub to list the dispatched run on Ctrl+C without failing", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.checkRuns[fixture.git("rev-parse", "HEAD")] = [
        { name: "test", conclusion: "success" },
      ]
      state.gh.runOutcome = { pendingReads: 0, conclusion: "success", omitFromRunList: true }
    })
    const result = await fixture.run({}, { abortOnLog: "Waiting for GitHub to list the run" })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(
      "Stopped looking for the run.\n⚠ Dispatched publish.yml, but could not find its run.",
    )
    // One list before the dispatch and one after it.
    expect(
      fixture
        .calls("gh")
        .filter(
          ([command, endpoint]) => command === "api" && endpoint?.includes("publish.yml/runs"),
        ),
    ).toHaveLength(2)
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("fails without dispatching when it cannot read the runs before the dispatch", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.apiFailures.push({
        endpoint: "publish.yml/runs",
        after: 0,
        count: 100,
        error: "network",
      })
    })
    const result = await fixture.run()
    expect(result.error?.message).toContain("connection reset by peer")
    expect(listDispatchFields(fixture)).toEqual([])
  })

  it("stops waiting on Ctrl+C while the workflow continues", async () => {
    const fixture = createGitHubFixture()
    const result = await prepareRunning(fixture)
    expect(result.output).toContain("Stopped waiting. The workflow continues on GitHub:")
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("does not wait for the user before dispatching", async () => {
    const fixture = createGitHubFixture({
      packageJson: { scripts: { "release:check": "exit 0" } },
    })
    const result = await fixture.run({}, { waitForUser: () => false })
    expect(result.error).toBeUndefined()
    expect(result.waits).toEqual([])
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("allows provenance in publishConfig", async () => {
    const fixture = createGitHubFixture({
      packageJson: { publishConfig: { provenance: true } },
    })
    await prepare(fixture)
  })

  it("previews the release in a dry run without dispatching", async () => {
    const fixture = createGitHubFixture()
    const head = fixture.git("rev-parse", "HEAD")
    const result = await fixture.run({ dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("  - Dispatch publish.yml on GitHub Actions to:")
    expect(result.output).toContain("Dry run: nothing was changed.")
    expect(fixture.remoteGit("rev-parse", "main")).toBe(head)
    expect(fixture.state().gh.runs).toEqual([])
  })

  it("publishes locally when asked", async () => {
    const fixture = createGitHubFixture()
    const result = await fixture.run({ publish: "local" })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(`Publish to npm as tester: ${packageName}@1.0.1 (latest)`)
    expectReleased(fixture, "1.0.1")
    expect(fixture.state().npm.publishes).toMatchObject([{ trusted: false, provenance: false }])
    expect(fixture.state().gh.runs).toEqual([])
  })

  it("keeps the explicit local publishing in the advice to resume", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.npm.publishFailures[packageName] = "before-upload"
    })
    const result = await fixture.run({ publish: "local" })
    expect(result.error?.message).toContain(
      "run `changesets-release --resume --publish=local` to finish it",
    )
  })

  describe("checks before the confirmation", () => {
    /** Runs a release that must fail before the confirmation and returns its error message. */
    async function runRejected(fixture: Fixture, options: { publish?: "github" } = {}) {
      const head = fixture.git("rev-parse", "HEAD")
      const result = await fixture.run(options)
      expect(result.error).toBeDefined()
      expect(result.questions).toEqual([])
      expect(fixture.git("rev-parse", "HEAD")).toBe(head)
      expect(fixture.remoteGit("rev-parse", "main")).toBe(head)
      expect(fixture.state().gh.runs).toEqual([])
      return result.error!.message
    }

    it("fails without the workflow when GitHub publishing is asked", async () => {
      const fixture = createFixture()
      expect(await runRejected(fixture, { publish: "github" })).toContain(
        "Publishing from GitHub Actions needs the publishing workflow .github/workflows/publish.yml that runs `changesets-release ci`.",
      )
    })

    it("does not take another workflow with the same file name for the publishing workflow", async () => {
      const fixture = createFixture()
      fixture.write(".github/workflows/publish.yml", "on:\n  push:\n    tags: ['v*']\n")
      fixture.git("add", "--all")
      fixture.git("commit", "--quiet", "--message", "Publish on tags")
      fixture.git("push", "--quiet")
      const result = await fixture.run()
      expect(result.error).toBeUndefined()
      expectReleased(fixture, "1.0.1")
      expect(fixture.state().gh.runs).toEqual([])
    })

    it("fails when GitHub does not know the workflow", async () => {
      const fixture = createGitHubFixture()
      fixture.updateState(state => {
        state.gh.workflows = {}
      })
      expect(await runRejected(fixture)).toContain(
        `GitHub does not know .github/workflows/publish.yml in ${githubRepo}.`,
      )
    })

    it("fails when the workflow is disabled", async () => {
      const fixture = createGitHubFixture()
      fixture.updateState(state => {
        state.gh.workflows["publish.yml"] = "disabled_manually"
      })
      expect(await runRejected(fixture)).toContain(
        "publish.yml is not enabled in owner/fixture (disabled_manually).",
      )
    })

    it("fails for a package that is not on npm yet", async () => {
      const fixture = createGitHubFixture()
      fixture.updateState(state => {
        state.npm.versions = {}
      })
      const message = await runRejected(fixture)
      expect(message).toContain(`${packageName} is not on npm yet`)
      expect(message).toContain("Release with `--publish=local` to publish its first version")
    })

    it("fails when a package points to another repository", async () => {
      const fixture = createGitHubFixture({
        packageJson: { repository: "https://github.com/other/repo" },
      })
      expect(await runRejected(fixture)).toContain(
        `package.json: set "repository" to "https://github.com/${githubRepo}"`,
      )
    })

    it("fails when the base branch tracks a remote branch of another name", async () => {
      const fixture = createGitHubFixture()
      fixture.git("push", "--quiet", "origin", "main:release")
      fixture.git("branch", "--quiet", "--set-upstream-to", "origin/release")
      expect(await runRejected(fixture)).toContain(
        "Publishing from GitHub Actions needs main to track the remote branch of the same name, but it tracks origin/release.",
      )
    })
  })

  it("does not check the repository of a package from a private repository", async () => {
    const fixture = createGitHubFixture({ packageJson: { repository: undefined } })
    fixture.updateState(state => {
      state.gh.private = true
    })
    const result = await prepare(fixture)
    expect(result.output).toContain(
      "Publish to npm with trusted publishing, without provenance from a private repository",
    )
  })
})

describe("publishing workflow", () => {
  it("publishes with trusted publishing and provenance, then tags and creates GitHub Releases", async () => {
    const fixture = createGitHubFixture()
    await prepare(fixture)
    const result = await fixture.runWorkflow()
    expect(result.error).toBeUndefined()
    expectReleased(fixture, "1.0.1")
    expect(fixture.state().npm.publishes).toEqual([
      {
        tool: "npm",
        name: packageName,
        version: "1.0.1",
        tag: "latest",
        trusted: true,
        provenance: true,
      },
    ])
  })

  it("tags as the GitHub Actions bot without a Git identity", async () => {
    const fixture = createGitHubFixture()
    await prepare(fixture)
    const result = await fixture.runWorkflow({
      env: { GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined },
    })
    expect(result.error).toBeUndefined()
    expect(fixture.remoteGit("cat-file", "tag", "v1.0.1")).toContain(
      "tagger github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    )
  })

  it("reports a complete release when it runs again", async () => {
    const fixture = createGitHubFixture()
    await prepare(fixture)
    expect((await fixture.runWorkflow()).error).toBeUndefined()
    const result = await fixture.runWorkflow()
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(`"${subject}" is completely released.`)
    expect(countPublishAttempts(fixture)).toBe(1)
    expect(fixture.state().gh.releases).toHaveLength(1)
  })

  it("finishes the tags and GitHub Releases from a later commit", async () => {
    const fixture = createGitHubFixture()
    await prepare(fixture)
    const release = fixture.git("rev-parse", "HEAD")
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    expect((await fixture.runWorkflow()).error?.message).toContain("HTTP 502")
    fixture.git("commit", "--quiet", "--allow-empty", "--message", "Later change")
    fixture.git("push", "--quiet")

    fixture.updateState(state => {
      state.gh.createFailure = false
    })
    expect((await fixture.runWorkflow({ commit: release })).error).toBeUndefined()
    expect(fixture.state().gh.releases.map(entry => entry.tag)).toEqual(["v1.0.1"])
    expect(countPublishAttempts(fixture)).toBe(1)
  })

  it("finishes the tags and GitHub Releases when it runs again after publishing", async () => {
    const fixture = createGitHubFixture()
    await prepare(fixture)
    fixture.updateState(state => {
      state.gh.createFailure = true
    })
    const failed = await fixture.runWorkflow()
    expect(failed.error?.message).toContain("HTTP 502")
    expect(failed.error?.message).toContain("re-run the publishing workflow to finish it")
    expect(fixture.remoteGit("tag")).toBe("v1.0.1")

    fixture.updateState(state => {
      state.gh.createFailure = false
    })
    expect((await fixture.runWorkflow()).error).toBeUndefined()
    expectReleased(fixture, "1.0.1")
    expect(countPublishAttempts(fixture)).toBe(1)
  })

  it("fails without a trusted publisher and publishes when it runs again", async () => {
    const fixture = createGitHubFixture()
    await prepare(fixture)
    fixture.updateState(state => {
      state.npm.trustedPublishers = []
    })
    const failed = await fixture.runWorkflow()
    expect(failed.error?.message).toContain("`changeset publish` failed.")
    expect(fixture.state().npm.publishes).toEqual([])
    expect(fixture.remoteGit("tag")).toBe("")

    fixture.updateState(state => {
      state.npm.trustedPublishers = [packageName]
    })
    expect((await fixture.runWorkflow()).error).toBeUndefined()
    expectReleased(fixture, "1.0.1")
  })

  it("stops at a tag that points to another commit", async () => {
    const fixture = createGitHubFixture()
    await prepare(fixture)
    fixture.remoteGit("tag", "v1.0.1", "main~1")
    const result = await fixture.runWorkflow()
    // The checkout fetches the tags, so the local tag is checked first.
    expect(result.error?.message).toContain("Local tag v1.0.1 points to")
    expect(countPublishAttempts(fixture)).toBe(0)
  })

  it("publishes a pnpm project with pnpm", async () => {
    const fixture = createGitHubFixture({ packageManager: "pnpm" })
    await prepare(fixture)
    expect((await fixture.runWorkflow()).error).toBeUndefined()
    expect(fixture.state().npm.publishes).toMatchObject([
      { tool: "pnpm", trusted: true, provenance: true },
    ])
  })

  it("publishes a prerelease to its npm tag", async () => {
    const fixture = createGitHubFixture({ preTag: "beta" })
    await prepare(fixture)
    expect((await fixture.runWorkflow()).error).toBeUndefined()
    expectReleased(fixture, "1.0.1-beta.0")
    expect(fixture.state().npm.publishes[0]!.tag).toBe("beta")
    expect(fixture.state().gh.releases[0]!.prerelease).toBe(true)
  })

  it("finishes a partially published monorepo release when it runs again", async () => {
    const fixture = createGitHubFixture({ monorepo: true })
    await prepare(fixture)
    fixture.updateState(state => {
      state.npm.publishFailures["@fixture/beta"] = "before-upload"
    })
    const failed = await fixture.runWorkflow()
    expect(failed.error?.message).toContain("`changeset publish` failed.")
    expect(fixture.state().npm.versions.alpha).toEqual(["1.0.0", "1.1.0"])

    fixture.updateState(state => {
      state.npm.publishFailures = {}
    })
    expect((await fixture.runWorkflow()).error).toBeUndefined()
    expectPackageReleased(fixture, "packages/alpha", "1.1.0")
    expectPackageReleased(fixture, "packages/beta", "1.0.1")
    expect(
      fixture
        .state()
        .npm.publishes.map(entry => `${entry.name}@${entry.version} ${entry.trusted}`)
        .toSorted(),
    ).toEqual(["@fixture/beta@1.0.1 true", "alpha@1.1.0 true"])
  })

  describe("checks", () => {
    /** Runs the workflow, which must fail before publishing, and returns its error message. */
    async function runRejected(
      fixture: Fixture,
      options: Parameters<Fixture["runWorkflow"]>[0] = {},
    ) {
      const result = await fixture.runWorkflow(options)
      expect(result.error).toBeDefined()
      expect(countPublishAttempts(fixture)).toBe(0)
      expect(fixture.remoteGit("tag")).toBe("")
      return result.error!.message
    }

    it("runs only in GitHub Actions", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      expect(await runRejected(fixture, { env: { GITHUB_ACTIONS: undefined } })).toContain(
        "`changesets-release ci` runs only in the publishing workflow on GitHub Actions",
      )
    })

    it("rejects an abbreviated commit hash", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      const commit = fixture.git("rev-parse", "--short", "HEAD")
      expect(await runRejected(fixture, { commit })).toContain(
        `Pass the full hash of the release commit instead of "${commit}".`,
      )
    })

    it("rejects a run on another branch", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      expect(await runRejected(fixture, { env: { GITHUB_REF: "refs/heads/feature" } })).toContain(
        "Run the publishing workflow on main (baseBranch in .changeset/config.json)",
      )
    })

    it("rejects a commit that is not on the base branch", async () => {
      const fixture = createGitHubFixture()
      fixture.git("checkout", "--quiet", "-b", "feature")
      fixture.write("package.json", fixture.read("package.json").replace("1.0.0", "1.0.1"))
      fixture.git("commit", "--quiet", "--all", "--message", subject)
      fixture.git("push", "--quiet", "origin", "feature")
      const commit = fixture.git("rev-parse", "HEAD")
      expect(await runRejected(fixture, { commit })).toContain(
        `${commit.slice(0, 7)} is not on origin/main`,
      )
    })

    it("rejects a commit that is not a release commit", async () => {
      const fixture = createGitHubFixture()
      const commit = fixture.git("rev-parse", "HEAD")
      expect(await runRejected(fixture, { commit })).toContain(
        `${commit.slice(0, 7)} is not the newest release commit on origin/main.`,
      )
    })

    it("rejects a release commit followed by a newer one", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      const previous = fixture.git("rev-parse", "HEAD")
      expect((await fixture.runWorkflow()).error).toBeUndefined()
      fixture.write(".changeset/next.md", changeset("patch", "Fix another bug."))
      fixture.git("add", "--all")
      fixture.git("commit", "--quiet", "--message", "Add a changeset")
      fixture.git("push", "--quiet")
      await prepare(fixture)
      const newest = fixture.git("rev-parse", "--short", "HEAD")

      const result = await fixture.runWorkflow({ commit: previous })
      expect(result.error?.message).toContain(
        `${previous.slice(0, 7)} is not the newest release commit on origin/main; ${newest} "Release ${packageName}@1.0.2" is.`,
      )
    })

    it("rejects a checkout that differs from GITHUB_SHA", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      const other = fixture.git("rev-parse", "HEAD~1")
      expect(await runRejected(fixture, { env: { GITHUB_SHA: other } })).toContain(
        "Check out without `ref`.",
      )
    })

    it("publishes when the run dispatched at the release commit runs again after later commits", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      const release = fixture.git("rev-parse", "HEAD")
      fixture.git("commit", "--quiet", "--allow-empty", "--message", "Later change")
      fixture.git("push", "--quiet")
      const result = await fixture.runWorkflow()
      expect(result.error).toBeUndefined()
      expect(fixture.remoteGit("rev-parse", "v1.0.1^{commit}")).toBe(release)
    })

    it("does not publish from a later commit, which provenance would name", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      const release = fixture.git("rev-parse", "HEAD")
      fixture.git("commit", "--quiet", "--allow-empty", "--message", "Later change")
      fixture.git("push", "--quiet")
      const message = await runRejected(fixture, { commit: release })
      expect(message).toContain("npm provenance would name")
      expect(message).toContain(
        "Re-run the workflow run that was dispatched when main was at the release commit",
      )
    })

    it("needs an OIDC token", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      expect(
        await runRejected(fixture, { env: { ACTIONS_ID_TOKEN_REQUEST_URL: undefined } }),
      ).toContain("Grant the workflow `id-token: write` in `permissions`.")
    })

    it("rejects an npm token that npm would fall back to", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      fixture.updateState(state => {
        state.npm.workflowUsers.npm = "publisher"
      })
      expect(await runRejected(fixture)).toContain(
        "npm is logged in as publisher with a token, which it would publish with when trusted publishing fails.",
      )
    })

    it("rejects a pnpm token in a pnpm project", async () => {
      const fixture = createGitHubFixture({ packageManager: "pnpm" })
      await prepare(fixture)
      fixture.updateState(state => {
        state.npm.workflowUsers.pnpm = "publisher"
      })
      expect(await runRejected(fixture)).toContain("pnpm is logged in as publisher with a token")
    })

    it("needs npm with trusted publishing", async () => {
      const fixture = createGitHubFixture()
      await prepare(fixture)
      fixture.updateState(state => {
        state.npm.cliVersion = "10.9.2"
      })
      expect(await runRejected(fixture)).toContain(
        "npm 10.9.2 cannot publish with trusted publishing. Use npm 11.5.1 or later",
      )
    })
  })
})

describe("resuming a release published from GitHub Actions", () => {
  it("dispatches the workflow again after it failed", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.runOutcome = { pendingReads: 0, conclusion: "failure" }
    })
    const failed = await fixture.run()
    expect(failed.error?.message).toContain("The publishing workflow ended with failure")
    expect(failed.error?.message).toContain(
      "run `changesets-release --resume` or re-run the publishing workflow to finish it",
    )

    fixture.updateState(state => {
      state.gh.runOutcome = { pendingReads: 0, conclusion: "success" }
    })
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(result.questions).toEqual([`Finish the release "${subject}" with GitHub Actions?`])
    expect(fixture.state().gh.runs).toHaveLength(2)
    expect(fixture.state().npm.publishes).toEqual([])
    expect((await fixture.runWorkflow()).error).toBeUndefined()
    expectReleased(fixture, "1.0.1")
  })

  it("dispatches after the previous dispatch failed", async () => {
    const fixture = createGitHubFixture()
    const failed = await fixture.run(
      {},
      {
        // The workflow is disabled after the checks, so that dispatching fails.
        confirm: () => {
          fixture.updateState(state => {
            state.gh.workflows["publish.yml"] = "disabled_manually"
          })
          return true
        },
      },
    )
    expect(failed.error?.message).toContain("Workflow is disabled.")
    expect(failed.error?.message).toContain(`The release "${subject}" is incomplete.`)
    expect(fixture.remoteGit("log", "-1", "--format=%s", "main")).toBe(subject)
    expect(fixture.state().gh.runs).toEqual([])
    // Only a rejection of undeclared inputs dispatches again.
    expect(listDispatchFields(fixture)).toHaveLength(1)

    fixture.updateState(state => {
      state.gh.workflows["publish.yml"] = "active"
    })
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(fixture.state().gh.runs).toMatchObject([
      { inputs: { commit: fixture.git("rev-parse", "HEAD") } },
    ])
  })

  it("pushes the release commit when the push failed", async () => {
    const fixture = createGitHubFixture()
    fixture.rejectPushes("refs/heads/*")
    const failed = await fixture.run()
    expect(failed.error?.message).toContain("`git push origin")
    expect(fixture.state().gh.runs).toEqual([])

    fixture.rejectPushes(null)
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(fixture.remoteGit("rev-parse", "main")).toBe(fixture.git("rev-parse", "HEAD"))
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("follows a running workflow instead of dispatching another one", async () => {
    const fixture = createGitHubFixture()
    await prepareRunning(fixture)

    const result = await fixture.run(
      { resume: true },
      { abortOnLog: "Waiting for the publishing workflow" },
    )
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("The publishing workflow is already running:")
    expect(result.questions).toEqual([])
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("does not publish locally while the workflow is running", async () => {
    const fixture = createGitHubFixture()
    await prepareRunning(fixture)

    const result = await fixture.run({ resume: true, publish: "local" })
    expect(result.error?.message).toContain("The publishing workflow is running:")
    expect(result.questions).toEqual([])
    expect(countPublishAttempts(fixture)).toBe(0)
  })

  it("does not dispatch once the base branch has moved past an unpublished release", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.runOutcome = { pendingReads: 0, conclusion: "failure" }
    })
    await fixture.run()
    fixture.git("commit", "--quiet", "--allow-empty", "--message", "Later change")
    fixture.git("push", "--quiet")

    const result = await fixture.run({ resume: true })
    expect(result.error?.message).toContain("origin/main has moved past the release commit")
    expect(result.error?.message).toContain(
      "publish the remaining versions from the release commit manually and resume",
    )
    expect(result.questions).toEqual([])
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("does not publish locally when the workflow starts during the confirmation", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.runOutcome = { pendingReads: 0, conclusion: "failure" }
    })
    await fixture.run()

    const result = await fixture.run(
      { resume: true, publish: "local" },
      {
        confirm: () => {
          fixture.updateState(state => {
            state.gh.runs.push({
              id: 100,
              workflow: "publish.yml",
              ref: "refs/heads/main",
              sha: "",
              inputs: {},
              pendingReads: 100,
              conclusion: "success",
            })
          })
          return true
        },
      },
    )
    expect(result.error?.message).toContain("The publishing workflow is running:")
    expect(result.error?.message).toContain("`changesets-release --resume --publish=local`")
    expect(countPublishAttempts(fixture)).toBe(0)
  })

  it("does not dispatch when the workflow starts during the confirmation", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.runOutcome = { pendingReads: 0, conclusion: "failure" }
    })
    await fixture.run()

    const result = await fixture.run(
      { resume: true },
      {
        confirm: () => {
          fixture.updateState(state => {
            state.gh.runs.push({
              id: 100,
              workflow: "publish.yml",
              ref: "refs/heads/main",
              sha: "",
              inputs: {},
              pendingReads: 100,
              conclusion: "success",
            })
          })
          return true
        },
      },
    )
    expect(result.error?.message).toContain("A run of the publishing workflow is in progress:")
    expect(fixture.state().gh.runs).toHaveLength(2)
  })

  it("shows what is left in a dry run", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.runOutcome = { pendingReads: 0, conclusion: "failure" }
    })
    await fixture.run()
    const result = await fixture.run({ resume: true, dryRun: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(`✘ ${packageName}@1.0.1 published to npm`)
    expect(result.output).toContain(
      "Dry run: nothing was changed. A release would dispatch publish.yml.",
    )
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("reports a release that the workflow has completed", async () => {
    const fixture = createGitHubFixture()
    await prepare(fixture)
    expect((await fixture.runWorkflow()).error).toBeUndefined()
    const result = await fixture.run({ resume: true })
    expect(result.error).toBeUndefined()
    expect(result.output).toContain(`"${subject}" is completely released.`)
    expect(fixture.state().gh.runs).toHaveLength(1)
  })

  it("blocks a new release until the workflow has published the previous one", async () => {
    const fixture = createGitHubFixture()
    fixture.updateState(state => {
      state.gh.runOutcome = { pendingReads: 0, conclusion: "failure" }
    })
    await fixture.run()
    fixture.write(".changeset/next.md", changeset("patch", "Fix another bug."))
    fixture.git("add", "--all")
    fixture.git("commit", "--quiet", "--message", "Add a changeset")
    fixture.git("push", "--quiet")
    const result = await fixture.run()
    expect(result.error?.message).toContain(`The release "${subject}" is incomplete:`)
    expect(result.error?.message).toContain("Run `changesets-release --resume` to finish it.")
  })
})
