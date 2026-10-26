import { describe, expect, it } from "vitest";

import { UPDATE_REPO } from "./config.ts";
import { updateSource } from "./update-source.ts";

describe("updateSource", () => {
  it("names the repository and visibility each updater reads", () => {
    expect(updateSource("native")).toEqual({ repo: UPDATE_REPO, visibility: "public" });
    expect(updateSource("gh")).toEqual({ repo: UPDATE_REPO, visibility: "private" });
  });
});
