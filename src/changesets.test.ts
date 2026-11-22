import { describe, expect, it } from "bun:test"
import {
  chmodSync,
  linkSync,
  lstatSync,
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

import {
  filterVersionOutput,
  selectChangesets,
  withPrivatePackages,
  withSelectedChangesets,
  writeChangesets,
} from "./changesets"

/** Creates a pending changeset with the given bump of each package. */
function createChangeset(id: string, releases: Record<string, string>) {
  const entries = Object.entries(releases).map(([name, type]) => ({ name, type }))
  return { id, releases: entries, summary: `Change ${id}.` }
}

function readFixture(name: string) {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
}

describe("selectChangesets", () => {
  const feature = createChangeset("feature", { alpha: "minor" })
  const fix = createChangeset("fix", { beta: "patch" })
  const empty = createChangeset("empty", { beta: "none" })

  it("defers the changesets that bump none of the given packages", () => {
    expect(selectChangesets([feature, fix, empty], ["alpha"])).toEqual({
      deferred: [fix, empty],
      split: [],
    })
  })

  it("keeps a changeset of several given packages whole", () => {
    const both = createChangeset("both", { alpha: "minor", beta: "patch" })
    expect(selectChangesets([both, fix], ["alpha", "beta"])).toEqual({ deferred: [], split: [] })
  })

  it("partitions a shared changeset by package name", () => {
    const shared = createChangeset("shared", {
      alpha: "minor",
      beta: "patch",
      gamma: "none",
      delta: "none",
    })
    const gammaFix = createChangeset("gamma-fix", { gamma: "patch" })
    expect(selectChangesets([shared, gammaFix], ["alpha", "gamma"])).toEqual({
      deferred: [],
      split: [
        {
          applied: createChangeset("shared", { alpha: "minor", gamma: "none" }),
          kept: createChangeset("shared", { beta: "patch", delta: "none" }),
        },
      ],
    })
  })

  it("fails when a given package has no pending changeset", () => {
    expect(() => selectChangesets([feature, empty], ["alpha", "beta", "gamma"])).toThrow(
      "No pending changeset bumps beta, gamma.",
    )
  })
})

describe("withSelectedChangesets", () => {
  const deferred = [
    createChangeset("pre/fix", { beta: "patch" }),
    createChangeset("feature", { alpha: "minor" }),
  ]
  const split = [
    {
      applied: createChangeset("shared", { alpha: "patch" }),
      kept: createChangeset("shared", { beta: "patch" }),
    },
  ]
  const shared = readFixture("changeset-shared.md")

  /**
   * Runs a test in a work tree with the changesets `.changeset/pre/fix.md`, which is executable, `.changeset/feature.md`, a symbolic link, and `.changeset/shared.md`, and removes the work tree afterwards.
   */
  async function withWorkTree(test: (dir: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "changesets-release-test-"))
    try {
      mkdirSync(join(dir, ".changeset", "pre"), { recursive: true })
      writeFileSync(join(dir, ".changeset", "pre", "fix.md"), "Fix.")
      chmodSync(join(dir, ".changeset", "pre", "fix.md"), 0o755)
      writeFileSync(join(dir, "feature.md"), "Feature.")
      symlinkSync("../feature.md", join(dir, ".changeset", "feature.md"))
      writeFileSync(join(dir, ".changeset", "shared.md"), shared)
      await test(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Reads the Markdown files in `.changeset` of a work tree by path, leaving out dot files and the contents of dot directories. */
  function readVisible(dir: string) {
    const paths = readdirSync(join(dir, ".changeset"), { recursive: true, encoding: "utf8" })
      .filter(path => path.endsWith(".md") && !path.split("/").some(part => part.startsWith(".")))
      .toSorted()
    return Object.fromEntries(
      paths.map(path => [path, readFileSync(join(dir, ".changeset", path), "utf8")]),
    )
  }

  /** Asserts that the changesets are back with their contents, mode, and link, and nothing else is left in `.changeset`. */
  function expectRestored(dir: string) {
    expect(statSync(join(dir, ".changeset", "pre", "fix.md")).mode & 0o777).toBe(0o755)
    expect(readlinkSync(join(dir, ".changeset", "feature.md"))).toBe("../feature.md")
    expect(readFileSync(join(dir, ".changeset", "shared.md"), "utf8")).toBe(shared)
    expect(readdirSync(join(dir, ".changeset"), { recursive: true }).toSorted()).toEqual([
      "feature.md",
      "pre",
      "pre/fix.md",
      "shared.md",
    ])
  }

  it("narrows the changesets during the callback and restores them", () =>
    withWorkTree(async dir => {
      expect(
        await withSelectedChangesets(dir, { deferred, split }, async () => readVisible(dir)),
      ).toEqual({ "shared.md": readFixture("changeset-shared-applied.md") })
      expectRestored(dir)
    }))

  it("restores a split changeset that the callback removes", () =>
    withWorkTree(async dir => {
      await withSelectedChangesets(dir, { deferred, split }, async () =>
        rmSync(join(dir, ".changeset", "shared.md")),
      )
      expectRestored(dir)
    }))

  it("restores the changesets when the callback fails", () =>
    withWorkTree(async dir => {
      await expect(
        withSelectedChangesets(dir, { deferred, split }, () => Promise.reject(new Error("failed"))),
      ).rejects.toThrow("failed")
      expectRestored(dir)
    }))

  it("restores the hidden changesets when hiding another one fails", () =>
    withWorkTree(async dir => {
      const missing = createChangeset("missing", { gamma: "patch" })
      await expect(
        withSelectedChangesets(dir, { deferred: [...deferred, missing], split }, async () => {}),
      ).rejects.toThrow("ENOENT")
      expectRestored(dir)
    }))

  it("restores the other changesets and names the one it cannot restore", () =>
    withWorkTree(async dir => {
      const pre = join(dir, ".changeset", "pre")
      const path = join(pre, "fix.md")
      // A directory in place of the file makes moving the file back fail.
      const failure = withSelectedChangesets(dir, { deferred, split }, async () => mkdirSync(path))
      await expect(failure).rejects.toThrow(`Could not restore changesets:\n  - ${path}: `)
      expect(readlinkSync(join(dir, ".changeset", "feature.md"))).toBe("../feature.md")
      expect(readFileSync(join(dir, ".changeset", "shared.md"), "utf8")).toBe(shared)
      const [hiddenDir] = readdirSync(pre).filter(name => name.startsWith(".changesets-release-"))
      expect(readFileSync(join(pre, hiddenDir!, "fix.md"), "utf8")).toBe("Fix.")
    }))
})

describe("writeChangesets", () => {
  const entry = createChangeset("shared", { "@acme/beta": "patch", gamma: "none" })

  /** Runs a test in a work tree with an empty `.changeset` directory, and removes the work tree afterwards. */
  async function withWorkTree(test: (dir: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "changesets-release-test-"))
    try {
      mkdirSync(join(dir, ".changeset"))
      await test(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("writes the frontmatter and the summary of a changeset", () =>
    withWorkTree(async dir => {
      await writeChangesets(dir, [entry])
      expect(readFileSync(join(dir, ".changeset", "shared.md"), "utf8")).toBe(
        readFixture("changeset-written.md"),
      )
    }))

  it("keeps the mode of a file that it overwrites", () =>
    withWorkTree(async dir => {
      const path = join(dir, ".changeset", "shared.md")
      writeFileSync(path, "Shared.")
      chmodSync(path, 0o755)
      await writeChangesets(dir, [entry])
      expect(statSync(path).mode & 0o777).toBe(0o755)
      expect(readFileSync(path, "utf8")).toBe(readFixture("changeset-written.md"))
    }))

  it("leaves another hard link of the file unchanged", () =>
    withWorkTree(async dir => {
      writeFileSync(join(dir, "shared.md"), "Shared.")
      linkSync(join(dir, "shared.md"), join(dir, ".changeset", "shared.md"))
      await writeChangesets(dir, [entry])
      expect(readFileSync(join(dir, "shared.md"), "utf8")).toBe("Shared.")
      expect(readFileSync(join(dir, ".changeset", "shared.md"), "utf8")).toBe(
        readFixture("changeset-written.md"),
      )
      expect(readdirSync(join(dir, ".changeset"))).toEqual(["shared.md"])
    }))

  it("leaves a file at a path beside the changeset unchanged", () =>
    withWorkTree(async dir => {
      const beside = join(dir, ".changeset", ".shared.md.changesets-release")
      writeFileSync(beside, "Beside.")
      await writeChangesets(dir, [entry])
      expect(readFileSync(beside, "utf8")).toBe("Beside.")
      expect(readdirSync(join(dir, ".changeset")).toSorted()).toEqual([
        ".shared.md.changesets-release",
        "shared.md",
      ])
    }))

  it("replaces a symbolic link instead of writing to its target", () =>
    withWorkTree(async dir => {
      writeFileSync(join(dir, "shared.md"), "Shared.")
      symlinkSync("../shared.md", join(dir, ".changeset", "shared.md"))
      await writeChangesets(dir, [entry])
      expect(readFileSync(join(dir, "shared.md"), "utf8")).toBe("Shared.")
      expect(lstatSync(join(dir, ".changeset", "shared.md")).isFile()).toBe(true)
      expect(readFileSync(join(dir, ".changeset", "shared.md"), "utf8")).toBe(
        readFixture("changeset-written.md"),
      )
    }))
})

describe("withPrivatePackages", () => {
  const manifest = '{"name":"alpha",  "version":"1.0.0"}'
  const config = '{ "baseBranch": "main", "privatePackages": false }\n'

  /** Runs a test in a work tree with the package `packages/alpha`, written compactly, and the Changesets config, and removes the work tree afterwards. */
  async function withWorkTree(test: (dir: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "changesets-release-test-"))
    try {
      mkdirSync(join(dir, "packages", "alpha"), { recursive: true })
      mkdirSync(join(dir, ".changeset"))
      writeFileSync(join(dir, "packages", "alpha", "package.json"), manifest)
      writeFileSync(join(dir, ".changeset", "config.json"), config)
      await test(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Asserts that the manifest and the config have their original content. */
  function expectRestored(dir: string) {
    expect(readFileSync(join(dir, "packages", "alpha", "package.json"), "utf8")).toBe(manifest)
    expect(readFileSync(join(dir, ".changeset", "config.json"), "utf8")).toBe(config)
  }

  it("marks the packages private and lets Changesets version private packages during the callback", async () => {
    await withWorkTree(async dir => {
      await withPrivatePackages(dir, ["packages/alpha"], async () => {
        const json = JSON.parse(
          readFileSync(join(dir, "packages", "alpha", "package.json"), "utf8"),
        )
        expect(json).toEqual({ name: "alpha", version: "1.0.0", private: true })
        expect(JSON.parse(readFileSync(join(dir, ".changeset", "config.json"), "utf8"))).toEqual({
          baseBranch: "main",
          privatePackages: { version: true, tag: false },
        })
      })
      expectRestored(dir)
    })
  })

  it("restores the files when the callback fails", async () => {
    await withWorkTree(async dir => {
      const promise = withPrivatePackages(dir, ["packages/alpha"], () =>
        Promise.reject(new Error("Publication failed.")),
      )
      await expect(promise).rejects.toThrow("Publication failed.")
      expectRestored(dir)
    })
  })

  it("restores the files changed so far when a later package cannot be changed", async () => {
    await withWorkTree(async dir => {
      let called = false
      const promise = withPrivatePackages(dir, ["packages/alpha", "packages/missing"], async () => {
        called = true
      })
      await expect(promise).rejects.toThrow("ENOENT")
      expect(called).toBe(false)
      expectRestored(dir)
    })
  })
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
