// The public feed against a synthetic public GitHub on loopback: its API's release list and asset
// endpoints, with the asset redirect GitHub answers, and the release download URLs. Nothing here
// reaches the network or reads a credential.
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import type { UpdateChannel } from "@gram/contracts";
import {
  nativeManifestName,
  nativeZipName,
  renderNativeManifest,
} from "@gram/shell/modules/update";
import { createClient } from "electron-updater/out/providerFactory";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPublicFeed,
  feedOptions,
  GramReleaseProvider,
  type AnonymousFetch,
} from "./native-feed.ts";

const REPO = "example/gram";

interface FakeRelease {
  readonly raw: Record<string, unknown>;
  readonly zip: Buffer;
  readonly manifest: string;
  readonly sha512: string;
}

let nextId = 1;

/** A complete signed release as GitHub's API lists it, with its ZIP and manifest. */
function releaseOf(version: string, options: { prerelease?: boolean } = {}): FakeRelease {
  const zip = Buffer.from(`PK\u0003\u0004 Gram ${version}, as far as this test knows`);
  const sha512 = createHash("sha512").update(zip).digest("base64");
  const manifest = renderNativeManifest({
    version,
    zip: nativeZipName(version),
    sha512,
    size: zip.length,
    releaseDate: "2026-10-16T10:00:00.000Z",
  });
  const asset = (name: string, bytes: Buffer | string) => ({
    id: nextId++,
    name,
    size: Buffer.byteLength(bytes),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    state: "uploaded",
  });
  return {
    raw: {
      id: nextId++,
      tag_name: `v${version}`,
      draft: false,
      prerelease: options.prerelease ?? version.includes("-"),
      body: `Notes for ${version}`,
      published_at: "2026-10-16T10:00:00Z",
      assets: [asset(nativeZipName(version), zip), asset(nativeManifestName(version), manifest)],
    },
    zip,
    manifest,
    sha512,
  };
}

interface FakeGitHub {
  readonly origin: string;
  /** Every request's path and headers, to show what the feed asked and that it sent no credential. */
  readonly requests: { readonly path: string; readonly headers: IncomingHttpHeaders }[];
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/**
 * A synthetic public GitHub serving `releases` newest first, as the API lists them. `listStatus`
 * answers the release list with an error instead.
 */
async function fakeGitHub(
  releases: readonly FakeRelease[],
  options: { listStatus?: number } = {},
): Promise<FakeGitHub> {
  const requests: FakeGitHub["requests"] = [];
  const assets = new Map<number, { tag: string; name: string; bytes: Buffer | string }>();
  for (const release of releases) {
    for (const asset of release.raw["assets"] as { id: number; name: string }[]) {
      assets.set(asset.id, {
        tag: release.raw["tag_name"] as string,
        name: asset.name,
        bytes: asset.name.endsWith(".zip") ? release.zip : release.manifest,
      });
    }
  }
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    requests.push({ path, headers: req.headers });
    const send = (status: number, body: Buffer | string = "", headers = {}) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    if (path === `/repos/${REPO}/releases?per_page=30`) {
      if (options.listStatus) return send(options.listStatus, '{"message":"API rate limit"}');
      return send(200, JSON.stringify(releases.map((release) => release.raw)), {
        "Content-Type": "application/json",
      });
    }
    const assetId = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(path)?.[1];
    if (assetId && req.headers.accept === "application/octet-stream") {
      // GitHub redirects an asset's bytes to its CDN.
      return send(302, "", { Location: `/cdn/${assetId}` });
    }
    const cdn = /^\/cdn\/(\d+)$/.exec(path)?.[1];
    if (cdn && assets.has(Number(cdn))) return send(200, assets.get(Number(cdn))!.bytes);
    const download = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(path);
    if (download?.[1] === REPO) {
      const tag = decodeURIComponent(download[2]!);
      const name = decodeURIComponent(download[3]!);
      const found = [...assets.values()].find((a) => a.tag === tag && a.name === name);
      if (found) return send(200, found.bytes);
    }
    send(404, '{"message":"Not Found"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, requests };
}

/** The production fetch's contract over Node's own: no credentials, the caps and redirect rule. */
const anonymousFetch: AnonymousFetch = async (url, { accept, maxBytes, redirect }) => {
  const response = await fetch(url, { headers: { Accept: accept }, credentials: "omit", redirect });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new Error(`GitHub's answer for ${url} is too large.`);
  return { status: response.status, body: body.toString("utf8") };
};

const runtime = {
  isUseMultipleRangeRequest: true,
  platform: "darwin",
  executor: {} as never,
} as const;

/** electron-updater's provider for the public feed on `channel`, over the synthetic GitHub. */
function providerFor(github: FakeGitHub, channel: UpdateChannel, currentVersion: string) {
  const feed = createPublicFeed({
    fetch: anonymousFetch,
    repo: REPO,
    currentVersion,
    api: github.origin,
    web: github.origin,
  });
  return { feed, provider: createClient(feedOptions(feed, channel), {} as never, runtime) };
}

/** What a check on `channel` offers: the update's version and its ZIP's bytes, or the running one. */
async function offer(github: FakeGitHub, channel: UpdateChannel, currentVersion: string) {
  const { provider } = providerFor(github, channel, currentVersion);
  expect(provider).toBeInstanceOf(GramReleaseProvider);
  const info = await provider.getLatestVersion();
  if (info.version === currentVersion) return { version: info.version };
  const [file] = provider.resolveFiles(info);
  const zip = Buffer.from(await (await fetch(file!.url)).arrayBuffer());
  // electron-updater checks the download against the manifest's SHA-512.
  expect(createHash("sha512").update(zip).digest("base64")).toBe(file!.info.sha512);
  return { version: info.version, url: file!.url.pathname, notes: info.releaseNotes };
}

describe("public feed against a synthetic public GitHub", () => {
  it("offers a stable-only repo's newest release on both channels", async () => {
    const github = await fakeGitHub([releaseOf("0.4.1"), releaseOf("0.4.0")]);
    for (const channel of ["stable", "prerelease"] as const) {
      expect(await offer(github, channel, "0.4.0")).toEqual({
        version: "0.4.1",
        url: `/${REPO}/releases/download/v0.4.1/${nativeZipName("0.4.1")}`,
        notes: "Notes for 0.4.1",
      });
    }
    expect(await offer(github, "prerelease", "0.4.1")).toEqual({ version: "0.4.1" });
  });

  it("offers Pre-release a newer stable over an older RC, and Stable never an RC", async () => {
    const github = await fakeGitHub([
      releaseOf("0.5.0"),
      releaseOf("0.5.0-rc.2"),
      releaseOf("0.4.0"),
    ]);
    expect((await offer(github, "prerelease", "0.5.0-rc.2")).version).toBe("0.5.0");
    expect((await offer(github, "prerelease", "0.4.0")).version).toBe("0.5.0");
    expect((await offer(github, "stable", "0.4.0")).version).toBe("0.5.0");

    const newerRc = await fakeGitHub([
      releaseOf("0.5.1-rc.1"),
      releaseOf("0.5.0"),
      releaseOf("0.4.0"),
    ]);
    expect((await offer(newerRc, "prerelease", "0.5.0")).version).toBe("0.5.1-rc.1");
    expect(await offer(newerRc, "stable", "0.5.0")).toEqual({ version: "0.5.0" });
    expect((await offer(newerRc, "stable", "0.4.0")).version).toBe("0.5.0");
  });

  it("reports up to date, not an error, when the repo has no releases", async () => {
    const github = await fakeGitHub([]);
    for (const channel of ["stable", "prerelease"] as const) {
      const { provider } = providerFor(github, channel, "0.4.0");
      expect(await provider.getLatestVersion()).toEqual({
        version: "0.4.0",
        files: [],
        path: "",
        sha512: "",
        releaseDate: "",
      });
    }
  });

  it("reads GitHub anonymously: the release list, then the manifest by asset id", async () => {
    const release = releaseOf("0.4.1");
    const github = await fakeGitHub([release]);
    await offer(github, "stable", "0.4.0");
    const manifestId = (release.raw["assets"] as { id: number }[])[1]!.id;
    expect(github.requests.map((request) => request.path)).toEqual([
      `/repos/${REPO}/releases?per_page=30`,
      `/repos/${REPO}/releases/assets/${manifestId}`,
      `/cdn/${manifestId}`,
      `/${REPO}/releases/download/v0.4.1/${nativeZipName("0.4.1")}`,
    ]);
    for (const { headers } of github.requests) {
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    }
  });

  it("says when GitHub limits anonymous checks, and refuses a manifest for another ZIP", async () => {
    const limited = await fakeGitHub([], { listStatus: 403 });
    await expect(
      providerFor(limited, "stable", "0.4.0").provider.getLatestVersion(),
    ).rejects.toThrow(
      "GitHub is limiting anonymous update checks from this network. Try again later.",
    );

    const release = releaseOf("0.4.1");
    const forged = { ...release, manifest: releaseOf("0.4.2").manifest };
    const github = await fakeGitHub([forged]);
    await expect(
      providerFor(github, "stable", "0.4.0").provider.getLatestVersion(),
    ).rejects.toThrow(/manifest/);
  });

  it("resolves only the ZIP of the release it picked", async () => {
    const github = await fakeGitHub([releaseOf("0.4.1")]);
    const { feed, provider } = providerFor(github, "stable", "0.4.0");
    expect(() => feed.assetUrl({ id: 1, name: "x.zip", size: 1, digest: "" })).toThrow();
    const info = await provider.getLatestVersion();
    expect(() => provider.resolveFiles({ ...info, version: "0.4.2" })).toThrow();
    expect(() => feed.assetUrl({ ...feed.picked()!.zip, id: 999_999 })).toThrow();
    expect(feed.picked()?.zip.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
