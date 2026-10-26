/**
 * What a managed runtime may install: the compatibility gate. Pure, so every rule is a unit test.
 * It sits below the RPC handlers, and the transaction re-checks it at the moment it downloads, so
 * no caller (the UI, a retry, a rollback that has to re-download) can skip it.
 */

import { DAY_MS } from "../zone-time.ts";

/**
 * One exact runtime package for one platform, from the bundled baseline. It is named by npm
 * coordinates rather than a URL, so it comes through whatever registry the user's npm is
 * configured for, and its bytes are pinned by digest whatever served them.
 */
export interface RuntimeArtifact {
  readonly agent: "codex";
  readonly version: string;
  /** The vendor's target triple, e.g. `aarch64-apple-darwin`. */
  readonly target: string;
  readonly npm: {
    readonly package: string;
    /** The exact npm version: Codex publishes each platform as `<version>-<os>-<arch>`. */
    readonly version: string;
    /** The registry's `dist.integrity` (`sha512-…`) for the tarball. */
    readonly integrity: string;
  };
  /** Lower-case hex SHA-256 of the tarball. */
  readonly sha256: string;
  /** Exact tarball size in bytes. */
  readonly size: number;
  /** The vendor's release publication time, ISO 8601. */
  readonly publishedAt: string;
  /** When the registry published these exact bytes (`time[version]`), ISO 8601. */
  readonly artifactUpdatedAt: string;
  /** Gram versions the artifact was qualified against, as a semver range; absent: this build's baseline only. */
  readonly qualifiedFor?: string | undefined;
  /** Recorded in the install's receipt. */
  readonly source: "bundled";
}

/** Releases wait at least this long before anything installs them, whatever the channel. */
export const RELEASE_AGE_MS = DAY_MS;

/** The npm platform suffix Codex publishes `target` under, e.g. `darwin-arm64`. */
const npmPlatformOf = (target: string): string | undefined => {
  const match = /^(aarch64|x86_64)-(apple-darwin|pc-windows-msvc)$/.exec(target);
  if (match === null) return undefined;
  return `${match[2] === "apple-darwin" ? "darwin" : "win32"}-${match[1] === "aarch64" ? "arm64" : "x64"}`;
};

/** The only npm coordinates a Codex package for `version` on `target` may have. */
export const codexNpmCoordinates = (version: string, target: string) => {
  const platform = npmPlatformOf(target);
  return platform === undefined
    ? undefined
    : { package: "@openai/codex", version: `${version}-${platform}` };
};

/** Vendor target triple for this machine, or undefined where Codex ships no complete package. */
export const codexTarget = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined => {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (cpu === undefined) return undefined;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  return undefined;
};

/**
 * The earliest time `artifact` may be installed: 24 hours after the later of its publication and
 * its asset's last change. Undefined when either is unreadable, which disables installing it.
 */
export const eligibleAfter = (artifact: RuntimeArtifact): number | undefined => {
  const stamps = [artifact.publishedAt, artifact.artifactUpdatedAt].map((stamp) =>
    Date.parse(stamp),
  );
  if (stamps.some((stamp) => Number.isNaN(stamp))) return undefined;
  return Math.max(...stamps) + RELEASE_AGE_MS;
};

const parseVersion = (version: string): ReadonlyArray<number> | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const compareVersions = (a: string, b: string): number => {
  const left = parseVersion(a) ?? [0, 0, 0];
  const right = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * Whether `version` satisfies `range`: space-separated `>=x.y.z`, `<x.y.z`, `<=x.y.z`, `>x.y.z` or
 * exact `x.y.z` comparators, all of which must hold. Anything else matches nothing, so a range this
 * build can't read never widens what it installs.
 */
export const satisfies = (version: string, range: string): boolean => {
  if (parseVersion(version) === undefined) return false;
  const comparators = range.trim().split(/\s+/);
  if (comparators.length === 0 || comparators[0] === "") return false;
  return comparators.every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(comparator);
    if (match === null) return false;
    const diff = compareVersions(version, match[2]!);
    switch (match[1]) {
      case ">=":
        return diff >= 0;
      case "<=":
        return diff <= 0;
      case ">":
        return diff > 0;
      case "<":
        return diff < 0;
      default:
        return diff === 0;
    }
  });
};

export type GateRefusal =
  | { readonly reason: "wrong-platform"; readonly message: string }
  | { readonly reason: "not-qualified"; readonly message: string }
  | { readonly reason: "too-new"; readonly message: string; readonly eligibleAt: number }
  | { readonly reason: "no-release-time"; readonly message: string }
  | { readonly reason: "malformed"; readonly message: string };

export interface GateContext {
  /** This Gram's version, which an artifact's `qualifiedFor`, when it has one, must include. */
  readonly appVersion: string;
  readonly target: string | undefined;
  readonly now: number;
}

/**
 * Undefined when `artifact` may be installed here and now; otherwise why not. Nothing the user
 * says changes the answer: there is no override.
 */
export const gate = (artifact: RuntimeArtifact, context: GateContext): GateRefusal | undefined => {
  if (
    parseVersion(artifact.version) === undefined ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(artifact.npm.integrity)
  ) {
    return { reason: "malformed", message: `The Codex ${artifact.version} entry is incomplete.` };
  }
  if (context.target === undefined || artifact.target !== context.target) {
    return {
      reason: "wrong-platform",
      message: `Codex ${artifact.version} for ${artifact.target} doesn't run on this machine.`,
    };
  }
  const coordinates = codexNpmCoordinates(artifact.version, artifact.target);
  if (
    coordinates === undefined ||
    artifact.npm.package !== coordinates.package ||
    artifact.npm.version !== coordinates.version
  ) {
    // Anything else could be a package a registry serves under a name Codex doesn't publish.
    return {
      reason: "malformed",
      message: `The Codex ${artifact.version} entry names ${artifact.npm.package}@${artifact.npm.version}, not Codex's own package.`,
    };
  }
  // A beta (`0.8.0-rc.2`) is qualified as the release it becomes.
  const appVersion = context.appVersion.replace(/-.*$/, "");
  const qualified =
    artifact.qualifiedFor === undefined || satisfies(appVersion, artifact.qualifiedFor);
  if (!qualified) {
    return {
      reason: "not-qualified",
      message: `Codex ${artifact.version} hasn't been qualified for Gram ${context.appVersion}.`,
    };
  }
  const eligibleAt = eligibleAfter(artifact);
  if (eligibleAt === undefined) {
    return {
      reason: "no-release-time",
      message: `Codex ${artifact.version} has no trustworthy release time, so it can't be installed.`,
    };
  }
  if (context.now < eligibleAt) {
    return {
      reason: "too-new",
      message: `Codex ${artifact.version} can be installed from ${new Date(eligibleAt).toISOString()}: releases wait at least 24 hours.`,
      eligibleAt,
    };
  }
  return undefined;
};

/** The newest artifact that passes the gate. */
export const latestAllowed = (
  artifacts: ReadonlyArray<RuntimeArtifact>,
  context: GateContext,
): RuntimeArtifact | undefined =>
  artifacts
    .filter((artifact) => gate(artifact, context) === undefined)
    .toSorted((a, b) => compareVersions(b.version, a.version))[0];
