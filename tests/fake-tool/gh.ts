// Fake gh: login, repository, release, and CI commands work on the fake state, and other commands fail.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { fail, type FakeCall, type FakeCommand, findCommand } from "./call"
import { type FakeState, updateFakeState } from "./state"

/** Runs a gh command. */
export function runGh(call: FakeCall) {
  const authCommand = findCommand(authCommands, call.args)
  if (authCommand) {
    authCommand(call)
    return
  }
  if (!call.state.gh.authenticated) {
    fail("To get started with GitHub CLI, please run:  gh auth login", 4)
  }
  if (call.args[0] === "api") {
    failApiRequest(call)
  }
  const command =
    findCommand(commands, call.args) ?? fail(`unsupported fake gh command: ${call.args.join(" ")}`)
  command(call)
}

/** Fails the request when a matching `apiFailures` rule calls for it. */
function failApiRequest({ args, state, stateDir }: FakeCall) {
  const endpoint = args.slice(1).find(arg => !arg.startsWith("-"))!
  if (!state.gh.apiFailures.some(failure => endpoint.includes(failure.endpoint))) {
    return
  }
  let error: FakeState["gh"]["apiFailures"][number]["error"] | null = null
  updateFakeState(stateDir, current => {
    for (const failure of current.gh.apiFailures) {
      if (!endpoint.includes(failure.endpoint)) {
        continue
      }
      const request = failure.requests ?? 0
      failure.requests = request + 1
      if (request >= failure.after && request < failure.after + failure.count) {
        error ??= failure.error
      }
    }
  })
  if (error === "network") {
    const method = endpoint === "graphql" ? "Post" : "Get"
    fail(`${method} "https://api.github.com/${endpoint}": read: connection reset by peer`)
  } else if (error === "server") {
    fail("gh: Server Error (HTTP 502)")
  } else if (error === "no-access") {
    fail("gh: Resource not accessible by personal access token (HTTP 403)")
  } else if (error === "rate-limit") {
    fail("gh: API rate limit exceeded for user ID 1. (HTTP 403)")
  }
}

/** Commands that work without a login. */
const authCommands: Record<string, FakeCommand> = {
  "auth token": showToken,
  "auth login": login,
}

/** Commands that need a login. */
const commands: Record<string, FakeCommand> = {
  "repo view": viewRepo,
  "api graphql": queryRelease,
  "api --paginate": listChecks,
  api: readWorkflowApi,
  "release create": createRelease,
  "workflow run": dispatchWorkflow,
}

function showToken({ state }: FakeCall) {
  if (!state.gh.authenticated) {
    fail("no oauth token found for github.com")
  }
  console.log("gho_fake")
}

function login({ state, stateDir }: FakeCall) {
  if (state.gh.loginFailure) {
    fail("error authenticating with GitHub: authorization denied")
  }
  updateFakeState(stateDir, current => {
    current.gh.authenticated = true
  })
}

function viewRepo({ state }: FakeCall) {
  if (state.gh.repoViewFailure) {
    fail("error connecting to api.github.com")
  }
  console.log(
    JSON.stringify({
      nameWithOwner: state.gh.repo,
      viewerPermission: "ADMIN",
      isPrivate: state.gh.private,
    }),
  )
}

function queryRelease({ args, state }: FakeCall) {
  const tag = args.find(arg => arg.startsWith("tag="))?.slice("tag=".length) ?? fail("missing tag")
  const release = state.gh.releases.find(entry => entry.tag === tag)
  console.log(
    JSON.stringify({
      data: { repository: { release: release ? { isDraft: release.draft === true } : null } },
    }),
  )
}

/** Prints the CI check runs or commit statuses that the jq filter of the real command selects, one JSON object per line. */
function listChecks({ args, state, stateDir }: FakeCall) {
  const match = /^repos\/(.+)\/commits\/(\w+)\/(check-runs|status)\?/.exec(args[2]!)
  if (!match || match[1] !== state.gh.repo) {
    fail(`unexpected endpoint ${args[2]}`)
  }
  const [, , commit, endpoint] = match
  const items: unknown[] = []
  updateFakeState(stateDir, current => {
    if (endpoint === "check-runs") {
      for (const run of current.gh.checkRuns[commit!] ?? []) {
        if ((run.missingReads ?? 0) > 0) {
          run.missingReads! -= 1
          continue
        }
        const pending = run.waiting || (run.pendingReads ?? 0) > 0
        items.push({
          name: run.name,
          status: run.waiting ? "waiting" : pending ? "in_progress" : "completed",
          conclusion: pending ? null : run.conclusion,
          html_url: `https://github.com/${current.gh.repo}/runs/${run.name}`,
        })
        run.pendingReads = Math.max(0, (run.pendingReads ?? 0) - 1)
      }
    } else {
      for (const status of current.gh.statuses[commit!] ?? []) {
        const pending = (status.pendingReads ?? 0) > 0
        items.push({
          context: status.context,
          state: pending ? "pending" : status.state,
          target_url: null,
        })
        status.pendingReads = Math.max(0, (status.pendingReads ?? 0) - 1)
      }
    }
  })
  for (const item of items) {
    console.log(JSON.stringify(item))
  }
}

function createRelease({ args, state, stateDir }: FakeCall) {
  const option = (name: string) => args[args.indexOf(name) + 1]
  const tag = args[2]!
  if (option("--repo") !== state.gh.repo) {
    fail(`unexpected repository ${option("--repo")}`)
  }
  if (state.gh.createFailure) {
    fail("HTTP 502: Bad Gateway")
  }
  const remoteTag = spawnSync(
    "git",
    ["ls-remote", "--tags", process.env.FAKE_REMOTE!, `refs/tags/${tag}`],
    { encoding: "utf8" },
  )
  if (!remoteTag.stdout.trim()) {
    fail(`tag ${tag} doesn't exist in the remote`)
  }
  const notes = readFileSync(0, "utf8")
  let exists = false
  updateFakeState(stateDir, current => {
    exists = current.gh.releases.some(entry => entry.tag === tag)
    if (!exists) {
      current.gh.releases.push({
        tag,
        title: option("--title")!,
        notes,
        prerelease: args.includes("--prerelease"),
        latest: args.includes("--latest")
          ? true
          : args.includes("--latest=false")
            ? false
            : undefined,
      })
    }
  })
  if (exists) {
    fail("a release with the same tag name already exists")
  }
}

/** Prints what the jq filter of the real command selects from the GitHub Actions API: a workflow state, the runs of a workflow, or one run. */
function readWorkflowApi({ args, state, stateDir }: FakeCall) {
  const endpoint = args[1]!
  const prefix = `repos/${state.gh.repo}/actions/`
  if (!endpoint.startsWith(prefix)) {
    fail(`unexpected endpoint ${endpoint}`)
  }
  const path = endpoint.slice(prefix.length).split("?")[0]!
  const workflowRuns = /^workflows\/([^/]+)\/runs$/.exec(path)
  const workflow = /^workflows\/([^/]+)$/.exec(path)
  const run = /^runs\/(\d+)$/.exec(path)
  if (workflowRuns) {
    if (!(workflowRuns[1]! in state.gh.workflows)) {
      fail("gh: Not Found (HTTP 404)")
    }
    for (const entry of state.gh.runs
      .filter(item => item.workflow === workflowRuns[1] && !item.omitFromRunList)
      .toReversed()) {
      console.log(JSON.stringify(formatRun(state, entry)))
    }
  } else if (workflow) {
    const workflowState = state.gh.workflows[workflow[1]!] ?? fail("gh: Not Found (HTTP 404)")
    console.log(JSON.stringify({ state: workflowState }))
  } else if (run) {
    let found: FakeState["gh"]["runs"][number] | undefined
    updateFakeState(stateDir, current => {
      const entry = current.gh.runs.find(item => item.id === Number(run[1]))
      if (entry) {
        found = { ...entry }
        entry.pendingReads = Math.max(0, entry.pendingReads - 1)
      }
    })
    console.log(JSON.stringify(formatRun(state, found ?? fail("gh: Not Found (HTTP 404)"))))
  } else {
    fail(`unexpected endpoint ${endpoint}`)
  }
}

function formatRun(state: FakeState, run: FakeState["gh"]["runs"][number]) {
  const completed = run.pendingReads === 0
  return {
    id: run.id,
    status: completed ? "completed" : "in_progress",
    conclusion: completed ? run.conclusion : null,
    url: `https://github.com/${state.gh.repo}/actions/runs/${run.id}`,
  }
}

function dispatchWorkflow({ args, state, stateDir }: FakeCall) {
  const option = (name: string) => args[args.indexOf(name) + 1]!
  const workflow = args[2]!
  if (option("--repo") !== state.gh.repo) {
    fail(`unexpected repository ${option("--repo")}`)
  }
  const workflowState =
    state.gh.workflows[workflow] ??
    fail(`could not find any workflows named ${workflow} (HTTP 404)`)
  if (workflowState !== "active") {
    fail(`could not create workflow dispatch event: HTTP 422: Workflow is disabled.`)
  }
  const inputs = Object.fromEntries(
    args.flatMap((arg, index) =>
      args[index - 1] === "-f" ? [arg.split("=", 2) as [string, string]] : [],
    ),
  )
  const readRemote = (...gitArgs: string[]) =>
    spawnSync("git", gitArgs, { cwd: process.env.FAKE_REMOTE, encoding: "utf8" }).stdout
  // The fixture workflows declare inputs as the only keys indented by 6 spaces.
  const declared = new Set(
    readRemote("show", `${option("--ref")}:.github/workflows/${workflow}`)
      .split("\n")
      .flatMap(line => /^ {6}([\w-]+):$/.exec(line)?.[1] ?? []),
  )
  const unexpected = Object.keys(inputs).filter(name => !declared.has(name))
  if (unexpected.length > 0) {
    fail(
      `could not create workflow dispatch event: HTTP 422: Unexpected inputs provided: ${JSON.stringify(unexpected)}`,
    )
  }
  const sha = readRemote("rev-parse", option("--ref")).trim()
  updateFakeState(stateDir, current => {
    current.gh.runs.push({
      id: current.gh.runs.length + 1,
      workflow,
      ref: option("--ref"),
      sha,
      inputs,
      ...current.gh.runOutcome,
    })
  })
}
