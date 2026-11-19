import { describe, expect, it } from "bun:test"

import { isTemporaryGitHubFailure, parseGitHubRepository } from "./github"

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

describe("isTemporaryGitHubFailure", () => {
  it.each([
    'Get "https://api.github.com/repos/owner/repo/actions/workflows/publish.yml/runs?per_page=20": EOF',
    'Post "https://api.github.com/graphql": read tcp 10.0.0.1:50000->140.82.121.6:443: read: connection reset by peer',
    "read tcp 10.0.0.1:50000->140.82.121.6:443: read: connection reset by peer",
    "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
    "gh: Server Error (HTTP 502)",
    "HTTP 503: Service Unavailable (https://api.github.com/graphql)",
    "unexpected EOF",
    "unexpected end of JSON input",
    "invalid character '<' looking for beginning of value",
    "GraphQL: Something went wrong while executing your query. Please include `ABCD:1234` when reporting this issue.",
  ])("accepts %s", stderr => {
    expect(isTemporaryGitHubFailure({ code: 1, stdout: "", stderr })).toBe(true)
  })

  it("accepts a GraphQL server error with an error body", () => {
    const stdout = JSON.stringify({ message: "Bad Gateway", errors: [{ message: "Bad Gateway" }] })
    const stderr = "gh: Bad Gateway (HTTP 502)"
    expect(isTemporaryGitHubFailure({ code: 1, stdout, stderr })).toBe(true)
  })

  it.each([
    "gh: Not Found (HTTP 404)",
    "gh: Resource not accessible by personal access token (HTTP 403)",
    "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
    "gh: API rate limit exceeded for user ID 1.",
    "HTTP 401: Bad credentials (https://api.github.com/graphql)",
    "GraphQL: Could not resolve to a Repository with the name 'owner/repo'. (repository)",
    'Get "https://api.github.com/repos/owner/repo": net/http: invalid header field value for "Authorization"',
  ])("rejects %s", stderr => {
    expect(isTemporaryGitHubFailure({ code: 1, stdout: "", stderr })).toBe(false)
  })

  it("rejects a missing login", () => {
    const stderr = "To get started with GitHub CLI, please run:  gh auth login"
    expect(isTemporaryGitHubFailure({ code: 4, stdout: "", stderr })).toBe(false)
  })

  it("rejects an interruption", () => {
    expect(isTemporaryGitHubFailure({ code: null, stdout: "", stderr: "" })).toBe(false)
  })
})
