import { describe, expect, it } from "vitest";
import type { PostModelSwitchHookInput } from "@anthropic-ai/claude-agent-sdk";
import { toAgentModel, userModelSwitch } from "./models.ts";

describe("toAgentModel", () => {
  it("maps the default model with its supported efforts", () => {
    expect(
      toAgentModel({
        value: "default",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Default (recommended)",
        description: "Use the default model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      }),
    ).toEqual({
      id: "default",
      displayName: "Default (recommended)",
      description: "Use the default model",
      supportsEffort: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      isDefault: true,
      resolvedId: "claude-opus-5[1m]",
    });
  });

  it("keeps an account-only model's own label and the id an alias row runs", () => {
    expect(
      toAgentModel({
        value: "claude-mythos-5-1",
        resolvedModel: "claude-mythos-5-1",
        displayName: "Mythos",
        description: "Mythos 5.1 · Research preview",
      }),
    ).toEqual({
      id: "claude-mythos-5-1",
      displayName: "Mythos",
      description: "Mythos 5.1 · Research preview",
      supportsEffort: false,
    });
    expect(
      toAgentModel({
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus",
        description: "",
      }),
    ).toMatchObject({ id: "opus", resolvedId: "claude-opus-5-5" });
  });

  it("omits an empty description and efforts for models without effort support", () => {
    expect(
      toAgentModel({
        value: "haiku",
        displayName: "Haiku",
        description: "",
        supportedEffortLevels: ["low"],
      }),
    ).toEqual({ id: "haiku", displayName: "Haiku", supportsEffort: false });
  });
});

const switched = (over: Partial<PostModelSwitchHookInput>): PostModelSwitchHookInput => ({
  hook_event_name: "PostModelSwitch",
  session_id: "s1",
  transcript_path: "/tmp/s1.jsonl",
  cwd: "/work/repo",
  from_model: "claude-opus-5",
  to_model: "claude-preview",
  requested_model: "claude-preview[1m]",
  source: "command",
  context_tokens: 0,
  prompt_cache_warm: false,
  cache_ttl: "5m",
  estimated_cache_write_usd: 0,
  pricing: "default",
  ...over,
});

describe("userModelSwitch", () => {
  it("reports what a /model asked for, not the id it resolved to", () => {
    expect(userModelSwitch(switched({}))).toBe("claude-preview[1m]");
    expect(userModelSwitch(switched({ source: "picker", requested_model: "haiku" }))).toBe("haiku");
    expect(userModelSwitch(switched({ requested_model: null }))).toBe("default");
  });

  it("ignores our own setModel, fallbacks, resumes and subagents", () => {
    for (const source of ["sdk", "auto", "resume"] as const)
      expect(userModelSwitch(switched({ source }))).toBeUndefined();
    expect(userModelSwitch(switched({ agent_id: "agent-1" }))).toBeUndefined();
  });
});
