import { CODEX_CLI_VERSION } from "@gram/agents/codex";
import { describe, expect, it } from "vitest";
import { CODEX_BASELINE } from "./codex-baseline.ts";
import {
  codexTarget,
  eligibleAfter,
  gate,
  latestAllowed,
  RELEASE_AGE_MS,
  satisfies,
  type RuntimeArtifact,
} from "./gate.ts";

const HOUR = 60 * 60 * 1000;
const published = Date.parse("2026-10-01T00:00:00Z");

const artifact = (overrides: Partial<RuntimeArtifact> = {}): RuntimeArtifact => ({
  agent: "codex",
  version: "0.160.0",
  target: "aarch64-apple-darwin",
  npm: {
    package: "@openai/codex",
    version: "0.160.0-darwin-arm64",
    integrity: `sha512-${"A".repeat(86)}==`,
  },
  sha256: "a".repeat(64),
  size: 1000,
  publishedAt: new Date(published).toISOString(),
  artifactUpdatedAt: new Date(published).toISOString(),
  qualifiedFor: ">=0.8.0 <0.9.0",
  source: "bundled",
  ...overrides,
});

const context = (now: number, appVersion = "0.8.0") => ({
  appVersion,
  target: "aarch64-apple-darwin",
  now,
});

describe("the compatibility gate", () => {
  it("holds every release back for 24 hours after its latest timestamp", () => {
    expect(gate(artifact(), context(published + 23 * HOUR))?.reason).toBe("too-new");
    expect(gate(artifact(), context(published + RELEASE_AGE_MS))).toBeUndefined();
    // A re-uploaded asset restarts the wait.
    const replaced = artifact({ artifactUpdatedAt: new Date(published + 10 * HOUR).toISOString() });
    expect(gate(replaced, context(published + 30 * HOUR))?.reason).toBe("too-new");
    expect(eligibleAfter(replaced)).toBe(published + 34 * HOUR);
  });

  it("refuses a release with no readable release time, and a clock before it", () => {
    expect(gate(artifact({ publishedAt: "soon" }), context(published + 48 * HOUR))?.reason).toBe(
      "no-release-time",
    );
    expect(gate(artifact(), context(published - HOUR))?.reason).toBe("too-new");
  });

  it("installs only what was qualified for this Gram version", () => {
    const now = published + 48 * HOUR;
    expect(gate(artifact(), context(now, "0.9.0"))?.reason).toBe("not-qualified");
    // Without a range, a bundled artifact is this build's own baseline.
    expect(gate(artifact({ qualifiedFor: undefined }), context(now, "0.9.0"))).toBeUndefined();
    // A range this build can't read qualifies nothing.
    expect(gate(artifact({ qualifiedFor: "^0.8.0" }), context(now))?.reason).toBe("not-qualified");
  });

  it("refuses another platform's package and incomplete entries", () => {
    const now = published + 48 * HOUR;
    expect(gate(artifact({ target: "x86_64-pc-windows-msvc" }), context(now))?.reason).toBe(
      "wrong-platform",
    );
    expect(gate(artifact({ sha256: "abc" }), context(now))?.reason).toBe("malformed");
    const npm = artifact().npm;
    expect(gate(artifact({ npm: { ...npm, integrity: "sha1-x" } }), context(now))?.reason).toBe(
      "malformed",
    );
    // Only Codex's own package, at the version for this platform, is ever fetched.
    for (const other of [
      { ...npm, package: "@evil/codex" },
      { ...npm, version: "0.160.0-darwin-x64" },
      { ...npm, version: "0.160.1-darwin-arm64" },
    ]) {
      expect(gate(artifact({ npm: other }), context(now))?.reason).toBe("malformed");
    }
    expect(gate(artifact({ size: 0 }), context(now))?.reason).toBe("malformed");
  });

  it("lets the bundled baseline through on this build and picks the newest allowed", () => {
    const baseline = CODEX_BASELINE.find((a) => a.target === "aarch64-apple-darwin")!;
    expect(baseline.version).toBe(CODEX_CLI_VERSION);
    // Past the baseline's release age.
    const now = Date.parse(baseline.publishedAt) + 2 * RELEASE_AGE_MS;
    expect(gate(baseline, context(now))).toBeUndefined();
    // Newer than the baseline, whatever version this build pins.
    const newer = {
      version: "0.999.0",
      npm: { ...artifact().npm, version: "0.999.0-darwin-arm64" },
    } as const;
    const fresh = artifact({ ...newer, publishedAt: new Date(now - HOUR).toISOString() });
    expect(latestAllowed([baseline, fresh], context(now))).toBe(baseline);
    const aged = artifact({
      ...newer,
      publishedAt: new Date(now - 30 * HOUR).toISOString(),
      artifactUpdatedAt: new Date(now - 30 * HOUR).toISOString(),
    });
    expect(latestAllowed([baseline, aged], context(now))).toBe(aged);
  });

  it("reads simple semver ranges", () => {
    expect(satisfies("0.8.3", ">=0.8.0 <0.9.0")).toBe(true);
    expect(satisfies("0.9.0", ">=0.8.0 <0.9.0")).toBe(false);
    expect(satisfies("0.8.0", "0.8.0")).toBe(true);
    expect(satisfies("0.8.0-rc.1", ">=0.8.0")).toBe(false);
    expect(satisfies("0.8.0", "")).toBe(false);
  });

  it("maps machines to Codex's target triples", () => {
    expect(codexTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(codexTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(codexTarget("linux", "x64")).toBeUndefined();
    expect(codexTarget("darwin", "ia32")).toBeUndefined();
  });
});
