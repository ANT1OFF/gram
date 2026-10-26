// What a signed install checks of an update before Squirrel.Mac ever sees it: the exact ZIP
// electron-updater downloaded, unpacked with Gram's own bounded reader. Squirrel.Mac checks the
// signature against this app's designated requirement, but neither notarization nor the version
// the feed offered: those are checked here, as the private helper checks them.
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import type { UpdateChannel } from "@gram/contracts";
import {
  compareVersions,
  extractMacArchive,
  parseVersion,
  verifyBundleIdentity,
  verifyMacCodeSignature,
} from "@gram/shell/modules/update";

import type { CandidateSnapshot } from "./native-snapshot.ts";

export interface CandidateChecks {
  readonly extract: typeof extractMacArchive;
  /** Info.plist identity and versions, the arm64 executable and app.asar's packaged version. */
  readonly identity: typeof verifyBundleIdentity;
  /** The strict deep seal against Gram's requirement, the team, hardened runtime, Gatekeeper and the staple. */
  readonly signature: (bundle: string, teamId: string) => Promise<void>;
}

const LIVE: CandidateChecks = {
  extract: extractMacArchive,
  identity: verifyBundleIdentity,
  signature: (bundle, teamId) => verifyMacCodeSignature(bundle, teamId, { notarization: true }),
};

/** Whether `version` is one this install may move to on `channel`: strictly newer, RCs on Pre-release only. */
export function offerable(
  version: string,
  currentVersion: string,
  channel: UpdateChannel,
): boolean {
  const next = parseVersion(version);
  const current = parseVersion(currentVersion);
  return (
    next !== null &&
    current !== null &&
    compareVersions(next, current) > 0 &&
    (channel === "prerelease" || next.pre.length === 0)
  );
}

/**
 * Refuses `snapshot` unless it unpacks to a notarized, stapled, hardened Gram from `teamId` whose
 * bundle and packaged app both say `version`, and `version` is one this install may move to. The
 * checks run on the snapshot's private copy, which must still be the descriptor's file afterwards;
 * what Squirrel.Mac is later served is that descriptor, digest-checked as it streams.
 */
export async function verifyNativeCandidate(
  options: {
    readonly snapshot: Pick<CandidateSnapshot, "path" | "intact">;
    readonly version: string;
    readonly currentVersion: string;
    readonly channel: UpdateChannel;
    readonly teamId: string;
    readonly tempDir: string;
  },
  checks: CandidateChecks = LIVE,
): Promise<void> {
  if (!offerable(options.version, options.currentVersion, options.channel))
    throw new Error(`${options.version} isn't an update this install takes on its channel.`);
  const dir = await mkdtemp(join(options.tempDir, "gram-native-verify-"));
  try {
    const bundle = await checks.extract(options.snapshot.path, join(dir, "candidate"));
    if (basename(bundle) !== "Gram.app") throw new Error("The update doesn't hold Gram.app.");
    await checks.identity(bundle, options.version);
    await checks.signature(bundle, options.teamId);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (!(await options.snapshot.intact()))
    throw new Error("The downloaded update changed while it was being verified.");
}
