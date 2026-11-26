import { describe, expect, it } from "@effect/vitest";
import type { PlanStepId, ThreadPlan } from "@gram/contracts";
import { applyPrFacts, factOf, type PrFact } from "./pr-facts.ts";

const id = (s: string) => s as PlanStepId;

const plan: ThreadPlan = {
  goal: "Status lanes in the sidebar",
  goalBy: "agent",
  steps: [
    {
      id: id("s1"),
      text: "Lanes by status",
      status: "doing",
      source: "agent",
      pr: { number: 204 },
    },
    { id: id("s2"), text: "Hysteresis for lane moves", status: "todo", source: "agent" },
    { id: id("s3"), text: "Update FEATURES.md", status: "todo", source: "user", locked: true },
  ],
  basis: "",
  updatedAt: 1,
  updatedBy: "agent",
};

describe("PRs of the same number in two repos", () => {
  const two: { readonly prs: ReadonlyArray<PrFact> } = {
    prs: [
      { number: 42, repo: "acme/web", state: "merged" },
      { number: 42, repo: "acme/api", state: "open" },
    ],
  };
  const apiStep = {
    id: id("a"),
    text: "Ship the API half",
    status: "doing" as const,
    source: "agent" as const,
    pr: { number: 42, repo: "acme/api" },
  };

  it("matches a step's PR by its repo, and leaves a bare number shared by two unmatched", () => {
    expect(factOf({ number: 42, repo: "ACME/api" }, two.prs)?.state).toBe("open");
    const withApi = { ...plan, steps: [apiStep] };
    expect(applyPrFacts(withApi, two.prs)).toBe(withApi);
    expect(factOf({ number: 42 }, [two.prs[1]!, two.prs[0]!])?.repo).toBe("acme/api");
  });
});

describe("applyPrFacts", () => {
  it("finishes a merged PR's step, reopens it when the PR does, and leaves the rest alone", () => {
    const merged = applyPrFacts(plan, [{ number: 204, state: "merged" }]);
    expect(merged?.steps[0]).toMatchObject({ status: "done", evidence: "#204 merged" });
    const reopened = applyPrFacts(merged, [{ number: 204, state: "open" }]);
    expect(reopened?.steps[0]).toMatchObject({ status: "doing" });
    expect(reopened?.steps[0]?.evidence).toBeUndefined();
    expect(applyPrFacts(plan, [{ number: 204, state: "open" }])).toBe(plan);
  });
});
