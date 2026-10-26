import { describe, expect, it } from "vitest";

import { compareVersions, formatVersion, parseVersion, type Version } from "./semver.ts";

const v = (s: string): Version => {
  const parsed = parseVersion(s);
  if (!parsed) throw new Error(`bad fixture ${s}`);
  return parsed;
};

describe("parseVersion", () => {
  it("parses release, pre-release and build metadata", () => {
    expect(v("1.3.2")).toEqual({ major: 1, minor: 3, patch: 2, pre: [], build: "" });
    expect(v("1.3.2-rc.2")).toMatchObject({ pre: ["rc", 2] });
    expect(v("1.0.0-beta.1+exp.sha.5114f85")).toMatchObject({
      pre: ["beta", 1],
      build: "exp.sha.5114f85",
    });
  });

  it("rejects non-SemVer input", () => {
    for (const bad of ["", "v1.2.3", "1.2", "01.2.3", "1.2.3-01", "1.2.3-", "nightly", "1.2.3 "]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });

  it("round-trips through formatVersion", () => {
    for (const s of ["0.0.0", "1.4.0-rc.1", "2.0.0+build.7"]) expect(formatVersion(v(s))).toBe(s);
  });
});

describe("compareVersions", () => {
  it("follows SemVer precedence", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(v(ordered[i - 1]!), v(ordered[i]!)), ordered[i]).toBeLessThan(0);
      expect(compareVersions(v(ordered[i]!), v(ordered[i - 1]!)), ordered[i]).toBeGreaterThan(0);
    }
  });

  it("puts a release above its release candidates", () => {
    expect(compareVersions(v("1.3.2"), v("1.3.2-rc.2"))).toBeGreaterThan(0);
  });

  it("treats identical versions as equal and breaks build-metadata ties", () => {
    expect(compareVersions(v("1.2.3"), v("1.2.3"))).toBe(0);
    expect(compareVersions(v("1.2.3"), v("1.2.3+1"))).toBeLessThan(0);
  });
});
