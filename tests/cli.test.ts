import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFixture, expectReleased } from "./fixture"

const cliPath = join(import.meta.dir, "..", "src", "cli.ts")

/** Runs the CLI with stdin closed, as an agent does without a terminal. */
function runWithoutTerminal(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
}

describe("without a terminal", () => {
  it("refuses a release and suggests only a dry run", () => {
    const result = runWithoutTerminal(tmpdir(), process.env)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("A release needs an interactive terminal.")
    expect(result.stderr).toContain("--dry-run")
    expect(result.stderr).not.toContain("--yes")
  })

  it("releases with --yes", () => {
    const fixture = createFixture()
    const result = runWithoutTerminal(fixture.dir, fixture.env, "--yes")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Confirmed with --yes.")
    expectReleased(fixture, "1.0.1")
  })

  it("previews a release with --dry-run", () => {
    const fixture = createFixture()
    const head = fixture.git("rev-parse", "HEAD")
    const result = runWithoutTerminal(fixture.dir, fixture.env, "--dry-run")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Dry run: nothing was changed.")
    expect(fixture.git("rev-parse", "HEAD")).toBe(head)
  })
})
