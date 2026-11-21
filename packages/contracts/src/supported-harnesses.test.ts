import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AgentKind, ModelRef } from "./domain.ts";
import { SettingsPatch } from "./settings.ts";
import { RuntimeAgent } from "./agent-runtime.ts";
import { McpTarget } from "./connectors-config.ts";

describe("agent harness admission", () => {
  for (const agent of ["claude", "codex"] as const) {
    it(`${agent} keeps its explicit local and gateway model/effort/speed choices`, () => {
      for (const profile of [{}, { profileId: "saved-gateway" }]) {
        const model = {
          agent,
          model: "invented-supported-model",
          variant: "high",
          speed: "standard",
          ...profile,
        };
        expect(Schema.decodeUnknownSync(ModelRef)(model)).toEqual(model);
        expect(
          Schema.decodeUnknownSync(SettingsPatch)({ agents: { defaultModel: model } }),
        ).toEqual({ agents: { defaultModel: model } });
      }
    });
  }
  it("runs Grok Build on its own sign-in, with no managed runtime and no MCP config of Gram's", () => {
    expect(Schema.decodeUnknownSync(AgentKind)("grok")).toBe("grok");
    expect(Schema.decodeUnknownSync(ModelRef)({ agent: "grok", model: "m" })).toEqual({
      agent: "grok",
      model: "m",
    });
    expect(() => Schema.decodeUnknownSync(RuntimeAgent)("grok")).toThrow();
    expect(() => Schema.decodeUnknownSync(McpTarget)("grok")).toThrow();
  });
  it("runs Antigravity on its own sign-in, with no managed runtime and no MCP config of Gram's", () => {
    expect(Schema.decodeUnknownSync(AgentKind)("antigravity")).toBe("antigravity");
    expect(Schema.decodeUnknownSync(ModelRef)({ agent: "antigravity", model: "m" })).toEqual({
      agent: "antigravity",
      model: "m",
    });
    expect(() => Schema.decodeUnknownSync(RuntimeAgent)("antigravity")).toThrow();
    expect(() => Schema.decodeUnknownSync(McpTarget)("antigravity")).toThrow();
  });
  it("malformed and unknown harness values fail closed", () => {
    for (const value of ["unknown-agent", "", null, {}, 42])
      expect(() => Schema.decodeUnknownSync(AgentKind)(value)).toThrow();
  });
});
