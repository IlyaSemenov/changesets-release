// Fake npm and pnpm: registry commands work on the fake state, and other commands, such as install, run the real tools.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { fail, type FakeCall, type FakeCommand, findCommand } from "./call"
import { updateFakeState } from "./state"

/** Runs an npm or pnpm command. */
export function runNpm(call: FakeCall) {
  const commands = call.tool === "npm" ? { ...registryCommands, ...npmCommands } : registryCommands
  const command = findCommand(commands, call.args)
  if (command) {
    command(call)
  } else {
    passThrough(call)
  }
}

/** Registry commands that npm and pnpm share. */
const registryCommands: Record<string, FakeCommand> = {
  whoami: showUser,
  view: viewPackage,
  info: viewPackage,
  publish,
}

/** Registry commands that only npm has. */
const npmCommands: Record<string, FakeCommand> = {
  "--version": ({ state }) => console.log(state.npm.cliVersion),
  login,
  "access list": listCollaborators,
  "org ls": listOrgMembers,
  "trust github": trustWorkflow,
}

function showUser(call: FakeCall) {
  const { loggedOutError, whoamiFailure } = call.state.npm
  // The publishing workflow has its own npm settings.
  const user = process.env.GITHUB_ACTIONS
    ? call.state.npm.workflowUsers[call.tool as "npm" | "pnpm"]
    : call.state.npm.user
  if (whoamiFailure) {
    registryError(call, "ECONNRESET", "request to https://registry.npmjs.org/-/whoami failed")
  }
  if (!user) {
    registryError(
      call,
      loggedOutError,
      loggedOutError === "E401"
        ? "Unauthorized - GET https://registry.npmjs.org/-/whoami"
        : "This command requires you to be logged in to https://registry.npmjs.org/",
    )
  }
  console.log(call.args.includes("--json") ? JSON.stringify(user) : user)
}

function login({ state, stateDir }: FakeCall) {
  const { loginUser } = state.npm
  if (!loginUser) {
    fail("npm error code E401\nnpm error Incorrect or missing password.")
  }
  updateFakeState(stateDir, current => {
    current.npm.user = loginUser
  })
}

function viewPackage(call: FakeCall) {
  const { state, tool } = call
  const spec = call.args[1] ?? ""
  const at = spec.lastIndexOf("@")
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined]
  const versions = (state.npm.versions[name] ?? []).filter(
    entry => !state.npm.hidden.includes(`${name}@${entry}`),
  )
  if (version === undefined && versions.length > 0) {
    const distTags = state.npm.distTags[name] ?? { latest: versions.at(-1)! }
    const info: Record<string, unknown> = { name, versions, "dist-tags": distTags }
    // A field after the package selects it, as `npm view <package> versions` does; npm prints a single version as a string.
    const field = call.args[2]
    const value = field && field in info ? info[field] : info
    console.log(JSON.stringify(Array.isArray(value) && value.length === 1 ? value[0] : value))
  } else if (version !== undefined && versions.includes(version)) {
    console.log(JSON.stringify(version))
  } else {
    registryError(
      call,
      tool === "pnpm" ? "ERR_PNPM_PACKAGE_NOT_FOUND" : "E404",
      `Not Found - ${spec}`,
    )
  }
}

function listCollaborators(call: FakeCall) {
  const { state } = call
  const [, , , name = "", user = ""] = call.args
  if (!state.npm.versions[name]?.length) {
    registryError(call, "E404", `Not Found - GET ${name}/collaborators - Package not found`)
  }
  const maintainers = state.npm.maintainers[name] ?? [state.npm.user!]
  console.log(JSON.stringify(maintainers.includes(user) ? { [user]: "read-write" } : {}))
}

function listOrgMembers(call: FakeCall) {
  const { state } = call
  const [, , org = "", user = ""] = call.args
  const scope = `@${org}`
  const members =
    (scope in state.npm.scopes ? state.npm.scopes[scope] : [state.npm.user!]) ??
    registryError(call, "E404", `Not Found - GET -/org/${org}/user - Scope not found`)
  console.log(JSON.stringify(members.includes(user) ? { [user]: "developer" } : {}))
}

/** Makes a published package trust the publishing workflow of the fixture repository. */
function trustWorkflow(call: FakeCall) {
  const { args, state, stateDir } = call
  const name = args[2]!
  const option = (flag: string) => args[args.indexOf(flag) + 1]
  if (
    option("--repo") !== "owner/fixture" ||
    option("--file") !== "publish.yml" ||
    option("--env") !== "npm" ||
    !args.includes("--allow-publish")
  ) {
    fail(`unexpected trusted publisher: ${args.join(" ")}`)
  }
  if (state.npm.trustFailure) {
    registryError(call, "E403", "Two-factor authentication is required")
  }
  if (!state.npm.versions[name]?.length) {
    registryError(call, "E404", `Not Found - ${name}`)
  }
  if (state.npm.trustedPublishers.includes(name)) {
    registryError(call, "E409", `${name} already has a trusted publisher`)
  }
  updateFakeState(stateDir, current => {
    current.npm.trustedPublishers.push(name)
  })
}

function publish(call: FakeCall) {
  const { args, state, stateDir, tool } = call
  const { name, version } = JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string
    version: string
  }
  const failure = state.npm.publishFailures[name]
  // npm authenticates with trusted publishing when GitHub Actions lets the job request an OIDC token.
  const trusted = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  if (trusted && !state.npm.trustedPublishers.includes(name)) {
    registryError(
      call,
      "ENEEDAUTH",
      "This command requires you to be logged in to https://registry.npmjs.org/",
    )
  }
  const provenance = process.env.NPM_CONFIG_PROVENANCE
  let conflict = false
  if (failure !== "before-upload") {
    updateFakeState(stateDir, current => {
      const versions = (current.npm.versions[name] ??= [])
      if (versions.includes(version)) {
        conflict = true
        return
      }
      const tag = args[args.indexOf("--tag") + 1]!
      const distTags = (current.npm.distTags[name] ??=
        versions.length > 0 ? { latest: versions.at(-1)! } : {})
      versions.push(version)
      distTags[tag] = version
      current.npm.publishes.push({
        tool,
        name,
        version,
        tag,
        trusted,
        provenance: trusted ? provenance !== "false" : provenance === "true",
      })
    })
  }
  if (conflict) {
    registryError(
      call,
      "E403",
      `You cannot publish over the previously published versions: ${version}.`,
    )
  }
  if (failure === "before-upload") {
    registryError(call, "E500", "Internal Server Error")
  }
  if (failure === "after-upload") {
    registryError(call, "ECONNRESET", "socket hang up")
  }
}

/** Prints a registry error as JSON output and exits: npm reports `{ error: { code, summary } }`, and pnpm 11+ `{ error: { code, message } }`. */
function registryError({ tool }: FakeCall, code: string, message: string): never {
  const error = tool === "pnpm" ? { code, message } : { code, summary: message, detail: "" }
  process.stdout.write(JSON.stringify({ error }))
  process.exit(1)
}

/** Runs the command with the real tool and exits with its code. */
function passThrough({ tool, args }: FakeCall): never {
  const command = tool === "npm" ? process.env.FAKE_REAL_NPM! : process.env.FAKE_REAL_PNPM!
  // The real tools may need utilities that the restricted test PATH lacks.
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, PATH: process.env.FAKE_REAL_PATH },
  })
  process.exit(result.status ?? 1)
}
