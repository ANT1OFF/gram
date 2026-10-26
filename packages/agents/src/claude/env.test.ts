import { describe, expect, it } from "vitest";
import { buildChildEnv, isStrippedEnvVar, toolSearchOn, withPeerMessaging } from "./env.ts";

describe("buildChildEnv", () => {
  it("strips API-key auth and parent-session leakage, keeps the rest", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_API_KEY_FILE_DESCRIPTOR: "4",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_BASE_URL: "https://gw",
      ANTHROPIC_PROFILE: "p",
      ANTHROPIC_MODEL: "opus",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDECODE: "1",
      CLAUDE_PID: "42",
      CLAUDE_EFFORT: "high",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s",
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_EXECPATH: "/bin/claude",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
      CMUX_SURFACE_ID: "abc",
      CMUX_SOCKET: "/tmp/cmux",
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      ANTHROPIC_MODEL: "opus",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      CLAUDE_CODE_HARBOR_KITE: "0",
      CLAUDE_CODE_ARTIFACT: "1",
    });
  });

  it("keeps a user's own Artifact setting, whatever its spelling", () => {
    expect(buildChildEnv({ CLAUDE_CODE_ARTIFACT: "0" })["CLAUDE_CODE_ARTIFACT"]).toBe("0");
    const windows = buildChildEnv({ Claude_Code_Artifact: "0" });
    expect(windows["Claude_Code_Artifact"]).toBe("0");
    expect(windows["CLAUDE_CODE_ARTIFACT"]).toBeUndefined();
  });

  it("matches names case-insensitively, as Windows does", () => {
    expect(isStrippedEnvVar("anthropic_api_key")).toBe(true);
    expect(isStrippedEnvVar("Cmux_Surface_Id")).toBe(true);
    expect(isStrippedEnvVar("Path")).toBe(false);
  });

  it("overrides an inherited session-state setting", () => {
    expect(buildChildEnv({ CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "0" })).toEqual({
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      CLAUDE_CODE_HARBOR_KITE: "0",
      CLAUDE_CODE_ARTIFACT: "1",
    });
  });

  it("turns cross-session messaging off whatever the user's environment says", () => {
    // Peer messages would reach a Gram session past its routing and fence.
    expect(buildChildEnv({ CLAUDE_CODE_HARBOR_KITE: "1" })["CLAUDE_CODE_HARBOR_KITE"]).toBe("0");
    const windows = buildChildEnv({ Claude_Code_Harbor_Kite: "1" });
    expect(windows["Claude_Code_Harbor_Kite"]).toBeUndefined();
    expect(windows["CLAUDE_CODE_HARBOR_KITE"]).toBe("0");
  });

  it("puts messaging back to Claude Code's default only for a session allowed to send", () => {
    const env = buildChildEnv({ PATH: "/usr/bin" });
    expect(withPeerMessaging(env)).not.toHaveProperty("CLAUDE_CODE_HARBOR_KITE");
    expect(withPeerMessaging(env)["PATH"]).toBe("/usr/bin");
    expect(withPeerMessaging({ Claude_Code_Harbor_Kite: "0" })).toEqual({});
  });
});

describe("toolSearchOn", () => {
  it("is on for Anthropic's API and off behind another base URL, as Claude Code decides", () => {
    expect(toolSearchOn({})).toBe(true);
    expect(toolSearchOn({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(true);
    expect(toolSearchOn({ ANTHROPIC_BASE_URL: "http://litellm:4000" })).toBe(false);
    expect(toolSearchOn({ ANTHROPIC_BASE_URL: "not a url" })).toBe(false);
    expect(toolSearchOn({ ANTHROPIC_BASE_URL: " " })).toBe(true);
  });

  it("follows ENABLE_TOOL_SEARCH, under CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", () => {
    const gateway = { ANTHROPIC_BASE_URL: "http://litellm:4000" };
    for (const value of ["false", "FALSE", "0", "no", "off", "auto:100", "auto:150"]) {
      expect(toolSearchOn({ ENABLE_TOOL_SEARCH: value })).toBe(false);
    }
    for (const value of ["true", "1", "auto", "auto:5", "auto:0", "auto:x", "whatever"]) {
      expect(toolSearchOn({ ...gateway, ENABLE_TOOL_SEARCH: value })).toBe(true);
    }
    expect(toolSearchOn({ ...gateway, ENABLE_TOOL_SEARCH: "" })).toBe(false);
    for (const value of ["1", "true"]) {
      expect(
        toolSearchOn({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: value, ENABLE_TOOL_SEARCH: "true" }),
      ).toBe(false);
    }
    expect(toolSearchOn({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "0" })).toBe(true);
    // Windows reads env names in any case; elsewhere a lowercase name is another variable.
    expect(toolSearchOn({ enable_tool_search: "false" }, "win32")).toBe(false);
    expect(toolSearchOn({ Anthropic_Base_Url: "http://litellm:4000" }, "win32")).toBe(false);
    expect(toolSearchOn({ enable_tool_search: "false" }, "darwin")).toBe(true);
  });
});
