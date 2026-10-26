import { describe, expect, it } from "vitest";

import {
  configFromDraft,
  configFromJson,
  EMPTY_DRAFT,
  parsePairs,
  placementHints,
  targetProblem,
} from "./mcp-config";

describe("configFromDraft", () => {
  it("builds a stdio server with one argument per line and env pairs", () => {
    expect(
      configFromDraft({
        ...EMPTY_DRAFT,
        transport: "stdio",
        name: "fs",
        command: "npx",
        args: "-y\n@modelcontextprotocol/server-filesystem\n/My Docs\n",
        env: "TOKEN=abc=def\n\nDEBUG=1",
      }),
    ).toEqual({
      name: "fs",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/My Docs"],
        env: { TOKEN: "abc=def", DEBUG: "1" },
      },
    });
  });

  it("builds http and sse servers with headers, and names the first problem", () => {
    expect(
      configFromDraft({
        ...EMPTY_DRAFT,
        transport: "sse",
        name: "linear",
        url: "https://mcp.linear.app/sse",
        headers: "Authorization: Bearer x:y",
      }),
    ).toEqual({
      name: "linear",
      config: {
        type: "sse",
        url: "https://mcp.linear.app/sse",
        headers: { Authorization: "Bearer x:y" },
      },
    });
    expect(configFromDraft({ ...EMPTY_DRAFT, name: "my server" })).toEqual({
      error: "Name the server with letters, digits, dashes or underscores.",
    });
    expect(configFromDraft({ ...EMPTY_DRAFT, name: "x", url: "ftp://nope" })).toEqual({
      error: "Enter the server's http(s) URL.",
    });
    expect(parsePairs("no separator", "=")).toEqual({
      error: "Expected KEY=value, one per line: no separator",
    });
  });
});

describe("configFromJson", () => {
  it("reads a single entry named by the form, or one .mcp.json server", () => {
    expect(configFromJson('{"type":"http","url":"https://mcp.sentry.dev/mcp"}', "sentry")).toEqual({
      name: "sentry",
      config: { type: "http", url: "https://mcp.sentry.dev/mcp" },
    });
    expect(
      configFromJson(
        '{"mcpServers":{"fs":{"command":"npx","args":["-y","fs"],"env":{"TOKEN":"t"}}}}',
        "",
      ),
    ).toEqual({
      name: "fs",
      config: { type: "stdio", command: "npx", args: ["-y", "fs"], env: { TOKEN: "t" } },
    });
  });

  it("explains bad JSON, several servers and unknown types", () => {
    expect(configFromJson("{", "x")).toEqual({ error: "That isn't valid JSON." });
    expect(configFromJson('{"mcpServers":{"a":{},"b":{}}}', "")).toEqual({
      error: "Paste one server at a time.",
    });
    expect(configFromJson('{"type":"ws","url":"wss://x"}', "x")).toEqual({
      error: "`type` must be stdio, http or sse.",
    });
  });
});

describe("placing one server with several agents", () => {
  it("says where each agent keeps it, at the nearest scope that agent has", () => {
    expect(placementHints(["claude", "codex"], "local")).toEqual([
      "Claude Code: only you, in this project.",
      "Codex: its config.toml, for you in every project (Codex has no narrower scope).",
    ]);
    expect(placementHints(["claude"], "project")).toEqual([
      "Claude Code: everyone in the repo, via .mcp.json you can commit.",
    ]);
  });

  it("stops an add no chosen agent could run", () => {
    expect(targetProblem([], "http")).toBe("Pick at least one agent to add the server to.");
    expect(targetProblem(["claude", "codex"], "sse")).toContain("streamable HTTP only");
    expect(targetProblem(["claude"], "sse")).toBeUndefined();
    expect(targetProblem(["codex"], "stdio")).toBeUndefined();
  });
});
