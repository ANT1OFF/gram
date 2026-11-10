import { describe, expect, it } from "@effect/vitest";
import { type AgentKind, type Autonomy } from "@gram/contracts";
import { rolePrompt } from "./prompt.ts";

const prompt = (agent: AgentKind, autonomy: Autonomy) =>
  rolePrompt({
    workspaceName: "Shop",
    projects: [{ name: "shop", root: "/work/shop", home: true }],
    autonomy,
    agent,
    gated: true,
  });

describe("the orchestrator's prompt on recommended tiers", () => {
  for (const agent of ["claude", "codex"] as const) {
    for (const autonomy of ["supervised", "publish", "full"] as const) {
      it(`names the tiers, the effort ladder and cross-vendor review (${agent}, ${autonomy})`, () => {
        const text = prompt(agent, autonomy);
        expect(text).toContain(
          "A `tier:<tier>` entry follows Gram's recommendation (cheap, scoped, lead, top)",
        );
        // Check first, then one level up to high and never past it, then the next tier.
        expect(text).toContain("Brief each worker with a check it can run");
        expect(text).toContain("one `effort` level up, never past `high`, then the next tier");
        expect(text).toContain("Review on another harness than the author's, else another tier");
        // Nothing in it suggests an effort past the ceiling.
        expect(text).not.toMatch(/\b(xhigh|ultra)\b|effort[^.]*\bmax\b/);
      });
    }
  }
});
