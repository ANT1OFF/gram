import { describe, expect, it } from "@effect/vitest";
import { prCheckoutRequest } from "./pr-checkout.ts";

describe("prCheckoutRequest", () => {
  it("checks a fork's head out as someone else's code", () => {
    expect(prCheckoutRequest({ fork: true }, "pr-7-x")).toEqual({
      kind: "newWorktree",
      branch: "pr-7-x",
      untrusted: true,
    });
  });

  it("checks a same-repository head out as the user's own", () => {
    expect(prCheckoutRequest({ fork: false }, "feat/x")).toEqual({
      kind: "newWorktree",
      branch: "feat/x",
    });
  });
});
