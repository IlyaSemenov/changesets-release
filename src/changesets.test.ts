import { describe, expect, it } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { filterVersionOutput, getDeferredChangesets, withoutChangesets } from "./changesets"

describe("getDeferredChangesets", () => {
  const feature = { id: "feature", packages: ["alpha"] }
  const fix = { id: "fix", packages: ["beta"] }
  const empty = { id: "empty", packages: [] }

  it("defers the changesets that bump none of the given packages", () => {
    expect(getDeferredChangesets([feature, fix, empty], ["alpha"])).toEqual([fix, empty])
  })

  it("keeps a changeset of several given packages", () => {
    const both = { id: "both", packages: ["alpha", "beta"] }
    expect(getDeferredChangesets([both, fix], ["alpha", "beta"])).toEqual([])
  })

  it("fails when a given package has no pending changeset", () => {
    expect(() => getDeferredChangesets([feature, empty], ["alpha", "beta", "gamma"])).toThrow(
      "No pending changeset bumps beta, gamma.",
    )
  })

  it("fails when a changeset of a given package also bumps another package", () => {
    const both = { id: "both", packages: ["alpha", "beta", "gamma"] }
    expect(() => getDeferredChangesets([both], ["alpha"])).toThrow(
      ".changeset/both.md also bumps beta, gamma. Add `--only beta --only gamma` or split the changeset.",
    )
  })
})

describe("withoutChangesets", () => {
  const changesets = [
    { id: "pre/fix", packages: ["beta"] },
    { id: "feature", packages: ["alpha"] },
  ]

  /**
   * Runs a test in a work tree with the changesets `.changeset/pre/fix.md`, which is executable, and `.changeset/feature.md`, a symbolic link, and removes the work tree afterwards.
   */
  async function withWorkTree(test: (dir: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "changesets-release-test-"))
    try {
      mkdirSync(join(dir, ".changeset", "pre"), { recursive: true })
      writeFileSync(join(dir, ".changeset", "pre", "fix.md"), "Fix.")
      chmodSync(join(dir, ".changeset", "pre", "fix.md"), 0o755)
      writeFileSync(join(dir, "feature.md"), "Feature.")
      symlinkSync("../feature.md", join(dir, ".changeset", "feature.md"))
      await test(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Lists the Markdown files in `.changeset` of a work tree, leaving out dot files and the contents of dot directories. */
  function listVisible(dir: string) {
    return readdirSync(join(dir, ".changeset"), { recursive: true, encoding: "utf8" })
      .filter(path => path.endsWith(".md") && !path.split("/").some(part => part.startsWith(".")))
      .toSorted()
  }

  /** Asserts that both changesets are back with their mode and link, and nothing else is left in `.changeset`. */
  function expectRestored(dir: string) {
    expect(statSync(join(dir, ".changeset", "pre", "fix.md")).mode & 0o777).toBe(0o755)
    expect(readlinkSync(join(dir, ".changeset", "feature.md"))).toBe("../feature.md")
    expect(readdirSync(join(dir, ".changeset"), { recursive: true }).toSorted()).toEqual([
      "feature.md",
      "pre",
      "pre/fix.md",
    ])
  }

  it("hides the changesets during the callback and restores them", () =>
    withWorkTree(async dir => {
      expect(await withoutChangesets(dir, changesets, async () => listVisible(dir))).toEqual([])
      expectRestored(dir)
    }))

  it("restores the changesets when the callback fails", () =>
    withWorkTree(async dir => {
      await expect(
        withoutChangesets(dir, changesets, () => Promise.reject(new Error("failed"))),
      ).rejects.toThrow("failed")
      expectRestored(dir)
    }))

  it("restores the hidden changesets when hiding another one fails", () =>
    withWorkTree(async dir => {
      const missing = { id: "missing", packages: ["gamma"] }
      await expect(
        withoutChangesets(dir, [...changesets, missing], async () => {}),
      ).rejects.toThrow("ENOENT")
      expectRestored(dir)
    }))

  it("restores the other changesets and names the one it cannot restore", () =>
    withWorkTree(async dir => {
      const pre = join(dir, ".changeset", "pre")
      const path = join(pre, "fix.md")
      // A directory in place of the file makes moving the file back fail.
      const failure = withoutChangesets(dir, changesets, async () => mkdirSync(path))
      await expect(failure).rejects.toThrow(`Could not restore changesets:\n  - ${path}: `)
      expect(readlinkSync(join(dir, ".changeset", "feature.md"))).toBe("../feature.md")
      const [hiddenDir] = readdirSync(pre).filter(name => name.startsWith(".changesets-release-"))
      expect(readFileSync(join(pre, hiddenDir!, "fix.md"), "utf8")).toBe("Fix.")
    }))
})

describe("filterVersionOutput", () => {
  it("preserves warnings while removing the banner and commit advice", () => {
    const output = readFileSync(
      join(import.meta.dir, "fixtures", "changeset-version-output.txt"),
      "utf8",
    )
    expect(filterVersionOutput(output)).toBe(
      'Found issues in your config:\n- fixed: Invalid path: The package or glob "nonexistent-*" does not match any package in the project. Note that glob expressions must be defined according to https://npmx.dev/picomatch.',
    )
  })

  it("removes repeated lines while preserving the order and paragraphs of other output", () => {
    const output = readFileSync(
      join(import.meta.dir, "fixtures", "changeset-version-repeated-output.txt"),
      "utf8",
    )
    const expected = readFileSync(
      join(import.meta.dir, "fixtures", "changeset-version-repeated-output.expected.txt"),
      "utf8",
    )
    expect(filterVersionOutput(output)).toBe(expected.trim())
  })
})
