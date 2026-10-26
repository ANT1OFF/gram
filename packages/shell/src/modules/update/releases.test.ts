import { describe, expect, it } from "vitest";

import { eligibleReleases, releaseList, selectRelease, validTag } from "./releases.ts";
import { parseVersion, type Version } from "./semver.ts";

const ver = (s: string): Version => parseVersion(s)!;
const rel = (tagName: string, isPrerelease = false, isDraft = false) => ({
  tagName,
  isPrerelease,
  isDraft,
});

const select = (releases: unknown[], current: string, beta: boolean) =>
  selectRelease(eligibleReleases(releases, beta), ver(current))?.tag;
const list = (releases: unknown[], current: string, beta: boolean) =>
  releaseList(eligibleReleases(releases, beta), ver(current));

describe("selectRelease", () => {
  it("never offers a pre-release on the stable channel", () => {
    const releases = [rel("v1.4.0-rc.1", true), rel("v1.3.1")];
    expect(select(releases, "1.3.1", false)).toBeUndefined();
    expect(select(releases, "1.3.1", true)).toBe("v1.4.0-rc.1");
  });

  it("moves a beta user to a newer pre-release, then onto the matching release", () => {
    expect(
      select(
        [rel("v1.3.2-rc.2", true), rel("v1.3.2-rc.1", true), rel("v1.3.1")],
        "1.3.2-rc.1",
        true,
      ),
    ).toBe("v1.3.2-rc.2");
    expect(select([rel("v1.3.2"), rel("v1.3.2-rc.2", true)], "1.3.2-rc.2", true)).toBe("v1.3.2");
  });

  it("decides the channel from the tag, whatever the release's pre-release flag says", () => {
    expect(select([rel("v1.4.0-rc.3", false), rel("v1.3.1")], "1.3.1", false)).toBeUndefined();
    expect(select([rel("v1.4.0", true), rel("v1.3.1")], "1.3.1", false)).toBe("v1.4.0");
  });

  it("offers nothing when current is the latest or newer", () => {
    expect(select([rel("v1.3.1")], "1.3.1", false)).toBeUndefined();
    expect(select([rel("v1.3.1")], "1.4.0", false)).toBeUndefined();
    expect(select([], "1.0.0", true)).toBeUndefined();
  });

  it("skips drafts, non-SemVer tags and tags install would refuse", () => {
    expect(
      select([rel("v9.9.9", false, true), rel("nightly"), rel("v1.3.2")], "1.3.1", false),
    ).toBe("v1.3.2");
    expect(select([rel("1.9.9"), rel("v1.3.2")], "1.3.1", false)).toBe("v1.3.2");
  });

  it("picks the highest of several releases regardless of list order", () => {
    expect(select([rel("v1.4.0"), rel("v1.5.2"), rel("v1.5.0")], "1.4.0", false)).toBe("v1.5.2");
  });

  it("ignores malformed entries", () => {
    expect(
      select([null, 42, { tagName: 7 }, { isDraft: false }, rel("v1.0.1")], "1.0.0", false),
    ).toBe("v1.0.1");
  });
});

describe("releaseList", () => {
  it("sorts newest first and marks each relation", () => {
    const rows = list([rel("v1.3.0"), rel("v1.5.0"), rel("v1.4.0")], "1.4.0", false);
    expect(rows.map((r) => [r.version, r.relation])).toEqual([
      ["1.5.0", "newer"],
      ["1.4.0", "current"],
      ["1.3.0", "older"],
    ]);
    expect(rows[0]).toMatchObject({ tag: "v1.5.0", prerelease: false });
  });

  it("honours the channel and skips drafts and junk", () => {
    const releases = [
      rel("v1.5.0-rc.1", true),
      rel("v9.9.9", false, true),
      rel("nightly"),
      rel("v1.4.0"),
    ];
    expect(list(releases, "1.4.0", false).map((r) => r.tag)).toEqual(["v1.4.0"]);
    const beta = list(releases, "1.4.0", true);
    expect(beta.map((r) => r.tag)).toEqual(["v1.5.0-rc.1", "v1.4.0"]);
    expect(beta[0]).toMatchObject({ prerelease: true, relation: "newer" });
  });

  it("marks a row pre-release by its tag, not the flag", () => {
    const rows = list([rel("v1.5.0-rc.1", false), rel("v1.4.0", true)], "1.4.0", true);
    expect(rows.map((r) => [r.tag, r.prerelease])).toEqual([
      ["v1.5.0-rc.1", true],
      ["v1.4.0", false],
    ]);
    expect(list([rel("v1.5.0-rc.1", false), rel("v1.4.0", true)], "1.4.0", false)).toEqual([
      { tag: "v1.4.0", version: "1.4.0", prerelease: false, relation: "current" },
    ]);
  });

  it("marks everything older on a build ahead of every release", () => {
    expect(
      list([rel("v1.4.0"), rel("v1.3.0")], "2.0.0", false).every((r) => r.relation === "older"),
    ).toBe(true);
  });
});

describe("validTag", () => {
  it("accepts real version tags", () => {
    for (const tag of ["v1.4.1", "v1.4.1-rc.2", "v10.20.30-beta.1_build"])
      expect(validTag(tag), tag).toBe(true);
  });

  it("rejects injection and malformed tags", () => {
    for (const tag of [
      "",
      "1.4.1",
      "v1.4.1; rm -rf /",
      "v1.4.1 --repo evil/x",
      "v../../etc/passwd",
      "v1.4.1\n",
    ]) {
      expect(validTag(tag), JSON.stringify(tag)).toBe(false);
    }
    expect(validTag(`v${"9".repeat(80)}`)).toBe(false);
  });
});
