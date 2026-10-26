import { expect, it } from "vitest";
import { appBuildEnv } from "./build-info.ts";

it("tells the server which build runs: a packaged build's commit, or dev from source", () => {
  const sourceCommit = "a".repeat(40);
  expect(appBuildEnv({ version: "0.4.0", packaged: true, sourceCommit })).toEqual({
    GRAM_APP_BUILD: sourceCommit,
  });
  // Packaged without provenance: no build is claimed.
  expect(appBuildEnv({ version: "0.4.0", packaged: true })).toEqual({});
  expect(appBuildEnv({ version: "0.4.0", packaged: false })).toEqual({ GRAM_APP_BUILD: "dev" });
});
