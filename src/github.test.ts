import { describe, expect, it } from "bun:test"

import { parseGitHubRepository } from "./github"

describe("parseGitHubRepository", () => {
  it.each([
    "https://github.com/owner/repo",
    "https://github.com/owner/repo/",
    "git+https://github.com/owner/repo.git",
    "git://github.com/owner/repo.git",
    "git+ssh://git@github.com/owner/repo.git",
    "ssh://git@github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "github:owner/repo",
    "owner/repo",
  ])("reads %s", url => {
    expect(parseGitHubRepository(url)).toBe("owner/repo")
  })

  it("reads the URL of a repository object", () => {
    expect(
      parseGitHubRepository({
        type: "git",
        url: "git+https://github.com/owner/repo.git",
        directory: "packages/core",
      }),
    ).toBe("owner/repo")
  })

  it("keeps dots in a repository name", () => {
    expect(parseGitHubRepository("https://github.com/owner/repo.js.git")).toBe("owner/repo.js")
  })

  it.each([
    undefined,
    {},
    "https://gitlab.com/owner/repo",
    "gitlab:owner/repo",
    "https://github.com/owner/repo/tree/main",
  ])("returns null for %p", repository => {
    expect(parseGitHubRepository(repository)).toBeNull()
  })
})
