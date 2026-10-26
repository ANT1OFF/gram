// Where a signed install's Electron updater reads releases: `ANT1OFF/gram`'s public releases,
// read anonymously through one custom electron-updater provider that picks the release with
// `pickNativeRelease`, so Stable and Pre-release follow Gram's own rules. (Electron's standard
// GitHub provider follows only one channel's tags: on Pre-release it never offered a newer stable
// release, and with no RC published it failed.) electron-updater downloads the ZIP from GitHub's
// release download URL and checks its SHA-512.
//
// The `gh` feed reads the same list through the user's own `gh` login, which also sees drafts. The
// release tool's update check (`tools/release-stable/update-check.mjs`) uses it on a draft before
// publication; the app never does.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type { UpdateChannel } from "@gram/contracts";
import {
  NATIVE_MANIFEST_MAX_BYTES,
  pickNativeRelease,
  sourceFailure,
  validateNativeManifest,
  type NativeAsset,
  type NativeRelease,
  type RunGh,
} from "@gram/shell/modules/update";
import {
  Provider,
  type AppUpdater,
  type ResolvedUpdateFileInfo,
  type UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { parseUpdateInfo } from "electron-updater/out/providers/Provider";

/** What electron-updater's provider reads: the release a check picks, and where its ZIP is. */
export interface ReleaseFeed {
  /** The release a check would offer on `channel`, as electron-updater's update info. */
  latest(channel: UpdateChannel): Promise<UpdateInfo>;
  /** The URL electron-updater downloads `asset` of the picked release from. */
  assetUrl(asset: NativeAsset): URL;
  /** The release the last `latest` picked, if any. */
  picked(): NativeRelease | undefined;
}

/**
 * The update info for the release `pickNativeRelease` finds in `list`, with its manifest read by
 * `readManifest` and checked against the release's ZIP; the running version when nothing newer is
 * complete, which electron-updater then reports as current.
 */
async function pickUpdate(
  list: unknown,
  channel: UpdateChannel,
  currentVersion: string,
  repo: string,
  readManifest: (asset: NativeAsset) => Promise<string>,
): Promise<{ readonly info: UpdateInfo; readonly picked?: NativeRelease }> {
  if (!Array.isArray(list)) throw new Error("GitHub returned an invalid release list.");
  const picked = pickNativeRelease(list, channel, currentVersion);
  if (!picked)
    return {
      info: { version: currentVersion, files: [], path: "", sha512: "", releaseDate: "" },
    };
  const text = await readManifest(picked.manifest);
  if (Buffer.byteLength(text) > NATIVE_MANIFEST_MAX_BYTES || text.length === 0)
    throw new Error(`${picked.manifest.name} of ${picked.tag} is not a manifest.`);
  const manifest = validateNativeManifest(
    parseUpdateInfo(text, picked.manifest.name, new URL(`https://github.com/${repo}`)),
    { version: picked.version, size: picked.zip.size },
  );
  return {
    info: {
      ...manifest,
      files: [...manifest.files],
      releaseName: picked.tag,
      releaseNotes: picked.notes,
    },
    picked,
  };
}

const parseList = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("GitHub returned an invalid release list.", { cause: error });
  }
};

/**
 * The `gh` feed: the release list and manifest through the user's own `gh` login. It reads and
 * never downloads.
 */
export function createGhFeed(options: {
  readonly gh: RunGh;
  readonly repo: string;
  readonly tempDir: string;
  readonly currentVersion: string;
}): ReleaseFeed {
  const { gh, repo, tempDir } = options;
  let last: NativeRelease | undefined;

  const api = async (path: string, accept?: string): Promise<string> => {
    const out = await gh(
      [
        "api",
        "--hostname",
        "github.com",
        ...(accept ? ["-H", `Accept: ${accept}`] : []),
        `repos/${repo}/${path}`,
      ],
      { cwd: tempDir, timeoutMs: 15_000 },
    );
    if (out.status !== 0) throw sourceFailure(out.status, out.stderr, repo);
    return out.stdout;
  };

  return {
    async latest(channel) {
      last = undefined;
      const { picked, info } = await pickUpdate(
        parseList(await api("releases?per_page=30")),
        channel,
        options.currentVersion,
        repo,
        (manifest) => api(`releases/assets/${manifest.id}`, "application/octet-stream"),
      );
      last = picked;
      return info;
    },

    assetUrl() {
      throw new Error("The gh feed only reads releases.");
    },

    picked: () => last,
  };
}

/** The SHA-256 of `file`, hex, streamed. */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/**
 * Checks a finished download against GitHub's own digest for the asset, beside electron-updater's
 * SHA-512 from the manifest: both must describe the bytes about to be installed.
 */
export async function verifyAgainstGitHub(file: string, asset: NativeAsset): Promise<void> {
  const digest = await sha256File(file);
  if (`sha256:${digest}` !== asset.digest)
    throw new Error(`The downloaded ${asset.name} doesn't match GitHub's SHA-256 for it.`);
}

export interface GramFeedOptions {
  readonly provider: "custom";
  readonly updateProvider: typeof GramReleaseProvider;
  readonly feed: ReleaseFeed;
  readonly channel: UpdateChannel;
}

/** electron-updater's view of a feed. */
export class GramReleaseProvider extends Provider<UpdateInfo> {
  private readonly gram: GramFeedOptions;
  constructor(
    options: GramFeedOptions,
    _updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super({ ...runtimeOptions, isUseMultipleRangeRequest: false });
    this.gram = options;
  }

  getLatestVersion(): Promise<UpdateInfo> {
    return this.gram.feed.latest(this.gram.channel);
  }

  resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    const release = this.gram.feed.picked();
    const file = updateInfo.files[0];
    if (
      !release ||
      !file ||
      release.version !== updateInfo.version ||
      file.url !== release.zip.name
    )
      throw new Error("The update no longer matches the release it was checked against.");
    return [{ url: this.gram.feed.assetUrl(release.zip), info: file }];
  }
}

/** electron-updater's options for `feed` on `channel`: Gram's provider. */
export const feedOptions = (feed: ReleaseFeed, channel: UpdateChannel): GramFeedOptions => ({
  provider: "custom",
  updateProvider: GramReleaseProvider,
  feed,
  channel,
});

/**
 * One anonymous HTTPS GET: no cookies, no credentials, no `gh`. Rejects when the body is longer
 * than `maxBytes`; `redirect: "follow"` is for asset downloads, which GitHub redirects to its CDN.
 */
export type AnonymousFetch = (
  url: string,
  options: {
    readonly accept: string;
    readonly maxBytes: number;
    readonly redirect: "error" | "follow";
  },
) => Promise<{ readonly status: number; readonly body: string }>;

/** The biggest release list the public feed reads: 30 releases with their notes and assets. */
const RELEASE_LIST_MAX_BYTES = 8 * 1024 ** 2;

/**
 * The public feed: the release list and manifest from GitHub's API without credentials, and the
 * ZIP from the release's download URL. `api` and `web` are GitHub's
 * origins; tests point them at a synthetic GitHub.
 */
export function createPublicFeed(options: {
  readonly fetch: AnonymousFetch;
  readonly repo: string;
  readonly currentVersion: string;
  readonly api?: string;
  readonly web?: string;
}): ReleaseFeed {
  const { repo } = options;
  const api = options.api ?? "https://api.github.com";
  const web = options.web ?? "https://github.com";
  let last: NativeRelease | undefined;

  const read = async (
    path: string,
    what: string,
    request: Parameters<AnonymousFetch>[1],
  ): Promise<string> => {
    const { status, body } = await options.fetch(`${api}/repos/${repo}/${path}`, request);
    if (status === 200) return body;
    throw new Error(
      status === 403 || status === 429
        ? "GitHub is limiting anonymous update checks from this network. Try again later."
        : status === 404
          ? `GitHub has no ${what} for ${repo}.`
          : `GitHub answered ${status} for ${what}.`,
    );
  };

  return {
    async latest(channel) {
      last = undefined;
      const { info, picked } = await pickUpdate(
        parseList(
          await read("releases?per_page=30", "release list", {
            accept: "application/vnd.github+json",
            maxBytes: RELEASE_LIST_MAX_BYTES,
            redirect: "error",
          }),
        ),
        channel,
        options.currentVersion,
        repo,
        (manifest) =>
          read(`releases/assets/${manifest.id}`, manifest.name, {
            accept: "application/octet-stream",
            maxBytes: NATIVE_MANIFEST_MAX_BYTES,
            redirect: "follow",
          }),
      );
      last = picked;
      return info;
    },

    assetUrl(asset) {
      if (!last || asset.id !== last.zip.id)
        throw new Error("The update no longer matches the release it was checked against.");
      return new URL(
        `${web}/${repo}/releases/download/${encodeURIComponent(last.tag)}/${encodeURIComponent(asset.name)}`,
      );
    },

    picked: () => last,
  };
}
