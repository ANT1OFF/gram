import { describe, expect, it } from "@effect/vitest";
import { prCheckoutRequest } from "./pr-checkout.ts";

const origin = "acme/app";

describe("prCheckoutRequest", () => {
  it("checks a fork's head out as someone else's code", () => {
    expect(prCheckoutRequest({ fork: true, repo: origin }, "pr-7-x", origin)).toEqual({
      kind: "newWorktree",
      branch: "pr-7-x",
      untrusted: true,
    });
  });

  it("checks a branch of the project's own repository out as the user's own", () => {
    expect(
      prCheckoutRequest({ fork: false, repo: "Acme/App", headRepo: "acme/app" }, "feat/x", origin),
    ).toEqual({ kind: "newWorktree", branch: "feat/x" });
  });

  it("checks a same-repository PR of another repository out as someone else's code", () => {
    expect(
      prCheckoutRequest({ fork: false, repo: "mallory/app", headRepo: "mallory/app" }, "x", origin),
    ).toEqual({ kind: "newWorktree", branch: "x", untrusted: true });
  });

  it("checks a head out as someone else's code when the project has no origin to compare", () => {
    expect(prCheckoutRequest({ fork: false, repo: origin }, "x", undefined)).toEqual({
      kind: "newWorktree",
      branch: "x",
      untrusted: true,
    });
  });
});
