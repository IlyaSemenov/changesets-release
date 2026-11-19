import { describe, expect, it } from "bun:test"

import type { Context } from "./context"
import { captureCommand } from "./exec"

/** Creates a context for subprocesses in the current directory. */
function createContext(): Context {
  return {
    cwd: process.cwd(),
    env: process.env,
    interactive: false,
    pollInterval: 0,
    presenceTimeout: Infinity,
    log: () => {},
    confirm: async () => true,
    waitForUser: async () => true,
  }
}

describe("captureCommand", () => {
  it.each([0, 3])(
    "resolves with exit code %d of a command that exits without reading its input",
    async code => {
      const result = await captureCommand(
        createContext(),
        process.execPath,
        ["-e", `process.exit(${code})`],
        // Larger than a pipe buffer, so that the write is still pending when the command exits.
        { input: "x".repeat(4 * 1024 * 1024) },
      )
      expect(result.code).toBe(code)
    },
  )
})
