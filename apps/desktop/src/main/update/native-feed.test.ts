import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nativeZipName,
  renderNativeManifest,
  type ProcessResult,
  type RunGh,
} from "@gram/shell/modules/update";
import { describe, expect, it } from "vitest";

import {
  createGhFeed,
  feedOptions,
  GramReleaseProvider,
  verifyAgainstGitHub,
} from "./native-feed.ts";

const REPO = "ANT1OFF/gram";
const zipBytes = Buffer.from("PK\u0003\u0004 a signed Gram, as far as this test knows");
const sha512 = createHash("sha512").update(zipBytes).digest("base64");
const sha256 = createHash("sha256").update(zipBytes).digest("hex");
const manifest = renderNativeManifest({
  version: "0.1.0-rc.18",
  zip: nativeZipName("0.1.0-rc.18"),
  sha512,
  size: zipBytes.length,
  releaseDate: "2026-10-16T10:00:00.000Z",
});
const release = {
  id: 7,
  tag_name: "v0.1.0-rc.18",
  draft: false,
  prerelease: true,
  body: "What changed",
  published_at: "2026-10-16T10:00:00Z",
  assets: [
    {
      id: 101,
      name: nativeZipName("0.1.0-rc.18"),
      size: zipBytes.length,
      digest: `sha256:${sha256}`,
      state: "uploaded",
    },
    { id: 102, name: "rc-mac.yml", size: manifest.length, digest: `sha256:${"b".repeat(64)}` },
  ],
};

const ok = (stdout: string): ProcessResult => ({ status: 0, stdout, stderr: "" });

/**
 * A synthetic signed-in `gh`, answering only the calls the feed may make. Every call is recorded,
 * so the tests can show nothing else (no token export, no other repo) ran.
 */
function fakeGh(
  options: {
    releases?: unknown;
    manifestText?: string;
  } = {},
) {
  const calls: string[][] = [];
  const gh: RunGh = async (args) => {
    calls.push([...args]);
    const line = args.join(" ");
    if (line === `api --hostname github.com repos/${REPO}/releases?per_page=30`)
      return ok(JSON.stringify(options.releases ?? [release]));
    if (
      line ===
      `api --hostname github.com -H Accept: application/octet-stream repos/${REPO}/releases/assets/102`
    )
      return ok(options.manifestText ?? manifest);
    return { status: 1, stdout: "", stderr: `unexpected gh ${line}` };
  };
  return { gh, calls };
}

const feedWith = (gh: RunGh, repo = REPO) =>
  createGhFeed({ gh, repo, tempDir: tmpdir(), currentVersion: "0.1.0-rc.17" });

describe("gh feed", () => {
  it("reads the release list and manifest through gh", async () => {
    const { gh, calls } = fakeGh();
    const feed = feedWith(gh);
    const info = await feed.latest("prerelease");
    expect(info).toMatchObject({
      version: "0.1.0-rc.18",
      path: nativeZipName("0.1.0-rc.18"),
      sha512,
      files: [{ url: nativeZipName("0.1.0-rc.18"), sha512, size: zipBytes.length }],
      releaseName: "v0.1.0-rc.18",
      releaseNotes: "What changed",
    });
    expect(feed.picked()?.tag).toBe("v0.1.0-rc.18");
    // gh's own login, read by gh: nothing asks it for a token or reads another repository.
    expect(calls).toEqual([
      ["api", "--hostname", "github.com", `repos/${REPO}/releases?per_page=30`],
      [
        "api",
        "--hostname",
        "github.com",
        "-H",
        "Accept: application/octet-stream",
        `repos/${REPO}/releases/assets/102`,
      ],
    ]);
    expect(calls.flat().join(" ")).not.toMatch(/token|GH_TOKEN|GITHUB_TOKEN/);
  });

  it("answers with the running version when nothing newer is complete", async () => {
    const { gh } = fakeGh({ releases: [{ ...release, assets: release.assets.slice(0, 1) }] });
    const feed = feedWith(gh);
    expect(await feed.latest("prerelease")).toMatchObject({ version: "0.1.0-rc.17", files: [] });
    expect(feed.picked()).toBeUndefined();
  });

  it("names the repository it reads when gh can't access it", async () => {
    const other = feedWith(
      async () => ({ status: 1, stdout: "", stderr: "HTTP 404: Not Found" }),
      "example/gram",
    );
    await expect(other.latest("stable")).rejects.toThrow(
      "Your gh account cannot access example/gram or this release is no longer available.",
    );
  });

  it("refuses a manifest that doesn't describe the release's ZIP", async () => {
    const { gh } = fakeGh({
      manifestText: manifest.replace(`size: ${zipBytes.length}`, "size: 9"),
    });
    await expect(feedWith(gh).latest("prerelease")).rejects.toThrow(/doesn't match/);
    const notYaml = fakeGh({ manifestText: "{{{" });
    await expect(feedWith(notYaml.gh).latest("prerelease")).rejects.toThrow();
  });

  it("never downloads", async () => {
    const { gh } = fakeGh();
    const feed = feedWith(gh);
    await feed.latest("prerelease");
    expect(() => feed.assetUrl(feed.picked()!.zip)).toThrow(/only reads/);
  });
});

describe("GramReleaseProvider", () => {
  const runtime = {
    isUseMultipleRangeRequest: true,
    platform: "darwin",
    executor: {} as never,
  } as const;

  it("refuses to resolve an update that isn't the release it checked", async () => {
    const { gh } = fakeGh();
    const feed = feedWith(gh);
    const provider = new GramReleaseProvider(feedOptions(feed, "prerelease"), {} as never, runtime);
    const info = await provider.getLatestVersion();
    expect(() => provider.resolveFiles({ ...info, version: "0.1.0-rc.19" })).toThrow();
    expect(() =>
      provider.resolveFiles({ ...info, files: [{ ...info.files[0]!, url: "elsewhere.zip" }] }),
    ).toThrow();
  });
});

describe("verifyAgainstGitHub", () => {
  it("accepts the bytes GitHub's digest names and refuses others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-native-feed-"));
    const file = join(dir, "update.zip");
    writeFileSync(file, zipBytes);
    const asset = release.assets[0]!;
    await expect(verifyAgainstGitHub(file, asset)).resolves.toBeUndefined();
    writeFileSync(file, Buffer.concat([zipBytes, Buffer.from("x")]));
    await expect(verifyAgainstGitHub(file, asset)).rejects.toThrow(/doesn't match GitHub/);
  });
});
