import { describe, expect, it } from "vitest";

import { environmentShown } from "./environment-field-model";

const list = {
  environments: [
    { id: "default", label: "Default" },
    { id: "env-node", label: "Node.js", detail: "Open internet · node 22, pnpm" },
  ],
  default: "default",
};

describe("the environment a workspace's field shows", () => {
  it("is its own pick while offered, else the default, and says when a pick has gone", () => {
    expect(environmentShown(list, undefined)).toEqual({
      picked: list.environments[0],
      gone: false,
    });
    expect(environmentShown(list, "env-node")).toEqual({
      picked: list.environments[1],
      gone: false,
    });
    // Deleted, or no longer this person's to use: it starts in the default, and the field says so.
    expect(environmentShown(list, "env-gone")).toEqual({
      picked: list.environments[0],
      gone: true,
    });
  });
});
