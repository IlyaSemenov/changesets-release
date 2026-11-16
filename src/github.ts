import { type Context, logWarning, ReleaseError } from "./context"
import { captureCommand, describeFailure, readCommand, runCommand } from "./exec"

/** Arguments that select github.com, the only supported GitHub host, even when gh defaults to an Enterprise host. */
const githubHostArgs = ["--hostname", "github.com"]

/** Repository permissions that allow creating releases. */
const writePermissions = new Set(["ADMIN", "MAINTAIN", "WRITE"])

/**
 * Resolves the GitHub repository of a Git remote URL with the GitHub CLI.
 *
 * When `gh` is not logged in to github.com, runs `gh auth login` if `login` is set, letting gh ask for credentials in the terminal.
 * Fails with instructions when `gh` is not logged in, the remote is not on GitHub, or the user cannot create releases there.
 */
export async function resolveGitHubRepo(
  ctx: Context,
  remoteUrl: string,
  { login }: { login: boolean },
): Promise<GitHubRepo> {
  const args = ["repo", "view", remoteUrl, "--json", "nameWithOwner,viewerPermission,isPrivate"]
  let result = await captureCommand(ctx, "gh", args)
  // Only a missing token is fixed by logging in; other failures, such as an unreachable GitHub or a remote outside GitHub, are reported.
  // `gh auth token` checks only the github.com token, unlike `gh auth status`, which validates every account and fails when GitHub is unreachable.
  if (
    result.code !== 0 &&
    login &&
    (await captureCommand(ctx, "gh", ["auth", "token", ...githubHostArgs])).code !== 0
  ) {
    logWarning(ctx, "GitHub CLI is not logged in.")
    await runCommand(ctx, "gh", ["auth", "login", ...githubHostArgs])
    result = await captureCommand(ctx, "gh", args)
  }
  if (result.code !== 0) {
    throw new ReleaseError(
      [
        `Cannot access the GitHub repository of ${remoteUrl} with the GitHub CLI.`,
        result.stderr.trim(),
        "Log in with `gh auth login` and make sure the remote is a GitHub repository.",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
  const { nameWithOwner, viewerPermission, isPrivate } = JSON.parse(result.stdout) as {
    nameWithOwner: string
    viewerPermission: string
    isPrivate: boolean
  }
  if (!writePermissions.has(viewerPermission)) {
    throw new ReleaseError(`Your GitHub account cannot create releases in ${nameWithOwner}.`)
  }
  return { name: nameWithOwner, private: isPrivate }
}

/**
 * Returns the GitHub repository as `OWNER/REPO` that the `repository` field of a `package.json` points to, or null for another host or a missing field.
 *
 * Accepts the forms that npm normalizes: a URL, `github:owner/repo`, `owner/repo`, or an object with `url`.
 */
export function parseGitHubRepository(repository: unknown): string | null {
  const url =
    typeof repository === "string" ? repository : (repository as { url?: unknown } | null)?.url
  if (typeof url !== "string") {
    return null
  }
  const match =
    /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url) ??
    /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com[/:]([\w.-]+\/[\w.-]+)\/?$/.exec(
      url,
    ) ??
    /^git@github\.com:([\w.-]+\/[\w.-]+)$/.exec(url)
  return match ? match[1]!.replace(/\.git$/, "") : null
}

/** A GitHub repository. */
export interface GitHubRepo {
  /** Repository as `OWNER/REPO`. */
  name: string
  private: boolean
}

/** State of the GitHub Release of a tag. */
export type GitHubReleaseState = "missing" | "draft" | "published"

/** Returns whether a GitHub Release exists for a tag and whether it is a draft. */
export async function getGitHubReleaseState(
  ctx: Context,
  repo: string,
  tag: string,
): Promise<GitHubReleaseState> {
  const [owner, name] = repo.split("/")
  const query =
    "query($owner: String!, $name: String!, $tag: String!) { repository(owner: $owner, name: $name) { release(tagName: $tag) { isDraft } } }"
  const output = await readCommand(ctx, "gh", [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `tag=${tag}`,
  ])
  const response = JSON.parse(output) as {
    data: { repository: { release: { isDraft: boolean } | null } }
  }
  const release = response.data.repository.release
  return release === null ? "missing" : release.isDraft ? "draft" : "published"
}

/**
 * Creates a GitHub Release for an existing remote tag, titled with the tag name.
 *
 * `latest` makes the release take the `Latest` mark or leave it where it is; without it, GitHub decides.
 */
export function createGitHubRelease(
  ctx: Context,
  repo: string,
  release: { tag: string; notes: string; prerelease: boolean; latest: boolean | undefined },
) {
  const args = [
    "release",
    "create",
    release.tag,
    "--repo",
    repo,
    "--title",
    release.tag,
    "--notes-file",
    "-",
    "--verify-tag",
  ]
  if (release.prerelease) {
    args.push("--prerelease")
  }
  if (release.latest !== undefined) {
    args.push(release.latest ? "--latest" : "--latest=false")
  }
  return runCommand(ctx, "gh", args, { input: release.notes })
}

/** A CI check of a commit: a check run, such as a GitHub Actions job, or a commit status. */
export interface CommitCheck {
  name: string
  /** `waiting` is a check run awaiting approval, such as a deployment to a protected environment. */
  state: "pending" | "waiting" | "success" | "failure"
  /** Page with the check details, if GitHub has one. */
  url: string | null
}

/** Check run conclusions that do not block a release; branch protection accepts them too. */
const passingConclusions = new Set(["success", "neutral", "skipped"])

/**
 * Lists the latest check runs and commit statuses of a commit.
 *
 * A completed check run passes with a conclusion that branch protection accepts and fails with any other, such as `cancelled` or `timed_out`.
 * Fails with `GitHubAccessError` when the token cannot access the checks or the repository.
 */
export async function listCommitChecks(
  ctx: Context,
  repo: string,
  commit: string,
): Promise<CommitCheck[]> {
  const runs = await readJsonLines<{
    name: string
    status: string
    conclusion: string | null
    html_url: string | null
  }>(
    ctx,
    `repos/${repo}/commits/${commit}/check-runs?per_page=100`,
    ".check_runs[] | {name, status, conclusion, html_url}",
    { paginate: true },
  )
  const statuses = await readJsonLines<{
    context: string
    state: string
    target_url: string | null
  }>(
    ctx,
    `repos/${repo}/commits/${commit}/status?per_page=100`,
    ".statuses[] | {context, state, target_url}",
    { paginate: true },
  )
  return [
    ...runs.map(run => ({
      name: run.name,
      state: getCheckRunState(run.status, run.conclusion),
      url: run.html_url,
    })),
    ...statuses.map(status => ({
      name: status.context,
      state: getStatusState(status.state),
      url: status.target_url || null,
    })),
  ]
}

function getCheckRunState(status: string, conclusion: string | null): CommitCheck["state"] {
  if (status === "waiting") {
    return "waiting"
  }
  if (status !== "completed") {
    return "pending"
  }
  return conclusion !== null && passingConclusions.has(conclusion) ? "success" : "failure"
}

/** Maps a commit status state, which is `error` or `failure` when it fails. */
function getStatusState(state: string): CommitCheck["state"] {
  return state === "pending" || state === "success" ? state : "failure"
}

/** State of a GitHub Actions workflow, such as `active` or `disabled_manually`, or null when GitHub does not know the workflow. */
export async function getWorkflowState(ctx: Context, repo: string, workflow: string) {
  try {
    const [workflowInfo] = await readJsonLines<{ state: string }>(
      ctx,
      `repos/${repo}/actions/workflows/${workflow}`,
      "{state}",
    )
    return workflowInfo!.state
  } catch (error) {
    if (error instanceof GitHubAccessError && error.status === 404) {
      return null
    }
    throw error
  }
}

/** A run of a GitHub Actions workflow. */
export interface WorkflowRun {
  id: number
  /** `completed`, or a state before completion, such as `queued`, `in_progress`, or `waiting`. */
  status: string
  /** Result of a completed run, such as `success` or `failure`. */
  conclusion: string | null
  url: string
}

const workflowRunFilter = "{id, status, conclusion, url: .html_url}"

/** Lists the latest runs of a workflow started by `workflow_dispatch`, newest first, or none when GitHub does not know the workflow. */
export async function listWorkflowRuns(ctx: Context, repo: string, workflow: string) {
  try {
    return await readJsonLines<WorkflowRun>(
      ctx,
      `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`,
      `.workflow_runs[] | ${workflowRunFilter}`,
    )
  } catch (error) {
    if (error instanceof GitHubAccessError && error.status === 404) {
      return []
    }
    throw error
  }
}

/** Reads a run of a GitHub Actions workflow. */
export async function getWorkflowRun(ctx: Context, repo: string, id: number) {
  const [run] = await readJsonLines<WorkflowRun>(
    ctx,
    `repos/${repo}/actions/runs/${id}`,
    workflowRunFilter,
  )
  return run!
}

/** Starts a workflow with `workflow_dispatch` on a branch, with the workflow file of that branch. */
export function dispatchWorkflow(
  ctx: Context,
  repo: string,
  workflow: string,
  ref: string,
  inputs: Record<string, string>,
) {
  return runCommand(ctx, "gh", [
    "workflow",
    "run",
    workflow,
    "--repo",
    repo,
    "--ref",
    ref,
    ...Object.entries(inputs).flatMap(([name, value]) => ["-f", `${name}=${value}`]),
  ])
}

/** A failure of a GitHub API request that GitHub refused, such as for a token without access to the resource. */
export class GitHubAccessError extends ReleaseError {
  override name = "GitHubAccessError"

  constructor(
    message: string,
    /** HTTP status of the refusal: 403 or 404. */
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * Reads a GitHub REST API resource, or every page of a list with `paginate`, and returns the values that a jq filter selects.
 *
 * Fails with `GitHubAccessError` when GitHub refuses access with 403 or 404, and with `ReleaseError` on other failures, such as network errors and exceeded rate limits.
 */
async function readJsonLines<T>(
  ctx: Context,
  endpoint: string,
  filter: string,
  { paginate = false } = {},
) {
  const args = ["api", ...(paginate ? ["--paginate"] : []), endpoint, "--jq", filter]
  const result = await captureCommand(ctx, "gh", args)
  if (result.code !== 0) {
    // `gh api` reports HTTP errors as `gh: <message> (HTTP <status>)`; GitHub also answers 403 when a rate limit is exceeded.
    const status = /\(HTTP (40[34])\)/.exec(result.stderr)?.[1]
    const message = describeFailure("gh", args, result)
    if (status && !/rate limit/i.test(result.stderr)) {
      throw new GitHubAccessError(message, Number(status))
    }
    throw new ReleaseError(message)
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}
