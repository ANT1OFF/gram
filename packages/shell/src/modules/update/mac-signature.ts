import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export const SIGNED_MAC_BUNDLE_ID = "io.github.ant1off.gram";

// ---------------------------------------------------------------------------------------------
// Developer ID publisher identity. Shared by the signer (apps/desktop/scripts/sign-mac.mjs), the
// release script and the updater, so all three hold builds to one requirement.

/**
 * The Apple Developer Team ID that signs Gram, from its `Developer ID Application` identity. Null
 * would switch signing off: the release script then builds unsigned and the updater refuses every
 * signed release.
 */
export const GRAM_MAC_TEAM_ID: string | null = "ANVR857GFZ";
export const SIGNED_MAC_BUILD_SCHEMA = "gram.signed-build/v1";

export const validTeamId = (teamId: unknown): teamId is string =>
  typeof teamId === "string" && /^[A-Z0-9]{10}$/.test(teamId);

/**
 * The designated requirement a Gram build signed with the team's Developer ID Application
 * certificate satisfies: Apple's Developer ID chain (intermediate and leaf marker OIDs), Gram's
 * bundle identifier and the team as the leaf certificate's organizational unit.
 */
export function macDesignatedRequirement(teamId: string): string {
  if (!validTeamId(teamId)) throw new Error("A 10-character Apple Team ID is required");
  return (
    `anchor apple generic and identifier "${SIGNED_MAC_BUNDLE_ID}"` +
    " and certificate 1[field.1.2.840.113635.100.6.2.6] exists" +
    " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" +
    ` and certificate leaf[subject.OU] = "${teamId}"`
  );
}

/** What BUILD-INFO and the updater record as `requirementSha256`. */
export const macRequirementSha256 = (teamId: string): string =>
  createHash("sha256").update(macDesignatedRequirement(teamId)).digest("hex");

/** The team of a `Developer ID Application: Name (TEAMID)` Keychain identity name. */
export function developerIdTeam(identity: string): string | undefined {
  const match = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(identity);
  return match?.[1];
}

export interface MacCodeSignature {
  /** `codesign --verify --deep --strict -R=<requirement>`: 0 satisfied, 3 unsatisfied. */
  readonly requirement: "satisfied" | "unsatisfied" | "invalid";
  readonly identifier: string | null;
  readonly teamId: string | null;
  readonly hardenedRuntime: boolean;
  /** `spctl --assess --type execute`'s `source=`, or null when Gatekeeper rejected the bundle. */
  readonly gatekeeper: string | null;
  /** `xcrun stapler validate`'s verdict on the notarization ticket, or null when not asked. */
  readonly staple: MacStaple | null;
}

/** A stapled ticket: valid, absent, rejected by stapler, or stapler couldn't run at all. */
export type MacStaple = "valid" | "missing" | "invalid" | "unavailable";

/** What the notarization checks (Gatekeeper and the staple) apply to; see `requireMacCodeSignature`. */
export interface MacNotarizationOptions {
  readonly notarization: boolean;
}

/** Fields of `codesign --display --verbose=2` (it writes them to stderr). */
export function parseCodesignDisplay(text: string): {
  identifier: string | null;
  teamId: string | null;
  hardenedRuntime: boolean;
  adhoc: boolean;
} {
  const field = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;
  const team = field("TeamIdentifier");
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1]?.split(",") ?? [];
  return {
    identifier: field("Identifier"),
    teamId: team && team !== "not set" ? team : null,
    hardenedRuntime: flags.includes("runtime"),
    adhoc: flags.includes("adhoc") || field("Signature") === "adhoc",
  };
}

/** `spctl --assess --verbose` output: the `source=` of an accepted assessment, else null. */
export function parseGatekeeper(status: number | null, text: string): string | null {
  if (status !== 0 || !/: accepted$/m.test(text)) return null;
  return /^source=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
}

/** `xcrun stapler validate`: 0 is a valid ticket; its own message tells a missing one apart. */
export function parseStaple(status: number | null, text: string): MacStaple {
  if (status === 0) return "valid";
  if (status === null) return "unavailable";
  return /does not have a ticket stapled to it/.test(text) ? "missing" : "invalid";
}

/**
 * Refuses anything but a sealed, hardened, notarized and stapled Developer ID build of Gram from
 * `teamId`. `notarization: false` skips only Gatekeeper and the staple, for the staged copy and the
 * install helper, which re-check bytes main already assessed; the requirement, identifier, team and
 * hardened runtime are always checked.
 */
export function requireMacCodeSignature(
  signature: MacCodeSignature,
  teamId: string,
  options: MacNotarizationOptions = { notarization: true },
): void {
  if (!validTeamId(teamId)) throw new Error("Signed update refused: no publisher Team ID");
  if (signature.requirement !== "satisfied")
    throw new Error(
      signature.requirement === "unsatisfied"
        ? "Signed update refused: the app is not Gram signed by its Developer ID team"
        : "Signed update refused: the app's code signature is invalid or incomplete",
    );
  if (signature.identifier !== SIGNED_MAC_BUNDLE_ID || signature.teamId !== teamId)
    throw new Error("Signed update refused: unexpected bundle identifier or Team ID");
  if (!signature.hardenedRuntime)
    throw new Error("Signed update refused: the app lacks the hardened runtime");
  if (!options.notarization) return;
  if (signature.gatekeeper !== "Notarized Developer ID")
    throw new Error("Signed update refused: Gatekeeper does not accept it as notarized");
  if (signature.staple !== "valid")
    throw new Error(
      signature.staple === "missing"
        ? "Signed update refused: no notarization ticket is stapled to the app"
        : signature.staple === "invalid"
          ? "Signed update refused: the app's stapled notarization ticket is invalid"
          : "Signed update refused: the stapled notarization ticket could not be checked",
    );
}

type Run = (
  file: string,
  args: readonly string[],
) => Promise<{ status: number | null; out: string }>;
const runTool: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: 120_000, maxBuffer: 1024 ** 2, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
      (error, stdout, stderr) =>
        resolve({
          status: error ? (typeof error.code === "number" ? error.code : null) : 0,
          out: `${stdout}\n${stderr}`,
        }),
    );
  });

/**
 * Asks macOS itself about `bundle`: the strict deep seal against Gram's requirement for `teamId`,
 * the signing fields, and (unless skipped) Gatekeeper's assessment and the stapled ticket.
 * Absolute Apple tools only.
 */
export async function probeMacCodeSignature(
  bundle: string,
  teamId: string,
  options: MacNotarizationOptions = { notarization: true },
  run: Run = runTool,
): Promise<MacCodeSignature> {
  const requirement = await run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "-R",
    `=${macDesignatedRequirement(teamId)}`,
    bundle,
  ]);
  const display = parseCodesignDisplay(
    (await run("/usr/bin/codesign", ["--display", "--verbose=2", bundle])).out,
  );
  const assessment = options.notarization
    ? await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", bundle])
    : undefined;
  const staple = options.notarization
    ? await run("/usr/bin/xcrun", ["stapler", "validate", bundle])
    : undefined;
  return {
    requirement:
      requirement.status === 0 ? "satisfied" : requirement.status === 3 ? "unsatisfied" : "invalid",
    identifier: display.identifier,
    teamId: display.teamId,
    hardenedRuntime: display.hardenedRuntime,
    gatekeeper: assessment ? parseGatekeeper(assessment.status, assessment.out) : null,
    staple: staple ? parseStaple(staple.status, staple.out) : null,
  };
}

/** Probes and enforces in one step: what the updater runs before staging and before replacing. */
export async function verifyMacCodeSignature(
  bundle: string,
  teamId: string,
  options: MacNotarizationOptions = { notarization: true },
  probe: typeof probeMacCodeSignature = probeMacCodeSignature,
): Promise<void> {
  if (!validTeamId(teamId)) throw new Error("Signed update refused: no publisher Team ID");
  requireMacCodeSignature(await probe(bundle, teamId, options), teamId, options);
}

/**
 * The Team ID an installed bundle's signature names: null when macOS reports it unsigned or ad hoc
 * (no team), undefined when `codesign` can't say. Only the publisher's own team enables updates.
 */
export async function macBundleTeam(
  bundle: string,
  run: Run = runTool,
): Promise<string | null | undefined> {
  const shown = await run("/usr/bin/codesign", ["--display", "--verbose=2", bundle]);
  if (shown.status === 0) return parseCodesignDisplay(shown.out).teamId;
  return /code object is not signed at all/.test(shown.out) ? null : undefined;
}
