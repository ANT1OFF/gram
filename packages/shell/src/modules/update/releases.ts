import type { ReleaseInfo } from "@gram/contracts";

import { compareVersions, formatVersion, parseVersion, type Version } from "./semver.ts";

/** One release of the channel that the updater would offer. */
export interface EligibleRelease {
  readonly tag: string;
  readonly version: Version;
  readonly prerelease: boolean;
}

/**
 * Whether a tag is safe to hand to `gh release download`: a leading `v`, then only version
 * characters, at most 64 in total. `gh` gets argv, not a shell, so this is defence in depth.
 */
export function validTag(tag: string): boolean {
  return tag.length <= 64 && /^v[0-9A-Za-z._-]*$/.test(tag);
}

const field = (release: unknown, key: string): unknown =>
  typeof release === "object" && release !== null
    ? (release as Record<string, unknown>)[key]
    : undefined;

/**
 * The channel's installable releases from parsed `gh release list --json tagName,isDraft` output,
 * newest first. A release is a pre-release exactly when its tag's version has a pre-release part.
 * Drafts are always skipped, pre-releases unless `includePrerelease`, and so are tags `validTag`
 * rejects or that aren't SemVer after the `v`, so the picker never offers a release `install`
 * would refuse.
 */
export function eligibleReleases(
  releases: readonly unknown[],
  includePrerelease: boolean,
): EligibleRelease[] {
  const out: EligibleRelease[] = [];
  for (const release of releases) {
    if (field(release, "isDraft") === true) continue;
    const tag = field(release, "tagName");
    if (typeof tag !== "string" || !validTag(tag)) continue;
    const version = parseVersion(tag.slice(1));
    if (!version) continue;
    // GitHub's `isPrerelease` is ignored: any writer can toggle it on the release page, while a
    // `v*` tag only the release-please App can create.
    const prerelease = version.pre.length > 0;
    if (prerelease && !includePrerelease) continue;
    out.push({ tag, version, prerelease });
  }
  return out.toSorted((a, b) => compareVersions(b.version, a.version));
}

/** The newest eligible release, only when it's strictly newer than `current`. */
export function selectRelease(
  eligible: readonly EligibleRelease[],
  current: Version,
): EligibleRelease | undefined {
  const newest = eligible[0];
  return newest && compareVersions(newest.version, current) > 0 ? newest : undefined;
}

/**
 * Version-picker rows, newest first. Each carries its relation to the running version, so the UI
 * renders an older pick as an explicit "Downgrade to X", never a silent install.
 */
export function releaseList(eligible: readonly EligibleRelease[], current: Version): ReleaseInfo[] {
  return eligible.map(({ tag, version, prerelease }) => {
    const cmp = compareVersions(version, current);
    return {
      tag,
      version: formatVersion(version),
      prerelease,
      relation: cmp > 0 ? "newer" : cmp < 0 ? "older" : "current",
    };
  });
}
