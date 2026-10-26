// The electron-updater manifest a signed release carries, and how the private feed picks the
// release it points at. `bun run release:rc` renders the manifest with `renderNativeManifest`; the
// app checks what it reads with `validateNativeManifest`, so the two can't drift apart.
import type { UpdateChannel } from "@gram/contracts";

import { macArtifactName } from "./mac-artifacts.ts";
import { eligibleReleases } from "./releases.ts";
import { compareVersions, formatVersion, parseVersion } from "./semver.ts";

/**
 * electron-updater's channel file for `version`: `rc-mac.yml` for an RC, `latest-mac.yml` for a
 * stable release, as its GitHub provider names them (`<channel>-mac.yml`).
 */
export function nativeManifestName(version: string): "rc-mac.yml" | "latest-mac.yml" {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`Not a version: ${version}`);
  return parsed.pre.length > 0 ? "rc-mac.yml" : "latest-mac.yml";
}

/** electron-updater's channel name for a release channel's manifests. */
export const nativeChannelName = (channel: UpdateChannel): "rc" | "latest" =>
  channel === "prerelease" ? "rc" : "latest";

/** The Squirrel.Mac payload: the Developer ID signed ZIP every signed release already carries. */
export const nativeZipName = (version: string): string =>
  macArtifactName(version, "signed-native-macos-v1");

/** The biggest manifest the feed reads; ours are a few hundred bytes. */
export const NATIVE_MANIFEST_MAX_BYTES = 64 * 1024;
/** The biggest ZIP the feed serves, as the private updater bounds it. */
export const NATIVE_ZIP_MAX_BYTES = 600 * 1024 ** 2;

export interface NativeManifestInput {
  readonly version: string;
  /** The ZIP's asset name, beside the manifest in the same release. */
  readonly zip: string;
  /** The ZIP's SHA-512, base64, as electron-updater checks it. */
  readonly sha512: string;
  readonly size: number;
  /** ISO time of the build. */
  readonly releaseDate: string;
}

const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function checkInput(input: NativeManifestInput): void {
  if (
    !parseVersion(input.version) ||
    input.zip !== nativeZipName(input.version) ||
    !SHA512_BASE64.test(input.sha512) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > NATIVE_ZIP_MAX_BYTES ||
    !ISO_TIME.test(input.releaseDate)
  )
    throw new Error("Invalid electron-updater manifest fields");
}

/**
 * The manifest's YAML, in electron-builder's shape: one ZIP in `files`, repeated in the top-level
 * `path`/`sha512` fields older electron-updater readers use. Every value is a plain scalar or
 * single-quoted, so the YAML can't be read two ways.
 */
export function renderNativeManifest(input: NativeManifestInput): string {
  checkInput(input);
  return [
    `version: ${input.version}`,
    "files:",
    `  - url: ${input.zip}`,
    `    sha512: ${input.sha512}`,
    `    size: ${input.size}`,
    `path: ${input.zip}`,
    `sha512: ${input.sha512}`,
    `releaseDate: '${input.releaseDate}'`,
    "",
  ].join("\n");
}

const fail = (): never => {
  throw new Error("The release's update manifest doesn't match its signed ZIP");
};

export interface NativeManifest {
  readonly version: string;
  readonly files: readonly [
    { readonly url: string; readonly sha512: string; readonly size: number },
  ];
  readonly path: string;
  readonly sha512: string;
  readonly releaseDate: string;
}

/**
 * The parsed manifest when it's exactly one this feed would publish for `expected`: its version,
 * the release's signed ZIP by name and GitHub's size for it, a SHA-512 and a release date, and
 * nothing else. Anything more or less throws: a manifest pointing elsewhere is never followed.
 */
export function validateNativeManifest(
  value: unknown,
  expected: { readonly version: string; readonly size: number },
): NativeManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (
    JSON.stringify(keys) !== JSON.stringify(["files", "path", "releaseDate", "sha512", "version"])
  )
    return fail();
  const { files, path, releaseDate, sha512, version } = record;
  if (!Array.isArray(files) || files.length !== 1) return fail();
  const file: unknown = files[0];
  if (typeof file !== "object" || file === null) return fail();
  const entry = file as Record<string, unknown>;
  if (JSON.stringify(Object.keys(entry).toSorted()) !== JSON.stringify(["sha512", "size", "url"]))
    return fail();
  const zip = nativeZipName(expected.version);
  // js-yaml reads an unquoted ISO time as a Date; ours is quoted, so it stays a string.
  if (
    version !== expected.version ||
    entry["url"] !== zip ||
    path !== zip ||
    typeof entry["sha512"] !== "string" ||
    !SHA512_BASE64.test(entry["sha512"]) ||
    sha512 !== entry["sha512"] ||
    entry["size"] !== expected.size ||
    typeof releaseDate !== "string" ||
    !ISO_TIME.test(releaseDate)
  )
    return fail();
  return {
    version: expected.version,
    files: [{ url: zip, sha512: entry["sha512"], size: expected.size }],
    path: zip,
    sha512: entry["sha512"],
    releaseDate,
  };
}

export interface NativeAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  /** GitHub's `sha256:<hex>` digest of the asset. */
  readonly digest: string;
}

export interface NativeRelease {
  readonly tag: string;
  readonly version: string;
  readonly zip: NativeAsset;
  readonly manifest: NativeAsset;
  readonly notes: string | null;
  readonly publishedAt: string | null;
}

function asset(raw: unknown, name: string, maxBytes: number): NativeAsset | undefined {
  const assets = (raw as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets)) return undefined;
  const matches = assets.filter(
    (candidate: unknown) => (candidate as { name?: unknown } | null)?.name === name,
  ) as Record<string, unknown>[];
  const found = matches[0];
  if (matches.length !== 1 || !found) return undefined;
  const { id, size, digest, state } = found;
  if (
    !Number.isSafeInteger(id) ||
    (id as number) < 1 ||
    !Number.isSafeInteger(size) ||
    (size as number) < 1 ||
    (size as number) > maxBytes ||
    typeof digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    (state !== undefined && state !== "uploaded")
  )
    return undefined;
  return { id: id as number, name, size: size as number, digest };
}

/**
 * The newest release of `channel` newer than `currentVersion` that carries both a signed ZIP and
 * its manifest, from `gh api …/releases` output, or undefined when none does. Drafts, other
 * channels' tags and releases still missing an asset (one being uploaded, an unsigned one, or one
 * from before signed updates) are passed over, so an older complete release can still be found.
 */
export function pickNativeRelease(
  releases: readonly unknown[],
  channel: UpdateChannel,
  currentVersion: string,
): NativeRelease | undefined {
  const current = parseVersion(currentVersion);
  if (!current) return undefined;
  const byTag = new Map<string, unknown>();
  for (const raw of releases) {
    const tag = (raw as { tag_name?: unknown } | null)?.tag_name;
    if (typeof tag === "string" && !byTag.has(tag)) byTag.set(tag, raw);
  }
  const eligible = eligibleReleases(
    releases.map((raw) => {
      const r = raw as { tag_name?: unknown; draft?: unknown } | null;
      return { tagName: r?.tag_name, isDraft: r?.draft };
    }),
    channel === "prerelease",
  );
  for (const candidate of eligible) {
    if (compareVersions(candidate.version, current) <= 0) break;
    const raw = byTag.get(candidate.tag);
    const version = formatVersion(candidate.version);
    const r = raw as { prerelease?: unknown; body?: unknown; published_at?: unknown } | null;
    // GitHub's flag must agree with the tag, as the private updater requires.
    if (r?.prerelease !== candidate.prerelease) continue;
    const zip = asset(raw, nativeZipName(version), NATIVE_ZIP_MAX_BYTES);
    const manifest = asset(raw, nativeManifestName(version), NATIVE_MANIFEST_MAX_BYTES);
    if (!zip || !manifest) continue;
    return {
      tag: candidate.tag,
      version,
      zip,
      manifest,
      notes: typeof r.body === "string" && r.body.trim() ? r.body.trim().slice(0, 8_000) : null,
      publishedAt: typeof r.published_at === "string" ? r.published_at : null,
    };
  }
  return undefined;
}
