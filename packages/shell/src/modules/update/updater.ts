import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

import type {
  UpdateChannel,
  UpdateCheck,
  UpdateInstallIntent,
  UpdateProgress,
} from "@gram/contracts";

import {
  installerAssetName,
  SWEEP_MIN_AGE_MS,
  UPDATE_DIR_PREFIX,
  UPDATE_MIN_FREE_BYTES,
} from "./config.ts";
import {
  eligibleReleases,
  releaseList,
  selectRelease,
  validTag,
  type EligibleRelease,
} from "./releases.ts";
import { compareVersions, formatVersion, parseVersion, type Version } from "./semver.ts";
import { evaluateInstallerIdentity, evaluateSignature } from "./signature.ts";
import { ghReleaseSource, type ReleaseSource } from "./source.ts";
import { sweepStaleUpdateDirs } from "./sweep.ts";

export interface ProcessResult {
  /** Exit code; null when the process couldn't start, was killed or timed out. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunGh = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxDownloadBytes?: number;
    readonly downloadFile?: string;
  },
) => Promise<ProcessResult>;

export interface UpdaterOptions {
  /** The GitHub CLI releases are read and downloaded through; none, and nothing is checked. */
  readonly gh?: RunGh | undefined;
  /** `owner/repo` `gh` reads releases from; `null` while there's none, so nothing is checked. */
  readonly repo?: string | null | undefined;
  /** This build's full version, including any `-rc.N` suffix. */
  readonly currentVersion: string;
  readonly platform: NodeJS.Platform;
  /** An existing dir for `gh` to run in and for the per-download installer dirs. */
  readonly tempDir: string;
  /** Runs the Authenticode probe (`authenticodeScript`) against an installer. */
  readonly probeSignature: (installer: string) => Promise<ProcessResult>;
  readonly warn: (message: string) => void;
  readonly now?: () => number;
  /**
   * The bytes free to this user on `dir`'s disk, or undefined when that can't be read; `statfs` by
   * default. A download starts only with `UPDATE_MIN_FREE_BYTES` free.
   */
  readonly freeBytes?: ((dir: string) => Promise<number | undefined>) | undefined;
  /** The signer certificate fingerprint an installer must carry; defaults to EXAMPLE's pin. */
  readonly expectedSignerSha256?: string;
  /** The product name an installer's version resource must carry; defaults to Gram's. */
  readonly expectedProductName?: string;
  /**
   * The channel and pin as last saved, read again before every install: the server mirrors them
   * into `prefs.json` (see `readUpdatePrefs`).
   */
  readonly readPrefs: () => Promise<{
    readonly channel: UpdateChannel;
    readonly pinnedVersion?: string | undefined;
  }>;
}

export interface Updater {
  /**
   * Checks GitHub for a newer release on `channel`. Resolves (never rejects) with one of three
   * shapes: available, up to date, or `unavailable` when `gh` is missing, logged out or failed, or
   * with `noReleaseChannel` too when no releases repo is configured.
   * `releases` is present even with nothing newer, since that's when a downgrade is wanted.
   */
  check(channel: UpdateChannel): Promise<UpdateCheck>;
  /**
   * Installs only what `intent` asks for and the saved settings allow: the saved channel is the
   * intent's, the tag is a published release of it, an older one only with `downgrade`, and one
   * that isn't the channel's newest only once it's the saved pin. Then downloads the tag's one
   * installer into a fresh temp dir and verifies its Authenticode signature against the pin and its
   * product and version against the tag. Resolves with the installer path; on failure the dir is
   * removed and the promise rejects. Windows only.
   */
  downloadAndVerify(
    intent: UpdateInstallIntent,
    onProgress: (progress: UpdateProgress) => void,
  ): Promise<string>;
  readonly canSelfInstall: boolean;
}

const CHANNEL_LABEL: Record<UpdateChannel, string> = {
  stable: "Stable",
  prerelease: "Pre-release",
};

/** The bytes free to this user on `dir`'s disk, from `statfs`; undefined when it can't say. */
export async function statfsFreeBytes(dir: string): Promise<number | undefined> {
  try {
    const stats = await statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

const sizeText = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.floor(bytes / 1024 ** 2)} MB`;

/**
 * The updater of an install that has none: every check is `unavailable` with `message`, and
 * nothing is downloaded, installed or asked of `gh`. Unsigned macOS builds get this one.
 */
export function unavailableUpdater(currentVersion: string, message: string): Updater {
  return {
    canSelfInstall: false,
    check: async (channel) => ({
      available: false,
      unavailable: true,
      unavailableMessage: message,
      currentVersion,
      canSelfInstall: false,
      channel,
    }),
    downloadAndVerify: async () => {
      throw new Error(message);
    },
  };
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { currentVersion, tempDir, warn } = options;
  const now = options.now ?? Date.now;
  const canSelfInstall = options.platform === "win32";
  const freeBytes = options.freeBytes ?? statfsFreeBytes;
  const source: ReleaseSource | null =
    options.gh === undefined || options.repo === null || options.repo === undefined
      ? null
      : ghReleaseSource({ gh: options.gh, repo: options.repo, tempDir, warn, now });

  const unavailable = (): UpdateCheck => ({
    available: false,
    unavailable: true,
    currentVersion,
    canSelfInstall,
  });

  async function installable(
    releases: ReleaseSource,
    channel: UpdateChannel,
    current: Version,
  ): Promise<EligibleRelease[] | undefined> {
    const parsed = await releases.list();
    if (parsed === undefined) return undefined;

    const eligible = eligibleReleases(parsed, channel === "prerelease");
    if (!canSelfInstall) return eligible;
    const newer = eligible.filter((release) => compareVersions(release.version, current) > 0);
    const views = await Promise.all(newer.map((release) => releases.view(release.tag)));
    if (views.includes(undefined)) return undefined;
    const waiting = new Set(
      newer.filter(
        (release, index) =>
          !views[index]!.assets.includes(installerAssetName(formatVersion(release.version))),
      ),
    );
    return eligible.filter((release) => !waiting.has(release));
  }

  async function check(channel: UpdateChannel): Promise<UpdateCheck> {
    if (source === null) return { ...unavailable(), noReleaseChannel: true };
    if (!(await source.ready())) return unavailable();
    const current = parseVersion(currentVersion);
    if (!current) {
      warn(`update check: unparseable current version ${currentVersion}`);
      return unavailable();
    }
    const eligible = await installable(source, channel, current);
    if (!eligible) return unavailable();
    const releases = releaseList(eligible, current);
    const latest = selectRelease(eligible, current);
    if (!latest) return { available: false, currentVersion, canSelfInstall, channel, releases };
    return {
      available: true,
      currentVersion,
      canSelfInstall,
      channel,
      latestVersion: formatVersion(latest.version),
      tag: latest.tag,
      htmlUrl: canSelfInstall ? "" : await source.pageUrl(latest.tag),
      releases,
    };
  }

  async function permitted(
    releases: ReleaseSource,
    intent: UpdateInstallIntent,
  ): Promise<EligibleRelease> {
    const current = parseVersion(currentVersion);
    if (!current) throw new Error(`unparseable current version ${currentVersion}`);
    const prefs = await options.readPrefs();
    if (prefs.channel !== intent.channel) {
      throw new Error(
        `the saved release channel is ${CHANNEL_LABEL[prefs.channel]}, not ` +
          `${CHANNEL_LABEL[intent.channel]}: check for updates again`,
      );
    }
    const eligible = await installable(releases, intent.channel, current);
    if (!eligible) throw new Error("couldn't list the releases to check this one against");
    const release = eligible.find((candidate) => candidate.tag === intent.tag);
    if (!release) {
      throw new Error(
        `${intent.tag} isn't a published ${CHANNEL_LABEL[intent.channel]} release with a ` +
          "Windows installer",
      );
    }
    const version = formatVersion(release.version);
    const cmp = compareVersions(release.version, current);
    if (cmp === 0) throw new Error(`${version} is already installed`);
    if (cmp < 0 && !intent.downgrade) {
      throw new Error(`${version} is older than ${currentVersion}: install it as a downgrade`);
    }
    if (cmp > 0 && intent.downgrade) {
      throw new Error(`${version} is newer than ${currentVersion}, not a downgrade`);
    }
    if (release !== eligible[0] && prefs.pinnedVersion !== version) {
      throw new Error(
        `${version} isn't the newest release and isn't pinned: check for updates again`,
      );
    }
    return release;
  }

  async function downloadInto(
    releases: ReleaseSource,
    dir: string,
    release: EligibleRelease,
    onProgress: (progress: UpdateProgress) => void,
  ): Promise<string> {
    const { tag } = release;
    const version = formatVersion(release.version);
    const asset = installerAssetName(version);
    const view = await releases.view(tag);
    if (!view) throw new Error(`couldn't read release ${tag}`);
    if (view.tagName !== tag || view.isDraft !== false) {
      throw new Error(`${tag} is not a published release`);
    }
    if (!view.assets.includes(asset)) throw new Error(`release ${tag} has no ${asset}`);

    onProgress({ stage: "downloading", tag });
    await releases.download(tag, asset, dir);

    const downloaded = await readdir(dir);
    if (downloaded.length !== 1 || downloaded[0] !== asset) {
      throw new Error(`expected only ${asset} from the release, got ${JSON.stringify(downloaded)}`);
    }
    const installer = join(dir, asset);

    onProgress({ stage: "verifying", tag });
    const probe = await options.probeSignature(installer);
    const signature = evaluateSignature(probe.stdout, options.expectedSignerSha256);
    const verdict = signature.ok
      ? evaluateInstallerIdentity(probe.stdout, version, options.expectedProductName)
      : signature;
    if (!verdict.ok) {
      warn(
        `update: signature probe refused (exit=${probe.status}) stdout=${JSON.stringify(probe.stdout.slice(0, 400))} stderr=${JSON.stringify(probe.stderr.slice(0, 400))}`,
      );
      throw new Error(verdict.error);
    }
    return installer;
  }

  async function downloadAndVerify(
    intent: UpdateInstallIntent,
    onProgress: (progress: UpdateProgress) => void,
  ): Promise<string> {
    if (!canSelfInstall) throw new Error("in-app update is currently Windows-only");
    if (source === null) throw new Error("Gram doesn't publish releases yet");
    if (!validTag(intent.tag)) throw new Error(`not a release tag: ${JSON.stringify(intent.tag)}`);
    if (!(await source.ready())) throw new Error(source.notReadyMessage);
    const release = await permitted(source, intent);
    await sweepStaleUpdateDirs(tempDir, SWEEP_MIN_AGE_MS, now());
    const free = await freeBytes(tempDir);
    if (free !== undefined && free < UPDATE_MIN_FREE_BYTES) {
      throw new Error(
        `There isn't enough free disk space to update: ${sizeText(free)} free on the disk holding ` +
          `${tempDir}, and an update needs ${sizeText(UPDATE_MIN_FREE_BYTES)}. Free some space and ` +
          "try again.",
      );
    }
    const dir = join(tempDir, `${UPDATE_DIR_PREFIX}${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    try {
      return await downloadInto(source, dir, release, onProgress);
    } catch (error) {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      throw error;
    }
  }

  return { check, downloadAndVerify, canSelfInstall };
}
