// The publishing workflow on GitHub Actions: dispatching it for a release commit and following its run.
import {
  type Context,
  delay,
  logDetail,
  logDone,
  logStep,
  logWarning,
  ReleaseError,
} from "./context"
import {
  dispatchWorkflow,
  getWorkflowRun,
  getWorkflowState,
  listWorkflowRuns,
  parseGitHubRepository,
  type WorkflowRun,
} from "./github"
import type { RepoFileReader } from "./project"
import type { TrustedPublisher } from "./trusted-publishing"

/** File name of the publishing workflow; npm trusted publishing identifies the publisher by it. */
export const publishWorkflowFile = "publish.yml"

/** Path of the publishing workflow in the repository. */
export const publishWorkflowPath = `.github/workflows/${publishWorkflowFile}`

/** Returns the publishing workflow of a GitHub repository, given as `OWNER/REPO`, as the trusted publisher of its packages. */
export function getPublishWorkflowPublisher(repo: string): TrustedPublisher {
  return {
    repositoryUrl: `https://github.com/${repo}`,
    isRepository: repository =>
      parseGitHubRepository(repository)?.toLowerCase() === repo.toLowerCase(),
    // GitHub Actions sets the variable only for jobs with `id-token: write`.
    canRequestOidcToken: env => Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL),
    oidcAdvice: "Grant the workflow `id-token: write` in `permissions`.",
  }
}

/** Lookups of a dispatched run before giving up on following it; GitHub usually lists a run within seconds. */
const runLookupAttempts = 10

/** Longest interval between lookups of a dispatched run, in milliseconds. */
const runLookupInterval = 2_000

/**
 * Checks whether a repository has the publishing workflow: its file runs `changesets-release ci`.
 *
 * Another workflow with the same file name, such as one that publishes on tags, must not make releases dispatch it.
 * `read` reads files of the repository, by their paths from its root.
 */
export async function hasPublishWorkflow(read: RepoFileReader) {
  return (await read(publishWorkflowPath))?.includes("changesets-release ci") ?? false
}

/** Returns the page that lists the runs of the publishing workflow. */
export function getPublishWorkflowUrl(repo: string) {
  return `https://github.com/${repo}/actions/workflows/${publishWorkflowFile}`
}

/** Fails unless GitHub knows the publishing workflow of a repository and it is enabled. */
export async function assertPublishWorkflowActive(ctx: Context, repo: string) {
  const state = await getWorkflowState(ctx, repo, publishWorkflowFile)
  if (state === null) {
    throw new ReleaseError(
      `GitHub does not know ${publishWorkflowPath} in ${repo}. Push it to the base branch first.`,
    )
  }
  if (state !== "active") {
    throw new ReleaseError(
      `${publishWorkflowPath} is not enabled in ${repo} (${state}). Enable it on ${getPublishWorkflowUrl(repo)}.`,
    )
  }
}

/** Returns the newest run of the publishing workflow that has not completed, or null when none is running or queued. */
export async function findActivePublishRun(ctx: Context, repo: string) {
  const runs = await listWorkflowRuns(ctx, repo, publishWorkflowFile)
  return runs.find(run => run.status !== "completed") ?? null
}

/**
 * Dispatches the publishing workflow for a release commit on a branch, and returns its run, or null when GitHub does not list it in time.
 *
 * `versions` lists the package versions of the release, as its subject does, for the name of the run.
 * Fails without dispatching while a run is in progress, since it may be publishing the release.
 * The run is the one that was not listed before the dispatch.
 */
export async function dispatchPublication(
  ctx: Context,
  repo: string,
  branchRef: string,
  commit: string,
  versions: string,
): Promise<WorkflowRun | null> {
  const runs = await listWorkflowRuns(ctx, repo, publishWorkflowFile)
  const active = runs.find(run => run.status !== "completed")
  if (active) {
    throw new ReleaseError(
      `A run of the publishing workflow is in progress: ${active.url}\nWait for it to finish.`,
    )
  }
  const previous = new Set(runs.map(run => run.id))
  logStep(ctx, `Dispatching ${publishWorkflowFile} for ${commit.slice(0, 7)}`)
  // Workflows copied from an older template do not declare `versions`.
  if (
    !(await dispatchWorkflow(ctx, repo, publishWorkflowFile, branchRef, { commit }, { versions }))
  ) {
    logDetail(
      ctx,
      `${publishWorkflowPath} does not declare the \`versions\` input. Update it from the template in the changesets-release README to name runs after the released versions.`,
    )
  }
  for (let attempt = 1; ; attempt++) {
    const runs = await listWorkflowRuns(ctx, repo, publishWorkflowFile)
    const run = runs.find(entry => !previous.has(entry.id))
    if (run) {
      return run
    }
    if (attempt >= runLookupAttempts) {
      return null
    }
    await delay(ctx, Math.min(ctx.pollInterval, runLookupInterval))
  }
}

/**
 * Waits until a run of the publishing workflow completes, and fails unless it succeeds.
 *
 * Ctrl+C stops waiting without failing: the run continues on GitHub.
 */
export async function watchPublishRun(ctx: Context, repo: string, run: WorkflowRun) {
  logStep(ctx, "Waiting for the publishing workflow")
  logDetail(ctx, `${run.url}\nThe workflow continues if you close the terminal.`)
  let current = run
  try {
    while (current.status !== "completed") {
      await delay(ctx, ctx.pollInterval)
      current = await getWorkflowRun(ctx, repo, run.id)
    }
  } catch (error) {
    if (ctx.signal?.aborted) {
      logWarning(ctx, `Stopped waiting. The workflow continues on GitHub: ${run.url}`)
      return
    }
    if (error instanceof ReleaseError) {
      throw new ReleaseError(
        `Cannot follow the publishing workflow; it continues on GitHub: ${run.url}\n${error.message}`,
      )
    }
    throw error
  }
  if (current.conclusion !== "success") {
    throw new ReleaseError(
      `The publishing workflow ended with ${current.conclusion ?? "no conclusion"}: ${run.url}`,
    )
  }
  logDone(ctx, `The publishing workflow succeeded: ${run.url}`)
}
