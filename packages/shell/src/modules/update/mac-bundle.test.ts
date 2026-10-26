import { describe, expect, it } from "vitest";
import { validateMacBuildMethod, type MacBundlePolicy } from "./mac-bundle.ts";
const signed: MacBundlePolicy = {
  method: "signed-native-macos-v1",
  teamId: "FAKETEAM01",
  requirementSha256: "a".repeat(64),
};
const build = {
  schema: "gram.signed-build/v1",
  method: signed.method,
  teamId: signed.teamId,
  requirementSha256: signed.requirementSha256,
  bundleId: "io.github.ant1off.gram",
  repositoryPrivate: false,
  developerIdSigned: true,
  notarized: true,
  stapled: true,
  notarizationStatus: "accepted",
};
describe("mandatory Mac bundle schema policy", () => {
  it("keeps unsigned flags strict while signed requires separate metadata", () => {
    expect(() =>
      validateMacBuildMethod(
        { developerIdSigned: false, notarized: false, repositoryPrivate: true },
        { method: "unsigned-private-helper" },
      ),
    ).not.toThrow();
    expect(() => validateMacBuildMethod(build, { method: "unsigned-private-helper" })).toThrow(
      "unsigned",
    );
    expect(() => validateMacBuildMethod(build, signed)).not.toThrow();
    expect(() =>
      validateMacBuildMethod({ developerIdSigned: false, notarized: false }, signed),
    ).toThrow("signed");
  });
  it.each([
    "schema",
    "method",
    "teamId",
    "requirementSha256",
    "bundleId",
    "repositoryPrivate",
    "developerIdSigned",
    "notarized",
    "stapled",
    "notarizationStatus",
  ])("requires signed %s independently", (key) => {
    expect(() => validateMacBuildMethod({ ...build, [key]: undefined }, signed)).toThrow();
  });
  it("takes a signed release from a public or private repository, an unsigned one only private", () => {
    for (const repositoryPrivate of [false, true])
      expect(() => validateMacBuildMethod({ ...build, repositoryPrivate }, signed)).not.toThrow();
    expect(() =>
      validateMacBuildMethod(
        { developerIdSigned: false, notarized: false, repositoryPrivate: false },
        { method: "unsigned-private-helper" },
      ),
    ).toThrow("unsigned");
  });
});
