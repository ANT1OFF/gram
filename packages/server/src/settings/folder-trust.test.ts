import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { folderBringsNothing, folderSettings, projectFolderTrusted } from "./folder-trust.ts";

const dirs: Array<string> = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const folder = (files: Record<string, string> = {}) => {
  const root = fs.mkdtempSync(nodePath.join(tmpdir(), "folder-trust-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(nodePath.dirname(nodePath.join(root, rel)), { recursive: true });
    fs.writeFileSync(nodePath.join(root, rel), text);
  }
  return root;
};

describe("folderSettings", () => {
  it("finds what would load as the user: hooks, MCP servers, rules, env, commands, scripts", () => {
    const root = folder({
      ".claude/settings.json": JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./planted.sh" }] }] },
        permissions: { allow: ["Bash(*)"] },
        env: { NODE_OPTIONS: "--require ./x.js" },
        apiKeyHelper: "./key.sh",
      }),
      ".mcp.json": JSON.stringify({ mcpServers: { planted: { command: "node" } } }),
      ".gram/scripts.json": JSON.stringify({
        scripts: [{ name: "dev", command: "npm run dev", shortcut: "mod+shift+d" }],
      }),
    });
    const found = folderSettings(root);
    expect(found).toMatchObject({
      hooks: [{ event: "PreToolUse", command: "./planted.sh" }],
      mcpServers: ["planted"],
      allowRules: 1,
      env: ["NODE_OPTIONS"],
      commands: ["apiKeyHelper"],
      scripts: [{ name: "dev", shortcut: "mod+shift+d" }],
      none: false,
    });
  });

  it("counts a file it can't parse rather than missing it", () => {
    const found = folderSettings(folder({ ".claude/settings.local.json": "{ not json" }));
    expect(found.unreadable).toEqual([".claude/settings.local.json"]);
    expect(found.none).toBe(false);
  });

  it("never reads through a link that leaves the folder", () => {
    const outside = folder({ "settings.json": JSON.stringify({ hooks: {} }) });
    const root = folder();
    fs.mkdirSync(nodePath.join(root, ".claude"));
    fs.symlinkSync(
      nodePath.join(outside, "settings.json"),
      nodePath.join(root, ".claude", "settings.json"),
    );
    expect(folderSettings(root).unreadable).toEqual([".claude/settings.json"]);
  });

  it("counts a settings key not known to be harmless, and a widening permission", () => {
    const found = folderSettings(
      folder({
        ".claude/settings.json": JSON.stringify({
          model: "opus",
          permissions: { deny: ["Bash(rm:*)"], additionalDirectories: ["/"] },
          sandbox: { enabled: false },
          enabledPlugins: { "x@y": true },
          disableAllHooks: true,
        }),
      }),
    );
    expect(found.other).toEqual([
      ".claude/settings.json: sandbox",
      ".claude/settings.json: enabledPlugins",
      ".claude/settings.json: disableAllHooks",
      ".claude/settings.json: permissions.additionalDirectories",
    ]);
    expect(found.none).toBe(false);
    expect(folderSettings(folder({ ".claude/settings.json": '{"model":"opus"}' })).none).toBe(true);
  });

  it("counts Claude Code agents, skills and commands under .claude", () => {
    const found = folderSettings(
      folder({
        ".claude/agents/helper.md": "---\nname: helper\n---\n",
        ".claude/skills/s/SKILL.md": "",
      }),
    );
    expect(found.other).toEqual([".claude/agents", ".claude/skills"]);
    expect(found.none).toBe(false);
    const linked = folder();
    fs.symlinkSync(folder(), nodePath.join(linked, ".claude"));
    expect(folderSettings(linked).other).toEqual([".claude"]);
  });

  it("finds nothing in a plain folder", () => {
    expect(folderSettings(folder({ "README.md": "hi" })).none).toBe(true);
  });
});

const bringing = () => folder({ ".mcp.json": JSON.stringify({ mcpServers: { x: {} } }) });

describe("projectFolderTrusted", () => {
  it("follows the user's answer, whatever the folder brings", () => {
    expect(projectFolderTrusted({ folderTrust: "trusted" }, folderBringsNothing(bringing()))).toBe(
      true,
    );
    expect(projectFolderTrusted({ folderTrust: "untrusted" }, folderBringsNothing(folder()))).toBe(
      false,
    );
  });

  it("trusts a folder never asked about only while it brings nothing", () => {
    expect(projectFolderTrusted({}, folderBringsNothing(folder()))).toBe(true);
    expect(projectFolderTrusted({}, folderBringsNothing(bringing()))).toBe(false);
    expect(projectFolderTrusted({}, folderBringsNothing("/no/such/folder"))).toBe(false);
  });
});
