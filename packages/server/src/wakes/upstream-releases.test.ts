import { describe, expect, it } from "vitest";
import { githubReleases, npmReleases, versionOfTag } from "./upstream-releases.ts";

describe("upstream releases", () => {
  it("reads npm's published versions with their times, prereleases marked", () => {
    const stdout = JSON.stringify({
      time: {
        created: "2025-01-01T00:00:00.000Z",
        modified: "2026-10-01T00:00:00.000Z",
        "0.166.0": "2026-10-01T10:00:00.000Z",
        "0.167.0-alpha.1": "2026-10-02T10:00:00.000Z",
        // Unpublished: in `time`, not in `versions`.
        "0.165.0": "2026-09-01T10:00:00.000Z",
      },
      versions: ["0.166.0", "0.167.0-alpha.1"],
    });
    expect(npmReleases("@openai/codex", stdout)).toEqual([
      {
        version: "0.166.0",
        publishedAt: Date.parse("2026-10-01T10:00:00.000Z"),
        url: "https://www.npmjs.com/package/@openai/codex/v/0.166.0",
        prerelease: false,
      },
      {
        version: "0.167.0-alpha.1",
        publishedAt: Date.parse("2026-10-02T10:00:00.000Z"),
        url: "https://www.npmjs.com/package/@openai/codex/v/0.167.0-alpha.1",
        prerelease: true,
      },
    ]);
    // One version is printed as a string.
    expect(
      npmReleases(
        "solo",
        JSON.stringify({ time: { "1.0.0": "2026-01-01T00:00:00Z" }, versions: "1.0.0" }),
      ),
    ).toHaveLength(1);
    expect(npmReleases("x", "not json")).toBeUndefined();
  });

  it("reads GitHub's releases without drafts or tags naming no version", () => {
    const stdout = JSON.stringify([
      {
        tag_name: "rust-v0.167.0",
        html_url: "https://github.com/openai/codex/releases/tag/rust-v0.167.0",
        published_at: "2026-10-03T00:00:00Z",
        prerelease: false,
        draft: false,
      },
      {
        tag_name: "v0.168.0",
        html_url: "https://github.com/openai/codex/releases/tag/v0.168.0",
        published_at: "2026-10-04T00:00:00Z",
        prerelease: true,
        draft: false,
      },
      { tag_name: "v0.169.0", html_url: "u", published_at: null, prerelease: false, draft: true },
      {
        tag_name: "nightly",
        html_url: "u",
        published_at: "2026-10-05T00:00:00Z",
        prerelease: false,
        draft: false,
      },
    ]);
    expect(githubReleases(stdout)).toEqual([
      {
        version: "0.167.0",
        publishedAt: Date.parse("2026-10-03T00:00:00Z"),
        url: "https://github.com/openai/codex/releases/tag/rust-v0.167.0",
        prerelease: false,
      },
      {
        version: "0.168.0",
        publishedAt: Date.parse("2026-10-04T00:00:00Z"),
        url: "https://github.com/openai/codex/releases/tag/v0.168.0",
        prerelease: true,
      },
    ]);
    expect(versionOfTag("v2.81.0-rc.1")).toBe("2.81.0-rc.1");
    expect(versionOfTag("nightly")).toBeUndefined();
  });
});
