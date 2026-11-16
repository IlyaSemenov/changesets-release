// Requirements of npm trusted publishing, checked before a release depends on them, independent of the CI provider that npm trusts.
import { join } from "node:path"

import { type Context, ReleaseError } from "./context"
import { captureCommand, readCommand } from "./exec"
import { listPublishedVersions, readNpmUser } from "./npm"
import { type PackageRelease, parseManifest } from "./packages"
import type { PackageManager, RepoFileReader } from "./project"
import { compareVersions } from "./semver"

/** A CI workflow that npm can trust to publish the packages of its source repository, such as a GitHub Actions workflow. */
export interface TrustedPublisher {
  /** URL of the source repository, which the `repository` field of a package must point to for provenance. */
  repositoryUrl: string
  /** Checks whether the `repository` field of a `package.json` points to the source repository. */
  isRepository: (repository: unknown) => boolean
  /** Checks whether a job can request an OIDC token, from its environment variables. */
  canRequestOidcToken: (env: NodeJS.ProcessEnv) => boolean
  /** How to let the job request an OIDC token, for the failure when it cannot. */
  oidcAdvice: string
  /** Provider subcommand of `npm trust`, such as `github`. */
  npmTrustProvider: string
  /** Options of `npm trust` that identify the workflow. */
  npmTrustOptions: string[]
}

/** Earliest npm CLI version that publishes with trusted publishing. */
const minNpmVersion = "11.5.1"

/** Earliest npm CLI version that configures trusted publishers with `npm trust`. */
export const minTrustNpmVersion = "11.15.0"

/** Returns the arguments of `npm trust` that make a package trust a publisher to publish it. */
export function getTrustArgs(publisher: TrustedPublisher, name: string) {
  return [
    "trust",
    publisher.npmTrustProvider,
    name,
    ...publisher.npmTrustOptions,
    "--allow-publish",
  ]
}

/** Checks whether npm has `npm trust`. */
export async function hasNpmTrust(ctx: Context) {
  return compareVersions(await readCommand(ctx, "npm", ["--version"]), minTrustNpmVersion) >= 0
}

/**
 * Fails unless a trusted publisher can publish public packages.
 *
 * Each package must already be on npm: npm configures a trusted publisher only for an existing package.
 * When npm generates `provenance`, the `repository` of each package must point to the source repository, or npm rejects the publication.
 * `read` reads files of the released tree, by their paths from the repository root.
 */
export async function assertTrustedPublishable(
  ctx: Context,
  publisher: TrustedPublisher,
  packages: PackageRelease[],
  read: RepoFileReader,
  { provenance }: { provenance: boolean },
) {
  const publicPackages = packages.filter(entry => !entry.private)
  const versions = await Promise.all(
    publicPackages.map(entry => listPublishedVersions(ctx, entry.name)),
  )
  const unpublished = publicPackages.find((_, index) => versions[index]!.length === 0)
  if (unpublished) {
    throw new ReleaseError(
      `${unpublished.name} is not on npm yet, and npm can only trust a publisher of an existing package. Release with \`--publish=local\` to publish its first version; changesets-release then offers to configure its trusted publisher.`,
    )
  }
  if (!provenance) {
    return
  }
  for (const entry of publicPackages) {
    const path = join(entry.dir, "package.json")
    const manifest = parseManifest(await read(path))
    if (!publisher.isRepository(manifest?.repository)) {
      throw new ReleaseError(
        `${path}: set "repository" to "${publisher.repositoryUrl}"; npm rejects provenance of a package from another repository.`,
      )
    }
  }
}

/**
 * Fails unless a CI job is set up for npm trusted publishing: it can request an OIDC token, has a recent enough npm, and has no registry login with a token.
 *
 * npm, and pnpm in a pnpm project, must not be logged in with a token from any source, such as a variable or `.npmrc`: they would publish with it when trusted publishing fails.
 * Tokens that pnpm configures for a single scope are not detected.
 */
export async function assertTrustedPublishingEnvironment(
  ctx: Context,
  publisher: TrustedPublisher,
  packageManager: PackageManager,
) {
  if (!publisher.canRequestOidcToken(ctx.env)) {
    throw new ReleaseError(
      `The job cannot request an OIDC token for npm trusted publishing. ${publisher.oidcAdvice}`,
    )
  }
  const version = await readCommand(ctx, "npm", ["--version"])
  if (compareVersions(version, minNpmVersion) < 0) {
    throw new ReleaseError(
      `npm ${version} cannot publish with trusted publishing. Use npm ${minNpmVersion} or later, such as with Node.js 24.`,
    )
  }
  // `whoami` does not use trusted publishing, so it succeeds only with a token.
  const npmUser = await readNpmUser(ctx)
  if (npmUser !== undefined) {
    throw createTokenError("npm", npmUser)
  }
  // pnpm publishes in pnpm projects, and newer pnpm versions have credentials that npm does not see.
  if (packageManager === "pnpm") {
    const result = await captureCommand(ctx, "pnpm", ["whoami"])
    if (result.code === 0) {
      throw createTokenError("pnpm", result.stdout.trim())
    }
    const output = `${result.stdout}\n${result.stderr}`
    if (!pnpmLoggedOutPattern.test(output)) {
      throw new ReleaseError(`Could not verify the pnpm login: ${output.trim()}`)
    }
  }
}

/** Recognized errors of `pnpm whoami` when no registry credentials are available. */
const pnpmLoggedOutPattern = /ERR_PNPM_WHOAMI_UNAUTHORIZED|ENEEDAUTH|E401/

function createTokenError(tool: string, user: string) {
  return new ReleaseError(
    `${tool} is logged in as ${user} with a token, which it would publish with when trusted publishing fails. Remove npm tokens from the publishing job and its .npmrc files.`,
  )
}
