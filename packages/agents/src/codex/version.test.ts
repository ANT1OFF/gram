import { describe, expect, it } from "vitest";
import {
  codexAutoReviewSupported,
  codexVersionWarning,
  compareCodexVersion,
  parseCodexCliVersion,
} from "./version.ts";

describe("Codex version policy", () => {
  it.each([
    "0.166.1",
    "0.167.0",
    "0.1000.0",
    "1.0.0",
    "0.166.1-alpha.2",
    "0.167.0-alpha.2",
    "1.0.0-alpha.2",
  ])("orders newer %s numerically and warns", (version) => {
    expect(compareCodexVersion(version)).toBe(1);
    expect(codexVersionWarning(version)).toContain("some features may misbehave");
  });
  it.each(["0.165.99", "0.99.999", "0.166.0-alpha.2", "0.165.0-alpha.2"])(
    "keeps older %s below the pin",
    (version) => {
      expect(compareCodexVersion(version)).toBe(-1);
    },
  );
  it.each([
    undefined,
    "unknown",
    "0.166",
    "00.167.0",
    "0.167.0-alpha.01",
    "0.167.0-",
    "9007199254740992.0.0",
  ])("refuses unreadable %s", (version) => {
    expect(compareCodexVersion(version)).toBeNaN();
  });
  it("ignores build metadata and preserves prerelease evidence from the probe", () => {
    expect(compareCodexVersion("0.166.0+synthetic.1")).toBe(0);
    expect(codexVersionWarning("0.166.0")).toBeUndefined();
    expect(parseCodexCliVersion("codex-cli 0.166.0-alpha.2\n")).toBe("0.166.0-alpha.2");
    expect(parseCodexCliVersion("codex-cli unknown")).toBeUndefined();
    expect(parseCodexCliVersion("codex-cli 0.166.0.1")).toBeUndefined();
    expect(parseCodexCliVersion("codex-cli 0.166.0-alpha.01")).toBeUndefined();
  });
});

describe("Codex's automatic approvals reviewer", () => {
  it.each(["0.166.0", "0.166.1", "0.167.0", "1.0.0", "0.167.0-alpha.1"])(
    "is used from %s on",
    (version) => expect(codexAutoReviewSupported(version)).toBe(true),
  );
  it.each([undefined, "unknown", "0.165.9", "0.162.1", "0.166.0-alpha.1"])(
    "is not used on %s",
    (version) => expect(codexAutoReviewSupported(version)).toBe(false),
  );
});
