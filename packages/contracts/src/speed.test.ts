import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ModelRef } from "./domain.ts";
import { fastSelectionProblem, modelSpeeds, type AgentModel } from "./models.ts";
import { modelRefOf, WorkerModel } from "./workspaces.ts";

const models: readonly AgentModel[] = [
  {
    id: "opus",
    resolvedId: "fixture-opus",
    displayName: "Synthetic Opus",
    supportsEffort: false,
    speeds: ["standard", "fast"],
  },
];
describe("independent speed preferences", () => {
  it("round trips speed without changing model identity or reasoning effort", () => {
    const model = { agent: "codex", model: "fixture", variant: "high", speed: "fast" } as const;
    expect(Schema.decodeUnknownSync(ModelRef)(Schema.encodeSync(ModelRef)(model))).toEqual(model);
    const worker = Schema.decodeUnknownSync(WorkerModel)({
      ...model,
      default: true,
      useFor: "Synthetic implementation",
    });
    expect(modelRefOf(worker)).toEqual(model);
    expect(
      Schema.decodeUnknownSync(ModelRef)({ agent: "claude", model: "opus" }),
    ).not.toHaveProperty("speed");
  });
  it("requires explicit provider support, including alias resolutions", () => {
    expect(modelSpeeds(models, "fixture-opus[1m]")).toEqual(["standard", "fast"]);
    expect(
      fastSelectionProblem({ agent: "claude", model: "fixture-opus", speed: "fast" }, models),
    ).toBeUndefined();
    expect(
      fastSelectionProblem(
        { agent: "claude", model: "claude-opus-invented", speed: "fast" },
        models,
      ),
    ).toContain("not advertised");
    expect(
      fastSelectionProblem({ agent: "codex", model: "fixture", speed: "standard" }, []),
    ).toBeUndefined();
    expect(modelSpeeds(undefined, "gpt-invented")).toEqual([]);
  });
});
