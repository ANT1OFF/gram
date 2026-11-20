import { describe, expect, it } from "vitest";

import { autoAvailable, gatedHomeIsOwned, gateHoldsInMode, policyFor } from "./session.ts";

describe("policyFor and the outward gate's helpers", () => {
  it("maps each mode to a policy, and only bypass changes under the gate", () => {
    const sandboxed = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const table = [
      ["bypassPermissions", { approvalPolicy: "never", sandbox: "danger-full-access" }],
      ["dontAsk", { approvalPolicy: "never", sandbox: "workspace-write" }],
      ["default", sandboxed],
      ["acceptEdits", sandboxed],
      ["auto", sandboxed],
      ["plan", sandboxed],
    ] as const;
    for (const [mode, policy] of table) {
      // A CLI with no automatic reviewer is given no reviewer ungated, as before it existed.
      expect(policyFor(mode)).toEqual(policy);
      expect(policyFor(mode, false)).toEqual(policy);
      expect(policyFor(mode, false, false)).toEqual(policy);
      // Gated, the user reviews whatever the CLI, and only bypass changes its policy.
      for (const autoReviewer of [false, true])
        expect(policyFor(mode, true, autoReviewer)).toEqual({
          ...(mode === "bypassPermissions"
            ? { approvalPolicy: "untrusted", sandbox: "danger-full-access" }
            : policy),
          approvalsReviewer: "user",
        });
      // Ungated on a CLI with the reviewer: Auto is its automatic reviewer, every other mode the user.
      expect(policyFor(mode, false, true)).toEqual({
        ...policy,
        approvalsReviewer: mode === "auto" ? "auto_review" : "user",
      });
      expect(gateHoldsInMode(mode)).toBe(mode !== "dontAsk");
    }
  });

  it("has Auto only ungated, on a CLI with the automatic reviewer", () => {
    expect(autoAvailable(false, true)).toBe(true);
    expect(autoAvailable(false, false)).toBe(false);
    for (const gate of [true, "all", "irreversible"] as const) {
      expect(autoAvailable(gate, true)).toBe(false);
      expect(autoAvailable(gate, false)).toBe(false);
    }
  });

  it("lets a gated session run only on Gram's home, with its rules available", () => {
    expect(gatedHomeIsOwned("owned", true)).toBe(true);
    expect(gatedHomeIsOwned("owned", false)).toBe(false);
    expect(gatedHomeIsOwned("gateway", true)).toBe(true);
    expect(gatedHomeIsOwned("gateway", false)).toBe(false);
    expect(gatedHomeIsOwned("user", true)).toBe(false);
  });
});
