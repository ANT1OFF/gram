import type { McpServerConfig } from "@gram/contracts";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  claudeConfiguredServers,
  claudeEverConnected,
  claudeUserConfigPath,
  readClaudeEverConnected,
} from "./claude/mcp-config-file.ts";
import {
  claudeServerEntry,
  codexServerEntry,
  describeClaudeEntry,
  describeCodexEntry,
  nativeServerEntry,
} from "./mcp-native.ts";

const http: McpServerConfig = {
  type: "http",
  url: "https://organization.example.invalid/example",
  headers: { "X-Api-Key": "abcd" },
};
const stdio: McpServerConfig = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@mcp/fs", "/some dir"],
  env: { ROOT: "/tmp" },
};

/** Existence checks for `claudeUserConfigPath`: nothing there, or only a `.config.json`. */
const none = (): boolean => false;
const configJsonOnly = (path: string): boolean => basename(path) === ".config.json";

describe("one MCP server config, in each agent's own shape", () => {
  it("writes a remote server with the agent's OAuth discovery left on", () => {
    expect(claudeServerEntry(http)).toEqual({
      type: "http",
      url: "https://organization.example.invalid/example",
      headers: { "X-Api-Key": "abcd" },
    });
    expect(codexServerEntry(http)).toEqual({
      entry: {
        url: "https://organization.example.invalid/example",
        http_headers: { "X-Api-Key": "abcd" },
      },
    });
  });

  it("leaves out empty header, env and argument lists", () => {
    const bare: McpServerConfig = { type: "http", url: "https://x.example/mcp", headers: {} };
    expect(claudeServerEntry(bare)).toEqual({ type: "http", url: "https://x.example/mcp" });
    expect(codexServerEntry(bare)).toEqual({ entry: { url: "https://x.example/mcp" } });
    expect(codexServerEntry({ type: "stdio", command: "run", args: [] })).toEqual({
      entry: { command: "run" },
    });
  });

  it("keeps a command's arguments whole in every shape", () => {
    expect(claudeServerEntry(stdio)).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@mcp/fs", "/some dir"],
      env: { ROOT: "/tmp" },
    });
    expect(nativeServerEntry("codex", stdio)).toEqual({
      entry: { command: "npx", args: ["-y", "@mcp/fs", "/some dir"], env: { ROOT: "/tmp" } },
    });
  });

  it("refuses an SSE server for Codex, which has no SSE client", () => {
    const sse: McpServerConfig = { type: "sse", url: "https://x.example/sse" };
    expect(nativeServerEntry("codex", sse)).toEqual({
      unsupported: "Codex connects over streamable HTTP only, not SSE.",
    });
    expect(nativeServerEntry("claude", sse)).toEqual({
      entry: { type: "sse", url: "https://x.example/sse" },
    });
    expect(describeClaudeEntry({ type: "ws", url: "wss://x.example" })).toMatchObject({
      transport: "other",
    });
    expect(
      describeCodexEntry({
        url: "https://x.example/mcp",
        bearer_token_env_var: "X_TOKEN",
        enabled: false,
      }),
    ).toEqual({
      transport: "http",
      url: "https://x.example/mcp",
      carriesValues: true,
      disabled: true,
    });
    expect(
      describeCodexEntry({ url: "https://x.example/mcp", bearer_token_env_var: null }),
    ).toMatchObject({
      carriesValues: false,
    });
    for (const junk of [undefined, "x", {}, { type: "local", command: [] }]) {
      expect(describeCodexEntry(junk)).toBeUndefined();
    }
  });

  it("reads Claude Code's three scopes from its files, the narrowest winning", () => {
    const userConfig = JSON.stringify({
      mcpServers: {
        parse: { type: "stdio", command: "parse", args: ["mcp"], env: { KEY: "sekrit-value" } },
        shared: { type: "http", url: "https://user.example/mcp" },
      },
      projects: {
        "/repo": { mcpServers: { shared: { type: "http", url: "https://local.example/mcp" } } },
        "/other": { mcpServers: { elsewhere: { command: "x" } } },
      },
    });
    const projectConfig = JSON.stringify({
      mcpServers: {
        team: {
          type: "sse",
          url: "https://team.example/sse",
          headers: { Authorization: "Bearer sekrit-value" },
        },
        shared: { type: "http", url: "https://project.example/mcp" },
      },
    });

    const inRepo = claudeConfiguredServers(userConfig, projectConfig, "/repo");
    expect(inRepo.map((s) => [s.name, s.scope, s.url ?? s.command])).toEqual([
      ["parse", "user", "parse"],
      ["shared", "local", "https://local.example/mcp"],
      ["team", "project", "https://team.example/sse"],
    ]);
    expect(JSON.stringify(inRepo)).not.toContain("sekrit");
    expect(claudeConfiguredServers(userConfig, undefined, undefined).map((s) => s.name)).toEqual([
      "parse",
      "shared",
    ]);
    // A file caught mid-rewrite, or none at all, is an empty list rather than an error.
    expect(claudeConfiguredServers('{"mcpServers": {', undefined, "/repo")).toEqual([]);
    expect(claudeConfiguredServers(undefined, undefined, undefined)).toEqual([]);
  });

  it("finds Claude Code's global config where it does: `.config.json`, config dir, home, OAuth variant", () => {
    expect(claudeUserConfigPath("/h", {}, none)).toBe(join("/h", ".claude.json"));
    expect(claudeUserConfigPath("/h", { CLAUDE_CONFIG_DIR: "/c" }, none)).toBe(
      join("/c", ".claude.json"),
    );
    // An empty CLAUDE_CONFIG_DIR is unset to Claude Code.
    expect(claudeUserConfigPath("/h", { CLAUDE_CONFIG_DIR: "" }, none)).toBe(
      join("/h", ".claude.json"),
    );
    expect(claudeUserConfigPath("/h", { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://x" }, none)).toBe(
      join("/h", ".claude-custom-oauth.json"),
    );
    expect(claudeUserConfigPath("/h", {}, configJsonOnly)).toBe(
      join("/h", ".claude", ".config.json"),
    );
    expect(claudeUserConfigPath("/h", { CLAUDE_CONFIG_DIR: "/c" }, configJsonOnly)).toBe(
      join("/c", ".config.json"),
    );
  });

  it("takes only the names of the claude.ai connectors Claude Code has connected", async () => {
    const config = JSON.stringify({
      oauthAccount: { emailAddress: "someone@organization.example.invalid" },
      claudeAiMcpEverConnected: ["claude.ai Atlassian", 7, "claude.ai Snowflake"],
      projects: { "/repo": { disabledMcpServers: ["claude.ai Teams"] } },
    });
    expect(claudeEverConnected(config)).toEqual(["claude.ai Atlassian", "claude.ai Snowflake"]);
    expect(claudeEverConnected('{"claudeAiMcpEverConnected": "claude.ai Atlassian"}')).toEqual([]);
    expect(claudeEverConnected('{"claudeAiMcpEverConnected": [')).toEqual([]);
    expect(claudeEverConnected(undefined)).toEqual([]);

    const dir = await mkdtemp(join(tmpdir(), "gram-claude-config-"));
    try {
      expect(await readClaudeEverConnected({ CLAUDE_CONFIG_DIR: dir })).toEqual([]);
      await writeFile(join(dir, ".claude.json"), config);
      expect(await readClaudeEverConnected({ CLAUDE_CONFIG_DIR: dir })).toEqual([
        "claude.ai Atlassian",
        "claude.ai Snowflake",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
