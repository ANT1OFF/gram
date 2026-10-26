import { describe, expect, it } from "vitest";

import {
  nativeChannelName,
  nativeManifestName,
  nativeZipName,
  pickNativeRelease,
  renderNativeManifest,
  validateNativeManifest,
} from "./native-release.ts";

const sha512 = `${"A".repeat(86)}==`;
const manifestInput = {
  version: "0.1.0-rc.18",
  zip: "gram_0.1.0-rc.18_darwin-arm64_signed.zip",
  sha512,
  size: 150_000_000,
  releaseDate: "2026-10-16T10:00:00.000Z",
};
const parsed = {
  version: "0.1.0-rc.18",
  files: [{ url: manifestInput.zip, sha512, size: manifestInput.size }],
  path: manifestInput.zip,
  sha512,
  releaseDate: manifestInput.releaseDate,
};

const digest = `sha256:${"a".repeat(64)}`;
const release = (version: string, extra: Record<string, unknown> = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: version.includes("-"),
  body: ` Notes for ${version} `,
  published_at: "2026-10-16T10:00:00Z",
  assets: [
    { id: 11, name: nativeZipName(version), size: 150_000_000, digest, state: "uploaded" },
    { id: 12, name: nativeManifestName(version), size: 400, digest, state: "uploaded" },
    { id: 13, name: "SHA256SUMS.txt", size: 452, digest, state: "uploaded" },
  ],
  ...extra,
});

describe("native manifest names", () => {
  it("names electron-updater's channel files and the signed ZIP", () => {
    expect(nativeManifestName("0.1.0-rc.18")).toBe("rc-mac.yml");
    expect(nativeManifestName("0.1.0")).toBe("latest-mac.yml");
    expect(nativeChannelName("prerelease")).toBe("rc");
    expect(nativeChannelName("stable")).toBe("latest");
    expect(nativeZipName("0.1.0")).toBe("gram_0.1.0_darwin-arm64_signed.zip");
    expect(() => nativeManifestName("latest")).toThrow();
  });
});

describe("renderNativeManifest", () => {
  it("writes electron-builder's mac manifest shape", () => {
    expect(renderNativeManifest(manifestInput)).toBe(
      [
        "version: 0.1.0-rc.18",
        "files:",
        "  - url: gram_0.1.0-rc.18_darwin-arm64_signed.zip",
        `    sha512: ${sha512}`,
        "    size: 150000000",
        "path: gram_0.1.0-rc.18_darwin-arm64_signed.zip",
        `sha512: ${sha512}`,
        "releaseDate: '2026-10-16T10:00:00.000Z'",
        "",
      ].join("\n"),
    );
  });

  it("refuses fields that would point at anything but the release's own signed ZIP", () => {
    for (const bad of [
      { zip: "gram_0.1.0-rc.18_darwin-arm64_unsigned.zip" },
      { zip: "../gram_0.1.0-rc.18_darwin-arm64_signed.zip" },
      { sha512: "abc" },
      { size: 0 },
      { size: 1.5 },
      { releaseDate: "yesterday" },
      { version: "next" },
    ]) {
      expect(() => renderNativeManifest({ ...manifestInput, ...bad })).toThrow();
    }
  });
});

describe("validateNativeManifest", () => {
  const expected = { version: "0.1.0-rc.18", size: 150_000_000 };

  it("accepts exactly the manifest the release tool writes", () => {
    expect(validateNativeManifest(parsed, expected)).toEqual(parsed);
  });

  it("refuses a manifest that points elsewhere, disagrees or says more", () => {
    const file = parsed.files[0]!;
    for (const bad of [
      null,
      [],
      { ...parsed, version: "0.1.0-rc.19" },
      { ...parsed, path: "other.zip" },
      { ...parsed, sha512: `${"B".repeat(86)}==` },
      { ...parsed, releaseDate: new Date("2026-10-16T10:00:00Z") },
      { ...parsed, files: [] },
      { ...parsed, files: [file, file] },
      { ...parsed, files: [{ ...file, url: "https://example.invalid/x.zip" }] },
      { ...parsed, files: [{ ...file, size: 1 }] },
      { ...parsed, files: [{ ...file, blockMapSize: 1 }] },
      { ...parsed, stagingPercentage: 10 },
      { ...parsed, minimumSystemVersion: "99.0" },
    ]) {
      expect(() => validateNativeManifest(bad, expected)).toThrow(/doesn't match/);
    }
  });
});

describe("pickNativeRelease", () => {
  it("picks the newest complete release of the channel that is newer", () => {
    const list = [release("0.1.0-rc.19"), release("0.1.0-rc.18"), release("0.1.0-rc.17")];
    expect(pickNativeRelease(list, "prerelease", "0.1.0-rc.17")).toEqual({
      tag: "v0.1.0-rc.19",
      version: "0.1.0-rc.19",
      zip: { id: 11, name: "gram_0.1.0-rc.19_darwin-arm64_signed.zip", size: 150_000_000, digest },
      manifest: { id: 12, name: "rc-mac.yml", size: 400, digest },
      notes: "Notes for 0.1.0-rc.19",
      publishedAt: "2026-10-16T10:00:00Z",
    });
  });

  it("passes over drafts and releases still missing their signed ZIP or manifest", () => {
    const list = [
      release("0.1.0-rc.21", { draft: true }),
      release("0.1.0-rc.20", { assets: release("0.1.0-rc.20").assets.slice(1) }),
      release("0.1.0-rc.19", { assets: [release("0.1.0-rc.19").assets[0]] }),
      release("0.1.0-rc.18", {
        assets: release("0.1.0-rc.18").assets.map((a) =>
          a.name === "rc-mac.yml" ? { ...a, state: "starter" } : a,
        ),
      }),
      release("0.1.0-rc.17"),
    ];
    expect(pickNativeRelease(list, "prerelease", "0.1.0-rc.16")?.tag).toBe("v0.1.0-rc.17");
  });

  it("never picks an unsigned release, a duplicate asset or a mislabelled channel", () => {
    const unsigned = release("0.1.0-rc.18", {
      assets: [
        { id: 1, name: "gram_0.1.0-rc.18_darwin-arm64_unsigned.zip", size: 9, digest },
        { id: 2, name: "rc-mac.yml", size: 9, digest },
      ],
    });
    const duplicate = release("0.1.0-rc.18", {
      assets: [...release("0.1.0-rc.18").assets, release("0.1.0-rc.18").assets[0]],
    });
    const mislabelled = release("0.1.0-rc.18", { prerelease: false });
    for (const list of [[unsigned], [duplicate], [mislabelled]])
      expect(pickNativeRelease(list, "prerelease", "0.1.0-rc.17")).toBeUndefined();
  });

  it("offers stable releases on both channels and RCs only on Pre-release", () => {
    const list = [release("0.2.0-rc.1"), release("0.1.0")];
    expect(pickNativeRelease(list, "stable", "0.1.0-rc.17")?.tag).toBe("v0.1.0");
    expect(pickNativeRelease(list, "prerelease", "0.1.0-rc.17")?.tag).toBe("v0.2.0-rc.1");
    expect(pickNativeRelease(list, "prerelease", "0.1.0")?.manifest.name).toBe("rc-mac.yml");
    expect(pickNativeRelease([release("0.1.0")], "prerelease", "0.1.0-rc.17")?.manifest.name).toBe(
      "latest-mac.yml",
    );
  });

  it("never offers the running version or an older one", () => {
    const list = [release("0.1.0-rc.17"), release("0.1.0-rc.16")];
    expect(pickNativeRelease(list, "prerelease", "0.1.0-rc.17")).toBeUndefined();
    expect(pickNativeRelease(list, "prerelease", "not a version")).toBeUndefined();
  });
});
