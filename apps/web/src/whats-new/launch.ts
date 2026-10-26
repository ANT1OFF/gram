import {
  compareVersionBase,
  highlightsFor,
  type WhatsNewAudience,
  type WhatsNewRelease,
} from "./index";

export type WhatsNewDecision =
  | { readonly kind: "show"; readonly releases: readonly WhatsNewRelease[] }
  | { readonly kind: "record" }
  | { readonly kind: "none" };

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * What to do with What's New at launch. Running a newer base version than `lastSeen`, with
 * highlights for versions after it, shows those once. A first run, a downgrade, or a `lastSeen`
 * from an earlier version line is recorded quietly. Highlights are filtered by `audience`.
 */
export function whatsNewOnLaunch(
  releases: readonly WhatsNewRelease[],
  lastSeen: string | undefined,
  current: string,
  audience: WhatsNewAudience,
): WhatsNewDecision {
  if (!SEMVER.test(current) || lastSeen === current) return { kind: "none" };
  if (lastSeen === undefined || !SEMVER.test(lastSeen)) return { kind: "record" };
  if (compareVersionBase(current, lastSeen) <= 0) return { kind: "record" };
  const unseen = releases
    .filter(
      (release) =>
        compareVersionBase(release.version, lastSeen) > 0 &&
        compareVersionBase(release.version, current) <= 0,
    )
    .map((release) => ({ version: release.version, highlights: highlightsFor(release, audience) }))
    .filter((release) => release.highlights.length > 0);
  return unseen.length === 0 ? { kind: "record" } : { kind: "show", releases: unseen };
}
